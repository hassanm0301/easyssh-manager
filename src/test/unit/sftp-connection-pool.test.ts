import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EasySshError } from '../../common/errors';
import { DefaultSftpConnectionPool } from '../../sftp/SftpConnectionPool';
import type { SftpClient, SftpClientFactory } from '../../sftp/ports';
import type { CancellationTokenLike } from '../../ssh/ports';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function client(overrides: Partial<SftpClient> = {}): SftpClient {
  return {
    lstat: vi.fn(async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 })),
    stat: vi.fn(async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 })),
    realpath: vi.fn(async (path: string) => path),
    readlink: vi.fn(async () => 'target'),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

class ConfigurationFake {
  private readonly listeners = new Set<(value: { sftpIdleTimeoutMs: number }) => unknown>();
  private value = { sftpIdleTimeoutMs: 1_000 };

  readonly onDidChange = (listener: (value: { sftpIdleTimeoutMs: number }) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  getSnapshot(): Readonly<{ sftpIdleTimeoutMs: number }> {
    return this.value;
  }

  update(sftpIdleTimeoutMs: number): void {
    this.value = { sftpIdleTimeoutMs };
    for (const listener of [...this.listeners]) listener(this.value);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class CancellationFake implements CancellationTokenLike {
  private readonly listeners = new Set<() => unknown>();
  isCancellationRequested = false;
  readonly onCancellationRequested = (listener: () => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
  }
}

describe('SFTP connection pool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces concurrent connects and starts idle expiry only after the final lease', async () => {
    const pending = deferred<SftpClient>();
    const factory: SftpClientFactory = { open: vi.fn(() => pending.promise) };
    const configuration = new ConfigurationFake();
    const pool = new DefaultSftpConnectionPool(factory, configuration);
    const firstAcquire = pool.acquire(FIRST_ID);
    const secondAcquire = pool.acquire(FIRST_ID);
    expect(factory.open).toHaveBeenCalledOnce();

    const underlying = client();
    pending.resolve(underlying);
    const [first, second] = await Promise.all([firstAcquire, secondAcquire]);
    await first.client.stat('/one');
    await second.client.stat('/two');
    expect(underlying.stat).toHaveBeenCalledTimes(2);

    await first[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(underlying.close).not.toHaveBeenCalled();
    await second[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(999);
    expect(underlying.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('shares a failed connect without auto-retry and reconnects on the next explicit acquire', async () => {
    const pending = deferred<SftpClient>();
    const replacement = client();
    const open = vi
      .fn<SftpClientFactory['open']>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(replacement);
    const pool = new DefaultSftpConnectionPool({ open }, new ConfigurationFake());
    const first = pool.acquire(FIRST_ID);
    const second = pool.acquire(FIRST_ID);
    pending.reject(new EasySshError('AUTHENTICATION', 'rejected'));
    await expect(first).rejects.toMatchObject({ code: 'AUTHENTICATION' });
    await expect(second).rejects.toMatchObject({ code: 'AUTHENTICATION' });
    expect(open).toHaveBeenCalledOnce();

    const lease = await pool.acquire(FIRST_ID);
    expect(open).toHaveBeenCalledTimes(2);
    await lease[Symbol.asyncDispose]();
  });

  it('resets idle time on reuse and applies configuration changes to idle entries', async () => {
    const underlying = client();
    const configuration = new ConfigurationFake();
    const pool = new DefaultSftpConnectionPool(
      { open: vi.fn(async () => underlying) },
      configuration,
    );
    const first = await pool.acquire(FIRST_ID);
    await first[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(600);

    const second = await pool.acquire(FIRST_ID);
    await second[Symbol.asyncDispose]();
    await vi.advanceTimersByTimeAsync(400);
    configuration.update(500);
    await vi.advanceTimersByTimeAsync(99);
    expect(underlying.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(underlying.close).toHaveBeenCalledOnce();
  });

  it('invalidates on connection loss without replaying a mutation', async () => {
    const failedWrite = vi.fn(async () => {
      throw new EasySshError('CONNECTION_LOST', 'lost during write');
    });
    const firstClient = client({ writeFile: failedWrite });
    const secondClient = client();
    const open = vi
      .fn<SftpClientFactory['open']>()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const pool = new DefaultSftpConnectionPool({ open }, new ConfigurationFake());
    const firstLease = await pool.acquire(FIRST_ID);
    await expect(
      firstLease.client.writeFile('/file', Buffer.from('content'), {
        create: true,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(failedWrite).toHaveBeenCalledOnce();
    expect(firstClient.close).toHaveBeenCalledOnce();

    const secondLease = await pool.acquire(FIRST_ID);
    expect(open).toHaveBeenCalledTimes(2);
    expect(secondClient.writeFile).not.toHaveBeenCalled();
    await expect(firstLease.client.stat('/stale')).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    });
    await firstLease.client.close();
    await expect(secondLease.client.stat('/current')).resolves.toMatchObject({ kind: 'file' });
    expect(secondClient.close).not.toHaveBeenCalled();
    await secondLease[Symbol.asyncDispose]();
    await firstLease[Symbol.asyncDispose]();
  });

  it('lets one waiter cancel without cancelling a shared connection attempt', async () => {
    const pending = deferred<SftpClient>();
    let poolToken: CancellationTokenLike | undefined;
    const open = vi.fn<SftpClientFactory['open']>((_id, cancellation) => {
      poolToken = cancellation;
      return pending.promise;
    });
    const pool = new DefaultSftpConnectionPool({ open }, new ConfigurationFake());
    const callerCancellation = new CancellationFake();
    const cancelledAcquire = pool.acquire(FIRST_ID, callerCancellation);
    const successfulAcquire = pool.acquire(FIRST_ID);
    callerCancellation.cancel();
    await expect(cancelledAcquire).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(poolToken?.isCancellationRequested).toBe(false);

    pending.resolve(client());
    const lease = await successfulAcquire;
    expect(open).toHaveBeenCalledOnce();
    await lease[Symbol.asyncDispose]();
  });

  it('cancels pending work and closes every entry during deactivation', async () => {
    const pending = deferred<SftpClient>();
    let pendingToken: CancellationTokenLike | undefined;
    const firstClient = client();
    const open = vi.fn<SftpClientFactory['open']>((id, cancellation) => {
      if (id === SECOND_ID) {
        pendingToken = cancellation;
        cancellation?.onCancellationRequested(() =>
          pending.reject(new EasySshError('CANCELLED', 'pool disposed')),
        );
        return pending.promise;
      }
      return Promise.resolve(firstClient);
    });
    const configuration = new ConfigurationFake();
    const pool = new DefaultSftpConnectionPool({ open }, configuration);
    const lease = await pool.acquire(FIRST_ID);
    const pendingAcquire = pool.acquire(SECOND_ID);
    const disposal = pool.disposeAll();
    await expect(pendingAcquire).rejects.toMatchObject({ code: 'CANCELLED' });
    await disposal;

    expect(pendingToken?.isCancellationRequested).toBe(true);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(configuration.listenerCount).toBe(0);
    await expect(pool.acquire(FIRST_ID)).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    await lease[Symbol.asyncDispose]();
  });
});
