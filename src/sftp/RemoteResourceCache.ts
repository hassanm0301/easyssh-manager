import { posix } from 'node:path';
import type * as vscode from 'vscode';

import type { ConnectionId } from '../connections/types';
import { normalizeRemotePath } from './SftpUriCodec';
import type {
  RemoteDirectoryEntry,
  RemoteFileCache,
  RemoteStat,
  RemoteVersion,
  SftpUriCodec,
} from './ports';

interface TimedValue<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface CacheInvalidation {
  readonly connectionId: ConnectionId;
  readonly remotePath: string;
  readonly scope: 'path' | 'parent' | 'connection';
}

export interface RemoteResourceCacheOptions {
  readonly metadataTtlMs?: number;
  readonly directoryTtlMs?: number;
  readonly clock?: () => number;
}

/** Short-lived metadata/listing cache plus persistent metadata-based document versions. */
export class RemoteResourceCache implements RemoteFileCache {
  private readonly metadata = new Map<string, TimedValue<RemoteStat>>();
  private readonly directories = new Map<string, TimedValue<readonly RemoteDirectoryEntry[]>>();
  private readonly versions = new Map<string, RemoteVersion>();
  private readonly invalidationListeners = new Set<(event: CacheInvalidation) => unknown>();
  private readonly metadataTtlMs: number;
  private readonly directoryTtlMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly uriCodec: SftpUriCodec,
    options: RemoteResourceCacheOptions = {},
  ) {
    this.metadataTtlMs = validTtl(options.metadataTtlMs, 2_000);
    this.directoryTtlMs = validTtl(options.directoryTtlMs, 2_000);
    this.clock = options.clock ?? Date.now;
  }

  readonly onDidInvalidate = (listener: (event: CacheInvalidation) => unknown) => {
    this.invalidationListeners.add(listener);
    return { dispose: () => this.invalidationListeners.delete(listener) };
  };

  getMetadata(connectionId: ConnectionId, path: string): RemoteStat | undefined {
    const value = this.getTimed(this.metadata, cacheKey(connectionId, path));
    return value ? cloneStat(value) : undefined;
  }

  rememberMetadata(connectionId: ConnectionId, path: string, stat: RemoteStat): void {
    this.metadata.set(cacheKey(connectionId, path), {
      value: cloneStat(stat),
      expiresAt: this.clock() + this.metadataTtlMs,
    });
  }

  async loadMetadata(
    connectionId: ConnectionId,
    path: string,
    loader: () => Promise<RemoteStat>,
    fresh = false,
  ): Promise<RemoteStat> {
    if (!fresh) {
      const cached = this.getMetadata(connectionId, path);
      if (cached) return cached;
    }
    const loaded = await loader();
    this.rememberMetadata(connectionId, path, loaded);
    return cloneStat(loaded);
  }

  getDirectory(
    connectionId: ConnectionId,
    path: string,
  ): readonly RemoteDirectoryEntry[] | undefined {
    const value = this.getTimed(this.directories, cacheKey(connectionId, path));
    return value ? cloneDirectory(value) : undefined;
  }

  rememberDirectory(
    connectionId: ConnectionId,
    path: string,
    entries: readonly RemoteDirectoryEntry[],
  ): void {
    this.directories.set(cacheKey(connectionId, path), {
      value: cloneDirectory(entries),
      expiresAt: this.clock() + this.directoryTtlMs,
    });
  }

  async loadDirectory(
    connectionId: ConnectionId,
    path: string,
    loader: () => Promise<readonly RemoteDirectoryEntry[]>,
    fresh = false,
  ): Promise<readonly RemoteDirectoryEntry[]> {
    if (!fresh) {
      const cached = this.getDirectory(connectionId, path);
      if (cached) return cached;
    }
    const loaded = await loader();
    this.rememberDirectory(connectionId, path, loaded);
    return cloneDirectory(loaded);
  }

  getVersion(uri: vscode.Uri): RemoteVersion | undefined {
    const { connectionId, remotePath } = this.uriCodec.parse(uri);
    const value = this.versions.get(cacheKey(connectionId, remotePath));
    return value ? { ...value } : undefined;
  }

  rememberVersion(uri: vscode.Uri, version: RemoteVersion): void {
    validateVersion(version);
    const { connectionId, remotePath } = this.uriCodec.parse(uri);
    this.versions.set(cacheKey(connectionId, remotePath), { ...version });
  }

  invalidatePath(connectionId: ConnectionId, path: string): void {
    const remotePath = normalizeRemotePath(path);
    const key = cacheKey(connectionId, remotePath);
    this.metadata.delete(key);
    this.directories.delete(key);
    this.versions.delete(key);
    this.emit({ connectionId, remotePath, scope: 'path' });
  }

  invalidateParent(connectionId: ConnectionId, path: string): void {
    const remotePath = normalizeRemotePath(path);
    const parentPath = posix.dirname(remotePath);
    const key = cacheKey(connectionId, parentPath);
    this.metadata.delete(key);
    this.directories.delete(key);
    this.emit({ connectionId, remotePath: parentPath, scope: 'parent' });
  }

  invalidateConnection(connectionId: ConnectionId): void {
    const prefix = `${connectionId}\0`;
    deleteByPrefix(this.metadata, prefix);
    deleteByPrefix(this.directories, prefix);
    deleteByPrefix(this.versions, prefix);
    this.emit({ connectionId, remotePath: '/', scope: 'connection' });
  }

  clear(): void {
    this.metadata.clear();
    this.directories.clear();
    this.versions.clear();
  }

  private getTimed<T>(cache: Map<string, TimedValue<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private emit(event: CacheInvalidation): void {
    for (const listener of [...this.invalidationListeners]) listener(event);
  }
}

function cacheKey(connectionId: ConnectionId, path: string): string {
  return `${connectionId}\0${normalizeRemotePath(path)}`;
}

function cloneStat(stat: RemoteStat): RemoteStat {
  return { ...stat };
}

function cloneDirectory(entries: readonly RemoteDirectoryEntry[]): readonly RemoteDirectoryEntry[] {
  return entries.map((entry) => ({ name: entry.name, stat: cloneStat(entry.stat) }));
}

function validTtl(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function validateVersion(version: RemoteVersion): void {
  if (
    !Number.isSafeInteger(version.mtimeMs) ||
    !Number.isSafeInteger(version.size) ||
    version.size < 0
  ) {
    throw new TypeError('Remote version metadata must contain safe integer values.');
  }
}

function deleteByPrefix<T>(values: Map<string, T>, prefix: string): void {
  for (const key of values.keys()) {
    if (key.startsWith(prefix)) values.delete(key);
  }
}
