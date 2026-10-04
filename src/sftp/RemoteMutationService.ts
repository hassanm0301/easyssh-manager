import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError } from '../common/errors';
import type { ConnectionId } from '../connections/types';
import type { RemoteResourceCache } from './RemoteResourceCache';
import { normalizeRemotePath } from './SftpUriCodec';
import type { SftpConnectionPool, SftpUriCodec } from './ports';
import { validateChildName } from './browser/contracts';

export interface RecursiveDeleteSummary {
  readonly deleted: number;
  readonly failed: readonly { readonly path: string; readonly message: string }[];
  readonly cancelled: boolean;
}

export interface RemoteMutationOptions {
  readonly maxDeleteEntries?: number;
  readonly maxDeleteBytes?: number;
  readonly maxDeleteDurationMs?: number;
}

interface MutationHost {
  readonly workspace: Pick<typeof vscode.workspace, 'textDocuments'>;
  readonly window: Pick<typeof vscode.window, 'tabGroups' | 'showWarningMessage' | 'withProgress'>;
  readonly ProgressLocation: typeof vscode.ProgressLocation;
}

export interface RemoteMutationReporter {
  emitMutationChanges(
    changes: readonly {
      readonly type: 'created' | 'deleted' | 'changed';
      readonly uri: vscode.Uri;
    }[],
  ): void;
}

/** Host-side mutation boundary: rechecks state, never follows links, and emits precise changes. */
export class RemoteMutationService {
  private readonly maxDeleteEntries: number;
  private readonly maxDeleteBytes: number;
  private readonly maxDeleteDurationMs: number;

  constructor(
    private readonly host: MutationHost,
    private readonly codec: SftpUriCodec,
    private readonly pool: SftpConnectionPool,
    private readonly cache: RemoteResourceCache,
    private readonly reporter: RemoteMutationReporter,
    options: RemoteMutationOptions = {},
  ) {
    this.maxDeleteEntries = options.maxDeleteEntries ?? 100_000;
    this.maxDeleteBytes = options.maxDeleteBytes ?? 20 * 1024 * 1024 * 1024;
    this.maxDeleteDurationMs = options.maxDeleteDurationMs ?? 5 * 60_000;
  }

  async createFile(
    connectionId: ConnectionId,
    parentPath: string,
    rawName: string,
  ): Promise<vscode.Uri> {
    const path = childPath(parentPath, rawName);
    await this.withClient(connectionId, async (client) => {
      await assertMissing(client, path);
      // Exclusive create is atomic on the server and creates exactly zero bytes.
      await client.writeFile(path, new Uint8Array(), { create: true, overwrite: false });
    });
    const uri = this.codec.create(connectionId, path);
    this.invalidateCreated(connectionId, path, uri);
    return uri;
  }

  async createDirectory(
    connectionId: ConnectionId,
    parentPath: string,
    rawName: string,
  ): Promise<vscode.Uri> {
    const path = childPath(parentPath, rawName);
    await this.withClient(connectionId, async (client) => {
      await assertMissing(client, path);
      await client.mkdir(path);
    });
    const uri = this.codec.create(connectionId, path);
    this.invalidateCreated(connectionId, path, uri);
    return uri;
  }

  async rename(
    connectionId: ConnectionId,
    sourceInput: string,
    rawName: string,
  ): Promise<vscode.Uri> {
    const source = normalizeRemotePath(sourceInput);
    if (source === '/') throw new EasySshError('VALIDATION', 'The remote root cannot be renamed.');
    const target = childPath(posix.dirname(source), rawName);
    if (source === target)
      throw new EasySshError('CONFLICT', 'The remote item already has that name.');
    const sourceUri = this.codec.create(connectionId, source);
    this.assertNotOpen(sourceUri, source);
    await this.withClient(connectionId, async (client) => {
      await client.lstat(source);
      await assertMissing(client, target);
      // Recheck after the user/editor state check, immediately before mutating.
      await client.lstat(source);
      await assertMissing(client, target);
      await client.rename(source, target, false);
    });
    const targetUri = this.codec.create(connectionId, target);
    this.cache.invalidatePath(connectionId, source);
    this.cache.invalidatePath(connectionId, target);
    this.cache.invalidateParent(connectionId, source);
    this.reporter.emitMutationChanges([
      { type: 'deleted', uri: sourceUri },
      { type: 'created', uri: targetUri },
      { type: 'changed', uri: this.codec.create(connectionId, posix.dirname(source)) },
    ]);
    return targetUri;
  }

  async delete(connectionId: ConnectionId, sourceInput: string): Promise<RecursiveDeleteSummary> {
    const source = normalizeRemotePath(sourceInput);
    if (source === '/') throw new EasySshError('VALIDATION', 'The remote root cannot be deleted.');
    const initial = await this.withClient(connectionId, (client) => client.lstat(source));
    if (initial.kind !== 'directory') {
      const confirmed = await this.host.window.showWarningMessage(
        `Delete remote item '${source}'?`,
        { modal: true },
        'Delete',
      );
      if (confirmed !== 'Delete') throw new EasySshError('CANCELLED', 'Remote delete cancelled.');
      await this.withClient(connectionId, async (client) => {
        const fresh = await client.lstat(source);
        if (fresh.kind === 'directory')
          throw new EasySshError('CONFLICT', 'The remote item changed type.');
        await client.unlink(source);
      });
      this.reportDeleted(connectionId, source);
      return { deleted: 1, failed: [], cancelled: false };
    }
    const confirmed = await this.host.window.showWarningMessage(
      `Delete remote directory '${source}' and all of its descendants? This cannot be undone.`,
      { modal: true },
      'Delete Recursively',
    );
    if (confirmed !== 'Delete Recursively')
      throw new EasySshError('CANCELLED', 'Remote recursive delete cancelled.');
    return this.host.window.withProgress(
      {
        location: this.host.ProgressLocation.Notification,
        title: `Deleting ${source}`,
        cancellable: true,
      },
      async (progress, token) => {
        void progress;
        return this.withClient(connectionId, async (client) => {
          const fresh = await client.lstat(source);
          if (fresh.kind !== 'directory')
            throw new EasySshError('CONFLICT', 'The remote item changed type.');
          const summary = await this.deleteDirectoryTree(client, source, token);
          if (summary.deleted > 0) this.reportDeleted(connectionId, source);
          return summary;
        });
      },
    );
  }

  private async deleteDirectoryTree(
    client: import('./ports').SftpClient,
    root: string,
    token: vscode.CancellationToken,
  ): Promise<RecursiveDeleteSummary> {
    const pending: { path: string; visited: boolean }[] = [{ path: root, visited: false }];
    const failures: { path: string; message: string }[] = [];
    let deleted = 0;
    let seen = 0;
    let bytes = 0;
    const started = Date.now();
    while (pending.length > 0) {
      if (token.isCancellationRequested) return { deleted, failed: failures, cancelled: true };
      if (Date.now() - started > this.maxDeleteDurationMs) {
        throw new EasySshError('OUTPUT_LIMIT', 'Recursive delete exceeded its time safety limit.');
      }
      const step = pending.pop();
      if (!step) break;
      try {
        if (step.visited) {
          await client.rmdir(step.path);
          deleted += 1;
          continue;
        }
        const stat = await client.lstat(step.path);
        if (stat.kind !== 'directory') {
          await client.unlink(step.path);
          deleted += 1;
          continue;
        }
        pending.push({ path: step.path, visited: true });
        const children = await client.readDirectory(step.path);
        for (const child of children) {
          if (child.name === '.' || child.name === '..') continue;
          if (!isSafeEntryName(child.name)) {
            throw new EasySshError(
              'REMOTE_IO',
              'The server returned an unsafe directory entry name.',
            );
          }
          seen += 1;
          bytes += child.stat.size;
          if (seen > this.maxDeleteEntries || bytes > this.maxDeleteBytes) {
            throw new EasySshError(
              'OUTPUT_LIMIT',
              'Recursive delete exceeded its configured safety limit.',
            );
          }
          const childPath = normalizeRemotePath(posix.join(step.path, child.name));
          // lstat below makes links leaves; they are unlinked, never traversed.
          pending.push({ path: childPath, visited: false });
        }
      } catch (error) {
        failures.push({
          path: step.path,
          message: error instanceof EasySshError ? error.message : 'Remote delete failed.',
        });
      }
    }
    return { deleted, failed: failures, cancelled: false };
  }

  private assertNotOpen(uri: vscode.Uri, source: string): void {
    const isAffected = (candidate: vscode.Uri): boolean => {
      try {
        const parsed = this.codec.parse(candidate);
        const sourcePath = normalizeRemotePath(source);
        return parsed.remotePath === sourcePath || parsed.remotePath.startsWith(`${sourcePath}/`);
      } catch {
        return false;
      }
    };
    if (this.host.workspace.textDocuments.some((document) => isAffected(document.uri))) {
      throw new EasySshError(
        'CONFLICT',
        'Close the remote editor(s) for this item and its descendants before renaming.',
      );
    }
    for (const group of this.host.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as unknown;
        if (hasUri(input) && isAffected(input.uri)) {
          throw new EasySshError(
            'CONFLICT',
            'Close the remote editor tab(s) for this item and its descendants before renaming.',
          );
        }
      }
    }
    void uri;
  }

  private invalidateCreated(connectionId: ConnectionId, path: string, uri: vscode.Uri): void {
    this.cache.invalidatePath(connectionId, path);
    this.cache.invalidateParent(connectionId, path);
    this.reporter.emitMutationChanges([
      { type: 'created', uri },
      { type: 'changed', uri: this.codec.create(connectionId, posix.dirname(path)) },
    ]);
  }

  private reportDeleted(connectionId: ConnectionId, path: string): void {
    this.cache.invalidatePath(connectionId, path);
    this.cache.invalidateParent(connectionId, path);
    this.reporter.emitMutationChanges([
      { type: 'deleted', uri: this.codec.create(connectionId, path) },
      { type: 'changed', uri: this.codec.create(connectionId, posix.dirname(path)) },
    ]);
  }

  private async withClient<T>(
    connectionId: ConnectionId,
    operation: (client: import('./ports').SftpClient) => Promise<T>,
  ): Promise<T> {
    const lease = await this.pool.acquire(connectionId);
    try {
      return await operation(lease.client);
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }
}

async function assertMissing(client: import('./ports').SftpClient, path: string): Promise<void> {
  try {
    await client.lstat(path);
  } catch (error) {
    if (error instanceof EasySshError && error.code === 'NOT_FOUND') return;
    throw error;
  }
  throw new EasySshError('ALREADY_EXISTS', `Remote path '${path}' already exists.`);
}

function childPath(parent: string, rawName: string): string {
  const name = validateChildName(rawName);
  return normalizeRemotePath(posix.join(normalizeRemotePath(parent), name));
}

function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
  );
}

function hasUri(value: unknown): value is { readonly uri: vscode.Uri } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'uri' in value &&
    (value as { readonly uri?: unknown }).uri !== undefined
  );
}
