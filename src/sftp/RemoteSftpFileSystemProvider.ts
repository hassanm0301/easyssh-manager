import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError } from '../common/errors';
import type { AtomicSftpWriter } from './AtomicSftpWriter';
import type { RemoteResourceCache } from './RemoteResourceCache';
import type { RemoteStat, SftpConnectionPool, SftpUriCodec } from './ports';

interface ProviderApi {
  readonly FileType: typeof vscode.FileType;
  readonly FileChangeType: typeof vscode.FileChangeType;
  readonly FileSystemError: typeof vscode.FileSystemError;
  readonly EventEmitter: typeof vscode.EventEmitter;
}

/** Writable VS Code filesystem facade. All remote work is scoped to a released pool lease. */
export class RemoteSftpFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes: vscode.EventEmitter<vscode.FileChangeEvent[]>;
  private readonly pendingChanges = new Map<string, vscode.FileChangeEvent>();
  private changeFlushQueued = false;
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;

  constructor(
    private readonly api: ProviderApi,
    private readonly codec: SftpUriCodec,
    private readonly pool: SftpConnectionPool,
    private readonly cache: RemoteResourceCache,
    private readonly writer: AtomicSftpWriter,
  ) {
    this.changes = new api.EventEmitter<vscode.FileChangeEvent[]>();
    this.onDidChangeFile = this.changes.event;
  }

  watch(
    _uri: vscode.Uri,
    _options: { readonly recursive: boolean; readonly excludes: readonly string[] },
  ): vscode.Disposable {
    void _uri;
    void _options;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
      },
    };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const parsed = this.codec.parse(uri);
    try {
      const stat = await this.withClient(parsed.connectionId, (client) =>
        this.cache.loadMetadata(parsed.connectionId, parsed.remotePath, () =>
          client.lstat(parsed.remotePath),
        ),
      );
      return this.fileStat(stat);
    } catch (error) {
      throw this.providerError(error, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const parsed = this.codec.parse(uri);
    try {
      const entries = await this.withClient(parsed.connectionId, (client) =>
        this.cache.loadDirectory(parsed.connectionId, parsed.remotePath, () =>
          client.readDirectory(parsed.remotePath),
        ),
      );
      return entries
        .filter((entry) => entry.name !== '.' && entry.name !== '..')
        .map((entry) => [entry.name, this.fileType(entry.stat)]);
    } catch (error) {
      throw this.providerError(error, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const parsed = this.codec.parse(uri);
    try {
      return await this.withClient(parsed.connectionId, async (client) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const before = await client.stat(parsed.remotePath);
          if (before.kind === 'directory') {
            throw new EasySshError(
              'IS_DIRECTORY',
              `Remote path '${parsed.remotePath}' is a directory.`,
            );
          }
          const data = await client.readFile(parsed.remotePath);
          const after = await client.stat(parsed.remotePath);
          if (sameVersion(before, after)) {
            this.cache.rememberMetadata(parsed.connectionId, parsed.remotePath, after);
            this.cache.rememberVersion(uri, { mtimeMs: after.mtimeMs, size: after.size });
            return data;
          }
        }
        throw new EasySshError(
          'CONFLICT',
          `Remote path '${parsed.remotePath}' changed while it was being read.`,
        );
      });
    } catch (error) {
      throw this.providerError(error, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const parsed = this.codec.parse(uri);
    try {
      const result = await this.withClient(parsed.connectionId, (client) =>
        this.writer.write(uri, client, content, options),
      );
      this.queueChange(this.api.FileChangeType.Changed, uri);
      if (result.created) {
        this.queueChange(
          this.api.FileChangeType.Changed,
          this.parentUri(parsed.connectionId, parsed.remotePath),
        );
      }
    } catch (error) {
      throw this.providerError(error, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const parsed = this.codec.parse(uri);
    try {
      await this.withClient(parsed.connectionId, (client) => client.mkdir(parsed.remotePath));
      this.cache.invalidatePath(parsed.connectionId, parsed.remotePath);
      this.cache.invalidateParent(parsed.connectionId, parsed.remotePath);
      this.queueChange(this.api.FileChangeType.Created, uri);
      this.queueChange(
        this.api.FileChangeType.Changed,
        this.parentUri(parsed.connectionId, parsed.remotePath),
      );
    } catch (error) {
      throw this.providerError(error, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    void options;
    const parsed = this.codec.parse(uri);
    try {
      await this.withClient(parsed.connectionId, async (client) => {
        const stat = await client.lstat(parsed.remotePath);
        if (stat.kind === 'directory') await client.rmdir(parsed.remotePath);
        else await client.unlink(parsed.remotePath);
      });
      this.cache.invalidatePath(parsed.connectionId, parsed.remotePath);
      this.cache.invalidateParent(parsed.connectionId, parsed.remotePath);
      this.queueChange(this.api.FileChangeType.Deleted, uri);
      this.queueChange(
        this.api.FileChangeType.Changed,
        this.parentUri(parsed.connectionId, parsed.remotePath),
      );
    } catch (error) {
      throw this.providerError(error, uri);
    }
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    const source = this.codec.parse(oldUri);
    const target = this.codec.parse(newUri);
    if (source.connectionId !== target.connectionId) {
      throw this.providerError(
        new EasySshError('UNSUPPORTED', 'Cross-connection SFTP rename is not supported.'),
        oldUri,
      );
    }
    try {
      await this.withClient(source.connectionId, async (client) => {
        if (options.overwrite) {
          try {
            const existing = await client.lstat(target.remotePath);
            if (existing.kind === 'directory') {
              throw new EasySshError(
                'IS_DIRECTORY',
                `Remote path '${target.remotePath}' is a directory.`,
              );
            }
          } catch (error) {
            if (!(error instanceof EasySshError) || error.code !== 'NOT_FOUND') throw error;
          }
        }
        await client.rename(source.remotePath, target.remotePath, options.overwrite);
      });
      this.cache.invalidatePath(source.connectionId, source.remotePath);
      this.cache.invalidateParent(source.connectionId, source.remotePath);
      this.cache.invalidatePath(target.connectionId, target.remotePath);
      this.cache.invalidateParent(target.connectionId, target.remotePath);
      this.queueChange(this.api.FileChangeType.Deleted, oldUri);
      this.queueChange(this.api.FileChangeType.Created, newUri);
      const oldParent = this.parentUri(source.connectionId, source.remotePath);
      const newParent = this.parentUri(target.connectionId, target.remotePath);
      this.queueChange(this.api.FileChangeType.Changed, oldParent);
      if (oldParent.toString() !== newParent.toString()) {
        this.queueChange(this.api.FileChangeType.Changed, newParent);
      }
    } catch (error) {
      throw this.providerError(error, oldUri);
    }
  }

  dispose(): void {
    this.pendingChanges.clear();
    this.changes.dispose();
  }

  /**
   * Reports a mutation performed by a host-side browser service. This deliberately
   * exposes only already-constructed provider URIs and change kinds; browser code
   * cannot obtain transport state or manufacture filesystem events for other schemes.
   */
  emitMutationChanges(
    changes: readonly {
      readonly type: 'created' | 'deleted' | 'changed';
      readonly uri: vscode.Uri;
    }[],
  ): void {
    for (const change of changes) {
      const type =
        change.type === 'created'
          ? this.api.FileChangeType.Created
          : change.type === 'deleted'
            ? this.api.FileChangeType.Deleted
            : this.api.FileChangeType.Changed;
      this.queueChange(type, change.uri);
    }
  }

  private async withClient<T>(
    connectionId: string,
    operation: (client: import('./ports').SftpClient) => Promise<T>,
  ): Promise<T> {
    const lease = await this.pool.acquire(connectionId);
    try {
      return await operation(lease.client);
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }

  private fileStat(stat: RemoteStat): vscode.FileStat {
    return {
      type: this.fileType(stat),
      ctime: stat.mtimeMs,
      mtime: stat.mtimeMs,
      size: stat.size,
      ...(stat.mode !== undefined && (stat.mode & 0o222) === 0
        ? { permissions: 1 as vscode.FilePermission }
        : {}),
    };
  }

  private fileType(stat: RemoteStat): vscode.FileType {
    switch (stat.kind) {
      case 'file':
        return this.api.FileType.File;
      case 'directory':
        return this.api.FileType.Directory;
      case 'symbolicLink':
        return this.api.FileType.SymbolicLink;
      default:
        return this.api.FileType.Unknown;
    }
  }

  private parentUri(connectionId: string, path: string): vscode.Uri {
    return this.codec.create(connectionId, posix.dirname(path));
  }

  private queueChange(type: vscode.FileChangeType, uri: vscode.Uri): void {
    const key = `${type}:${uri.toString()}`;
    if (!this.pendingChanges.has(key)) this.pendingChanges.set(key, { type, uri });
    if (this.changeFlushQueued) return;
    this.changeFlushQueued = true;
    queueMicrotask(() => {
      this.changeFlushQueued = false;
      if (this.pendingChanges.size === 0) return;
      const changes = [...this.pendingChanges.values()];
      this.pendingChanges.clear();
      this.changes.fire(changes);
    });
  }

  private providerError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
    if (error instanceof this.api.FileSystemError) return error;
    if (!(error instanceof EasySshError)) return this.api.FileSystemError.Unavailable(uri);
    switch (error.code) {
      case 'NOT_FOUND':
        return this.api.FileSystemError.FileNotFound(uri);
      case 'ALREADY_EXISTS':
        return this.api.FileSystemError.FileExists(uri);
      case 'NOT_DIRECTORY':
        return this.api.FileSystemError.FileNotADirectory(uri);
      case 'IS_DIRECTORY':
        return this.api.FileSystemError.FileIsADirectory(uri);
      case 'PERMISSION_DENIED':
        return this.api.FileSystemError.NoPermissions(uri);
      default:
        return this.api.FileSystemError.Unavailable(error.message);
    }
  }
}

function sameVersion(left: RemoteStat, right: RemoteStat): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}
