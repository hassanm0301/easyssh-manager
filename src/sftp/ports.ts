import type { ConnectionId } from '../connections/types';
import type * as vscode from 'vscode';
import type { Writable } from 'node:stream';
import type { CancellationTokenLike } from '../ssh/ports';

export interface ParsedSftpUri {
  readonly connectionId: ConnectionId;
  readonly remotePath: string;
}

export interface SftpUriCodec {
  create(connectionId: ConnectionId, remotePath: string): vscode.Uri;
  parse(uri: vscode.Uri): ParsedSftpUri;
}

export type RemoteEntryKind = 'file' | 'directory' | 'symbolicLink' | 'other';

export interface RemoteStat {
  readonly kind: RemoteEntryKind;
  readonly size: number;
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly atimeMs?: number;
  readonly mtimeMs: number;
}

export interface RemoteDirectoryEntry {
  readonly name: string;
  readonly stat: RemoteStat;
}

export interface RemoteWriteOptions {
  readonly create: boolean;
  readonly overwrite: boolean;
  readonly mode?: number;
}

export interface RemoteVersion {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface RemoteFileCache {
  getVersion(uri: vscode.Uri): RemoteVersion | undefined;
  rememberVersion(uri: vscode.Uri, version: RemoteVersion): void;
  invalidatePath(connectionId: ConnectionId, path: string): void;
  invalidateParent(connectionId: ConnectionId, path: string): void;
}

export interface SftpClientFactory {
  open(connectionId: ConnectionId, cancellation?: CancellationTokenLike): Promise<SftpClient>;
}

export type SftpOperationPriority = 'editor' | 'interactive' | 'background';

export interface SftpLease {
  readonly connectionId: ConnectionId;
  readonly client: SftpClient;
  touch(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface SftpConnectionPool {
  acquire(
    connectionId: ConnectionId,
    cancellation?: CancellationTokenLike,
    priority?: SftpOperationPriority,
  ): Promise<SftpLease>;
  invalidate(connectionId: ConnectionId, reason: string): Promise<void>;
  disposeAll(): Promise<void>;
}

export interface SftpClient {
  lstat(path: string): Promise<RemoteStat>;
  stat(path: string): Promise<RemoteStat>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readDirectory(path: string): Promise<RemoteDirectoryEntry[]>;
  /** Reads at most limit entries while consuming the remote directory handle. */
  readDirectoryBounded?(
    path: string,
    limit: number,
  ): Promise<{
    entries: RemoteDirectoryEntry[];
    truncated: boolean;
  }>;
  readFile(path: string, range?: { offset: number; length: number }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: RemoteWriteOptions): Promise<void>;
  /**
   * Optional streaming write support. Older/test adapters may omit it; callers
   * must retain a bounded-buffer fallback for virtual resources.
   */
  createWriteStream?(path: string, options: RemoteWriteOptions): Writable;
  mkdir(path: string): Promise<void>;
  rename(source: string, target: string, overwrite: boolean): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  close(): Promise<void>;
}
