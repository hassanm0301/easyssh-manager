import { EasySshError } from '../common/errors';
import type { ConnectionId } from '../connections/types';
import type { CancellationTokenLike } from '../ssh/ports';
import type {
  RemoteDirectoryEntry,
  RemoteStat,
  RemoteWriteOptions,
  SftpClient,
  SftpClientFactory,
  SftpConnectionPool,
  SftpLease,
} from './ports';

interface PoolConfiguration {
  getSnapshot(): Readonly<{ sftpIdleTimeoutMs: number }>;
  readonly onDidChange: (
    listener: (configuration: Readonly<{ sftpIdleTimeoutMs: number }>) => unknown,
  ) => { dispose(): void };
}

interface PoolEntry {
  readonly connectionId: ConnectionId;
  readonly generation: number;
  readonly cancellation: PoolCancellationTokenSource;
  client?: SftpClient;
  connecting?: Promise<SftpClient>;
  closing?: Promise<void>;
  references: number;
  waiters: number;
  invalidated: boolean;
  idleSince?: number;
  idleTimer?: NodeJS.Timeout;
}

export class DefaultSftpConnectionPool implements SftpConnectionPool {
  private readonly entries = new Map<ConnectionId, PoolEntry>();
  private readonly configurationSubscription: { dispose(): void };
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly factory: SftpClientFactory,
    private readonly configuration: PoolConfiguration,
    private readonly clock: () => number = Date.now,
  ) {
    this.configurationSubscription = configuration.onDidChange(() => this.rescheduleIdleEntries());
  }

  async acquire(
    connectionId: ConnectionId,
    cancellation?: CancellationTokenLike,
  ): Promise<SftpLease> {
    this.assertActive();
    if (cancellation?.isCancellationRequested) throw cancelled();
    const entry = this.entry(connectionId);
    entry.waiters += 1;
    this.clearIdle(entry);
    try {
      const client = await withCancellation(this.connect(entry), cancellation);
      if (this.disposed || entry.invalidated || this.entries.get(connectionId) !== entry) {
        throw new EasySshError('CONNECTION_LOST', 'The pooled SFTP connection was invalidated.');
      }
      entry.references += 1;
      return new DefaultSftpLease(this, entry, client);
    } finally {
      entry.waiters -= 1;
      this.scheduleIdle(entry);
    }
  }

  async invalidate(connectionId: ConnectionId, reason: string): Promise<void> {
    const entry = this.entries.get(connectionId);
    if (!entry) return;
    await this.invalidateEntry(entry);
    void reason;
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.configurationSubscription.dispose();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => this.closeEntry(entry)));
  }

  async dispose(): Promise<void> {
    await this.disposeAll();
  }

  touch(entry: PoolEntry): void {
    if (entry.invalidated || this.entries.get(entry.connectionId) !== entry) return;
    if (entry.references === 0) {
      entry.idleSince = this.clock();
      this.scheduleIdle(entry);
    }
  }

  async release(entry: PoolEntry): Promise<void> {
    if (entry.references > 0) entry.references -= 1;
    if (entry.references === 0) {
      entry.idleSince = this.clock();
      this.scheduleIdle(entry);
    }
  }

  async run<T>(entry: PoolEntry, operation: () => Promise<T>): Promise<T> {
    if (entry.invalidated || this.entries.get(entry.connectionId) !== entry) {
      throw new EasySshError('CONNECTION_LOST', 'The pooled SFTP connection is no longer active.');
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof EasySshError && error.code === 'CONNECTION_LOST') {
        await this.invalidateEntry(entry);
      }
      throw error;
    }
  }

  async closeLeaseClient(entry: PoolEntry): Promise<void> {
    await this.invalidateEntry(entry);
  }

  private entry(connectionId: ConnectionId): PoolEntry {
    const existing = this.entries.get(connectionId);
    if (existing && !existing.invalidated) return existing;
    const created: PoolEntry = {
      connectionId,
      generation: ++this.generation,
      cancellation: new PoolCancellationTokenSource(),
      references: 0,
      waiters: 0,
      invalidated: false,
    };
    this.entries.set(connectionId, created);
    return created;
  }

  private connect(entry: PoolEntry): Promise<SftpClient> {
    if (entry.client) return Promise.resolve(entry.client);
    if (entry.connecting) return entry.connecting;
    const connecting = this.factory
      .open(entry.connectionId, entry.cancellation.token)
      .then(async (client) => {
        if (
          this.disposed ||
          entry.invalidated ||
          this.entries.get(entry.connectionId)?.generation !== entry.generation
        ) {
          await client.close().catch(() => undefined);
          throw new EasySshError('CONNECTION_LOST', 'The pooled SFTP connection was invalidated.');
        }
        entry.client = client;
        this.scheduleIdle(entry);
        return client;
      })
      .catch((error: unknown) => {
        if (this.entries.get(entry.connectionId) === entry) this.entries.delete(entry.connectionId);
        throw error;
      })
      .finally(() => {
        if (entry.connecting === connecting) delete entry.connecting;
      });
    entry.connecting = connecting;
    return connecting;
  }

  private async invalidateEntry(entry: PoolEntry): Promise<void> {
    if (this.entries.get(entry.connectionId) === entry) this.entries.delete(entry.connectionId);
    await this.closeEntry(entry);
  }

  private closeEntry(entry: PoolEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.invalidated = true;
    this.clearIdle(entry);
    entry.cancellation.cancel();
    const client = entry.client;
    delete entry.client;
    const connecting = entry.connecting;
    entry.closing = (async () => {
      if (client) await client.close().catch(() => undefined);
      if (connecting) await connecting.catch(() => undefined);
    })();
    return entry.closing;
  }

  private scheduleIdle(entry: PoolEntry): void {
    if (
      this.disposed ||
      entry.invalidated ||
      !entry.client ||
      entry.references !== 0 ||
      entry.waiters !== 0 ||
      this.entries.get(entry.connectionId) !== entry
    ) {
      return;
    }
    if (entry.idleSince === undefined) entry.idleSince = this.clock();
    this.clearIdleTimer(entry);
    const elapsed = Math.max(0, this.clock() - entry.idleSince);
    const delay = Math.max(0, this.configuration.getSnapshot().sftpIdleTimeoutMs - elapsed);
    entry.idleTimer = setTimeout(() => {
      delete entry.idleTimer;
      if (entry.references === 0 && entry.waiters === 0) {
        void this.invalidateEntry(entry);
      }
    }, delay);
  }

  private clearIdle(entry: PoolEntry): void {
    delete entry.idleSince;
    this.clearIdleTimer(entry);
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
  }

  private rescheduleIdleEntries(): void {
    for (const entry of this.entries.values()) {
      if (entry.references === 0 && entry.waiters === 0 && entry.client) this.scheduleIdle(entry);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new EasySshError('CONNECTION_LOST', 'The SFTP pool is disposed.');
  }
}

class DefaultSftpLease implements SftpLease {
  readonly client: SftpClient;
  private disposed = false;

  constructor(
    private readonly pool: DefaultSftpConnectionPool,
    private readonly entry: PoolEntry,
    underlyingClient: SftpClient,
  ) {
    this.client = new LeasedSftpClient(pool, entry, underlyingClient, () => this.disposed);
  }

  get connectionId(): ConnectionId {
    return this.entry.connectionId;
  }

  touch(): void {
    if (!this.disposed) this.pool.touch(this.entry);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.pool.release(this.entry);
  }
}

class LeasedSftpClient implements SftpClient {
  constructor(
    private readonly pool: DefaultSftpConnectionPool,
    private readonly entry: PoolEntry,
    private readonly client: SftpClient,
    private readonly leaseDisposed: () => boolean,
  ) {}

  lstat(path: string): Promise<RemoteStat> {
    return this.execute(() => this.client.lstat(path));
  }
  stat(path: string): Promise<RemoteStat> {
    return this.execute(() => this.client.stat(path));
  }
  realpath(path: string): Promise<string> {
    return this.execute(() => this.client.realpath(path));
  }
  readlink(path: string): Promise<string> {
    return this.execute(() => this.client.readlink(path));
  }
  readDirectory(path: string): Promise<RemoteDirectoryEntry[]> {
    return this.execute(() => this.client.readDirectory(path));
  }
  readFile(path: string, range?: { offset: number; length: number }): Promise<Uint8Array> {
    return this.execute(() => this.client.readFile(path, range));
  }
  writeFile(path: string, data: Uint8Array, options: RemoteWriteOptions): Promise<void> {
    return this.execute(() => this.client.writeFile(path, data, options));
  }
  mkdir(path: string): Promise<void> {
    return this.execute(() => this.client.mkdir(path));
  }
  rename(source: string, target: string, overwrite: boolean): Promise<void> {
    return this.execute(() => this.client.rename(source, target, overwrite));
  }
  unlink(path: string): Promise<void> {
    return this.execute(() => this.client.unlink(path));
  }
  rmdir(path: string): Promise<void> {
    return this.execute(() => this.client.rmdir(path));
  }
  close(): Promise<void> {
    return this.pool.closeLeaseClient(this.entry);
  }

  private execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.leaseDisposed()) {
      return Promise.reject(
        new EasySshError('CONNECTION_LOST', 'The SFTP lease has already been released.'),
      );
    }
    return this.pool.run(this.entry, operation);
  }
}

class PoolCancellationTokenSource {
  private readonly listeners = new Set<() => unknown>();
  private cancelled = false;
  readonly token: CancellationTokenLike;

  constructor() {
    const isCancelled = (): boolean => this.cancelled;
    this.token = {
      get isCancellationRequested() {
        return isCancelled();
      },
      onCancellationRequested: (listener) => {
        if (this.cancelled) {
          listener();
          return { dispose: () => undefined };
        }
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

function withCancellation<T>(
  operation: Promise<T>,
  cancellation?: CancellationTokenLike,
): Promise<T> {
  if (!cancellation) return operation;
  if (cancellation.isCancellationRequested) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const subscription = cancellation.onCancellationRequested(() => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => subscription.dispose());
      reject(cancelled());
    });
    if (settled) subscription.dispose();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        subscription.dispose();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        subscription.dispose();
        reject(error);
      },
    );
  });
}

function cancelled(): EasySshError {
  return new EasySshError('CANCELLED', 'SFTP acquisition cancelled.');
}
