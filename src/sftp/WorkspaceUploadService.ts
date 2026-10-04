import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { posix } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type * as vscode from 'vscode';

import { EasySshError, isCancellation } from '../common/errors';
import type { ConnectionId } from '../connections/types';
import type { CancellationTokenLike } from '../ssh/ports';
import type { RemoteResourceCache } from './RemoteResourceCache';
import { normalizeRemotePath } from './SftpUriCodec';
import type { SftpClient, SftpConnectionPool, SftpUriCodec } from './ports';

export const MAX_WORKSPACE_DRAG_ITEMS = 1_000;
export const MAX_UPLOAD_ENTRIES = 100_000;
export const MAX_UPLOAD_DEPTH = 256;
export const DEFAULT_UPLOAD_CONCURRENCY = 3;

export interface WorkspaceRootView {
  readonly name: string;
  readonly uri: string;
}

export interface WorkspaceEntryView {
  readonly name: string;
  readonly uri: string;
  readonly kind: 'file' | 'directory' | 'symbolicLink' | 'other';
}

export interface WorkspaceDragPayload {
  readonly type: 'workspace-items';
  readonly uris: readonly string[];
}

export interface WorkspacePaneView {
  readonly generation: number;
  readonly state: 'ready' | 'untrusted' | 'noWorkspace';
  readonly message?: string;
  readonly roots: readonly WorkspaceRootView[];
}

export interface UploadSourceRoot {
  readonly source: vscode.Uri;
  readonly targetPath: string;
  readonly kind: 'file' | 'directory';
}

export type UploadPlanEntry =
  | { readonly kind: 'directory'; readonly source: vscode.Uri; readonly targetPath: string }
  | {
      readonly kind: 'file';
      readonly source: vscode.Uri;
      readonly targetPath: string;
      readonly size: number;
    };

export interface UploadPlan {
  readonly operationId: string;
  readonly connectionId: string;
  readonly targetDirectory: string;
  readonly roots: readonly UploadSourceRoot[];
  readonly entries: readonly UploadPlanEntry[];
  readonly totalFiles: number;
  /** Undefined means a source provider could not establish an accurate total. */
  readonly totalBytes?: number;
  readonly skippedLinks: readonly SummaryItem[];
  readonly skippedUnsupported: readonly SummaryItem[];
}

export type FileConflictDecision = 'overwrite' | 'overwriteAll' | 'skip' | 'skipAll' | 'cancel';
export type DirectoryConflictDecision = 'merge' | 'mergeAll' | 'skip' | 'skipAll' | 'cancel';

export interface SummaryItem {
  readonly path: string;
  readonly reason: string;
}

export interface TransferSummary {
  readonly operationId: string;
  readonly uploaded: number;
  readonly createdDirectories: number;
  readonly mergedDirectories: number;
  readonly skipped: readonly SummaryItem[];
  readonly skippedLinks: readonly SummaryItem[];
  readonly failed: readonly SummaryItem[];
  readonly cancelled: boolean;
  readonly cleanupWarnings: readonly string[];
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly bytesTransferred: number;
  readonly bytesAccurate: boolean;
}

export interface UploadService {
  uploadWorkspaceItems(input: {
    readonly connectionId: string;
    readonly sourceUris: readonly vscode.Uri[];
    readonly targetRemotePath: string;
    readonly cancellation: CancellationTokenLike;
  }): Promise<TransferSummary>;
}

type WorkspaceHost = Pick<typeof vscode, 'FileType' | 'ProgressLocation'> & {
  readonly Uri: Pick<typeof vscode.Uri, 'parse' | 'joinPath'>;
  readonly workspace: Pick<
    typeof vscode.workspace,
    | 'workspaceFolders'
    | 'isTrusted'
    | 'fs'
    | 'onDidChangeWorkspaceFolders'
    | 'onDidGrantWorkspaceTrust'
  > & {
    createFileSystemWatcher?: typeof vscode.workspace.createFileSystemWatcher;
  };
  readonly RelativePattern?: typeof vscode.RelativePattern;
  readonly window: Pick<
    typeof vscode.window,
    'showOpenDialog' | 'showWarningMessage' | 'withProgress'
  >;
};

interface IssuedUri {
  readonly uri: vscode.Uri;
  readonly generation: number;
}

/**
 * The only authority bridge between a Workspace pane and workspace.fs. A URI has
 * to have been emitted for the current panel generation before it can become an
 * upload source. The pane cannot turn an arbitrary string into local access.
 */
export class WorkspacePaneService implements vscode.Disposable {
  private generation = 0;
  private readonly issued = new Map<string, IssuedUri>();
  private readonly listeners = new Set<(reason: 'roots' | 'trust' | 'filesystem') => unknown>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly watchers: vscode.Disposable[] = [];

  constructor(private readonly host: WorkspaceHost) {
    this.subscriptions.push(
      host.workspace.onDidChangeWorkspaceFolders(() => {
        this.revokeAndRefresh();
        this.installWatchers();
      }),
      host.workspace.onDidGrantWorkspaceTrust(() => this.revokeAndRefresh('trust')),
    );
    this.installWatchers();
  }

  readonly onDidChange = (
    listener: (reason: 'roots' | 'trust' | 'filesystem') => unknown,
  ): vscode.Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  initialize(): WorkspacePaneView {
    this.revoke();
    return this.view();
  }

  view(): WorkspacePaneView {
    if (!this.host.workspace.isTrusted) {
      return {
        generation: this.generation,
        state: 'untrusted',
        message:
          'Workspace browsing and uploads require workspace trust. Connection management and direct SSH/SFTP remain available.',
        roots: [],
      };
    }
    const folders = this.host.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return {
        generation: this.generation,
        state: 'noWorkspace',
        message: 'Open a workspace folder to browse and drag upload sources.',
        roots: [],
      };
    }
    return {
      generation: this.generation,
      state: 'ready',
      roots: folders.map((folder) => ({ name: folder.name, uri: this.issue(folder.uri) })),
    };
  }

  async readChildren(value: unknown): Promise<readonly WorkspaceEntryView[]> {
    this.assertTrusted();
    const uri = this.authorizeOne(value);
    const stat = await this.host.workspace.fs.stat(uri);
    if (!isDirectory(stat.type, this.host.FileType)) {
      throw new EasySshError('NOT_DIRECTORY', 'The selected workspace item is not a directory.');
    }
    let entries: readonly [string, vscode.FileType][];
    try {
      entries = await this.host.workspace.fs.readDirectory(uri);
    } catch (error) {
      throw workspaceProviderError(uri, error);
    }
    return entries
      .map(([name, type]) => {
        if (!isSafeSegment(name)) {
          throw new EasySshError('REMOTE_IO', 'The workspace provider returned an unsafe name.');
        }
        const child = this.host.Uri.joinPath(uri, name);
        if (!this.isUnderCurrentRoot(child)) {
          throw new EasySshError(
            'VALIDATION',
            'The workspace provider returned an item outside its root.',
          );
        }
        return { name, uri: this.issue(child), kind: workspaceKind(type, this.host.FileType) };
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
  }

  authorizeDragPayload(value: unknown): readonly vscode.Uri[] {
    this.assertTrusted();
    const payload = validateWorkspaceDragPayload(value);
    const authorized = payload.uris.map((uri) => this.authorizeOne(uri));
    if (hasAncestorSelection(authorized)) {
      throw new EasySshError(
        'VALIDATION',
        'A workspace drag cannot include both an item and one of its descendants.',
      );
    }
    return authorized;
  }

  /** Freshly validates an emitted URI before a planner or reader touches it. */
  async freshAuthorizedSources(value: unknown): Promise<readonly vscode.Uri[]> {
    const uris = this.authorizeDragPayload(value);
    for (const uri of uris) {
      try {
        await this.host.workspace.fs.stat(uri);
      } catch (error) {
        throw workspaceProviderError(uri, error);
      }
    }
    return uris;
  }

  revokeAndRefresh(reason: 'roots' | 'trust' = 'roots'): void {
    this.revoke();
    this.fire(reason);
  }

  dispose(): void {
    this.revoke();
    for (const watcher of this.watchers.splice(0)) watcher.dispose();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.listeners.clear();
  }

  private authorizeOne(value: unknown): vscode.Uri {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 8_192 ||
      unsafeUriText(value)
    ) {
      throw new EasySshError('VALIDATION', 'The workspace URI is invalid.');
    }
    let parsed: vscode.Uri;
    try {
      parsed = this.host.Uri.parse(value, true);
    } catch {
      throw new EasySshError('VALIDATION', 'The workspace URI is invalid.');
    }
    const issued = this.issued.get(value);
    if (
      !issued ||
      issued.generation !== this.generation ||
      issued.uri.toString() !== value ||
      parsed.toString() !== value ||
      !sameUri(issued.uri, parsed) ||
      !this.isUnderCurrentRoot(parsed)
    ) {
      throw new EasySshError('VALIDATION', 'The workspace URI was not authorized for this panel.');
    }
    return parsed;
  }

  private issue(uri: vscode.Uri): string {
    if (!this.isUnderCurrentRoot(uri)) {
      throw new EasySshError(
        'VALIDATION',
        'Refusing to expose a URI outside the current workspace.',
      );
    }
    const value = uri.toString();
    this.issued.set(value, { uri, generation: this.generation });
    return value;
  }

  private isUnderCurrentRoot(uri: vscode.Uri): boolean {
    if (unsafeUriText(uri.toString()) || uri.path.includes('\0')) return false;
    return (this.host.workspace.workspaceFolders ?? []).some((folder) =>
      containsUri(folder.uri, uri),
    );
  }

  private assertTrusted(): void {
    if (!this.host.workspace.isTrusted) {
      throw new EasySshError(
        'WORKSPACE_UNTRUSTED',
        'Workspace browsing and uploads are disabled until this workspace is trusted.',
      );
    }
  }

  private revoke(): void {
    this.generation += 1;
    this.issued.clear();
  }

  private fire(reason: 'roots' | 'trust' | 'filesystem'): void {
    for (const listener of [...this.listeners]) listener(reason);
  }

  private installWatchers(): void {
    for (const watcher of this.watchers.splice(0)) watcher.dispose();
    const create = this.host.workspace.createFileSystemWatcher;
    const RelativePattern = this.host.RelativePattern;
    if (!create || !RelativePattern) return;
    for (const folder of this.host.workspace.workspaceFolders ?? []) {
      try {
        const watcher = create(new RelativePattern(folder, '**'));
        this.watchers.push(
          watcher,
          watcher.onDidCreate(() => this.fire('filesystem')),
          watcher.onDidChange(() => this.fire('filesystem')),
          watcher.onDidDelete(() => this.fire('filesystem')),
        );
      } catch {
        // Not every virtual provider supports watchers. Explicit refresh still reads source of truth.
      }
    }
  }
}

export interface UploadServiceOptions {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly concurrency?: number;
  readonly maxBufferedTransferMiB: () => number;
}

interface UploadReporter {
  emitMutationChanges(
    changes: readonly { readonly type: 'created' | 'changed'; readonly uri: vscode.Uri }[],
  ): void;
}

interface MutableSummary {
  uploaded: number;
  createdDirectories: number;
  mergedDirectories: number;
  skipped: SummaryItem[];
  skippedLinks: SummaryItem[];
  failed: SummaryItem[];
  cancelled: boolean;
  cleanupWarnings: string[];
  completedFiles: number;
  bytesTransferred: number;
  bytesAccurate: boolean;
}

interface ConflictState {
  fileOverwriteAll: boolean;
  fileSkipAll: boolean;
  directoryMergeAll: boolean;
  directorySkipAll: boolean;
}

class UploadDecisionError extends Error {
  constructor(readonly outcome: 'skip' | 'cancel') {
    super(outcome === 'skip' ? 'Destination was skipped.' : 'Upload cancelled.');
    this.name = 'UploadDecisionError';
  }
}

/**
 * Cancellable, iterative workspace planner plus operation-local upload executor.
 * It deliberately keeps all policy decisions and every remote mutation in the
 * extension host; the browser sends only already-authorized URI strings.
 */
export class WorkspaceUploadService implements UploadService, vscode.Disposable {
  private readonly maxEntries: number;
  private readonly maxDepth: number;
  private readonly concurrency: number;
  private readonly commitListeners = new Set<
    (event: { connectionId: string; path: string }) => unknown
  >();
  private readonly activeOperations = new Set<OperationCancellation>();
  private readonly drainListeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly pool: SftpConnectionPool,
    private readonly cache: RemoteResourceCache,
    private readonly codec: SftpUriCodec,
    private readonly reporter: UploadReporter,
    private readonly options: UploadServiceOptions,
  ) {
    this.maxEntries = options.maxEntries ?? MAX_UPLOAD_ENTRIES;
    this.maxDepth = options.maxDepth ?? MAX_UPLOAD_DEPTH;
    this.concurrency = options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
  }

  readonly onDidCommit = (
    listener: (event: { connectionId: string; path: string }) => unknown,
  ): vscode.Disposable => {
    this.commitListeners.add(listener);
    return { dispose: () => this.commitListeners.delete(listener) };
  };

  async chooseAndUpload(
    connectionId: ConnectionId,
    targetRemotePath: string,
    kind: 'files' | 'folder',
    cancellation: CancellationTokenLike = neverCancelled(),
  ): Promise<TransferSummary> {
    this.assertTrusted();
    const selected = await this.host.window.showOpenDialog({
      canSelectFiles: kind === 'files',
      canSelectFolders: kind === 'folder',
      canSelectMany: kind === 'files',
      openLabel: kind === 'files' ? 'Upload Files' : 'Upload Folder',
    });
    if (!selected?.length) throw new EasySshError('CANCELLED', 'No workspace items were selected.');
    // Picker results are one-operation inputs; they are intentionally never issued to a webview.
    return this.uploadWorkspaceItems({
      connectionId,
      sourceUris: selected,
      targetRemotePath,
      cancellation,
    });
  }

  async planWorkspaceItems(input: {
    readonly connectionId: string;
    readonly sourceUris: readonly vscode.Uri[];
    readonly targetRemotePath: string;
    readonly cancellation: CancellationTokenLike;
  }): Promise<UploadPlan> {
    this.assertActive();
    this.assertTrusted();
    if (input.sourceUris.length === 0) {
      throw new EasySshError('VALIDATION', 'Select at least one workspace item to upload.');
    }
    if (input.sourceUris.length > MAX_WORKSPACE_DRAG_ITEMS) {
      throw new EasySshError(
        'OUTPUT_LIMIT',
        `Upload is limited to ${MAX_WORKSPACE_DRAG_ITEMS} roots.`,
      );
    }
    const targetDirectory = normalizeRemotePath(input.targetRemotePath);
    const entries: UploadPlanEntry[] = [];
    const roots: UploadSourceRoot[] = [];
    const skippedLinks: SummaryItem[] = [];
    const skippedUnsupported: SummaryItem[] = [];
    let scanned = 0;
    let totalBytes = 0;
    let bytesKnown = true;
    const sourceRoots = deduplicateUris(input.sourceUris);

    for (const source of sourceRoots) {
      checkCancelled(input.cancellation);
      const name = uriBasename(source);
      if (!isSafeSegment(name)) {
        throw new EasySshError('VALIDATION', 'Workspace roots must have one safe basename.');
      }
      const targetPath = containedRemoteTarget(targetDirectory, [name]);
      let stat: vscode.FileStat;
      try {
        stat = await this.host.workspace.fs.stat(source);
      } catch (error) {
        throw workspaceProviderError(source, error);
      }
      scanned = addScanned(scanned, this.maxEntries);
      const rootKind = workspaceKind(stat.type, this.host.FileType);
      if (rootKind === 'symbolicLink') {
        skippedLinks.push({ path: name, reason: 'Symbolic links are not uploaded.' });
        continue;
      }
      if (rootKind === 'other') {
        skippedUnsupported.push({ path: name, reason: 'Unsupported workspace resource type.' });
        continue;
      }
      roots.push({ source, targetPath, kind: rootKind });
      if (rootKind === 'file') {
        entries.push({ kind: 'file', source, targetPath, size: stat.size });
        if (isKnownSize(stat.size)) totalBytes += stat.size;
        else bytesKnown = false;
        continue;
      }
      entries.push({ kind: 'directory', source, targetPath });
      const pending: {
        readonly source: vscode.Uri;
        readonly targetPath: string;
        readonly relative: readonly string[];
      }[] = [{ source, targetPath, relative: [name] }];
      while (pending.length > 0) {
        checkCancelled(input.cancellation);
        const current = pending.pop();
        if (!current) break;
        let children: readonly [string, vscode.FileType][];
        try {
          children = await this.host.workspace.fs.readDirectory(current.source);
        } catch (error) {
          throw workspaceProviderError(current.source, error);
        }
        for (const [childName] of children) {
          checkCancelled(input.cancellation);
          if (!isSafeSegment(childName)) {
            throw new EasySshError(
              'VALIDATION',
              'The workspace provider returned an unsafe child name.',
            );
          }
          const relative = [...current.relative, childName];
          if (relative.length > this.maxDepth) {
            throw new EasySshError(
              'OUTPUT_LIMIT',
              `Upload exceeds the ${this.maxDepth}-level normalized path depth limit.`,
            );
          }
          const child = this.host.Uri.joinPath(current.source, childName);
          const target = containedRemoteTarget(targetDirectory, relative);
          let stat: vscode.FileStat;
          try {
            stat = await this.host.workspace.fs.stat(child);
          } catch (error) {
            throw workspaceProviderError(child, error);
          }
          scanned = addScanned(scanned, this.maxEntries);
          const childKind = workspaceKind(stat.type, this.host.FileType);
          const relativePath = relative.join('/');
          if (childKind === 'symbolicLink') {
            skippedLinks.push({ path: relativePath, reason: 'Symbolic links are not uploaded.' });
            continue;
          }
          if (childKind === 'other') {
            skippedUnsupported.push({
              path: relativePath,
              reason: 'Unsupported workspace resource type.',
            });
            continue;
          }
          if (childKind === 'directory') {
            entries.push({ kind: 'directory', source: child, targetPath: target });
            pending.push({ source: child, targetPath: target, relative });
            continue;
          }
          entries.push({ kind: 'file', source: child, targetPath: target, size: stat.size });
          if (isKnownSize(stat.size)) totalBytes += stat.size;
          else bytesKnown = false;
        }
      }
    }
    const files = entries.filter(
      (entry): entry is Extract<UploadPlanEntry, { kind: 'file' }> => entry.kind === 'file',
    );
    return {
      operationId: randomUUID(),
      connectionId: input.connectionId,
      targetDirectory,
      roots,
      entries: entries.sort(comparePlanEntries),
      totalFiles: files.length,
      ...(bytesKnown ? { totalBytes } : {}),
      skippedLinks,
      skippedUnsupported,
    };
  }

  async uploadWorkspaceItems(input: {
    readonly connectionId: string;
    readonly sourceUris: readonly vscode.Uri[];
    readonly targetRemotePath: string;
    readonly cancellation: CancellationTokenLike;
  }): Promise<TransferSummary> {
    this.assertActive();
    this.assertTrusted();
    const operation = new OperationCancellation();
    this.activeOperations.add(operation);
    const cancellation = combineCancellation(input.cancellation, operation);
    try {
      const plan = await this.planWorkspaceItems({ ...input, cancellation });
      return await this.host.window.withProgress(
        {
          location: this.host.ProgressLocation.Notification,
          title: 'Uploading workspace items',
          cancellable: true,
        },
        async (progress, progressToken) =>
          this.execute(plan, combineCancellation(cancellation, progressToken), progress),
      );
    } finally {
      this.activeOperations.delete(operation);
      if (this.activeOperations.size === 0) {
        for (const listener of [...this.drainListeners]) listener();
        this.drainListeners.clear();
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const operation of this.activeOperations) operation.cancel();
    if (this.activeOperations.size > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        this.drainListeners.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.commitListeners.clear();
  }

  private async execute(
    plan: UploadPlan,
    cancellation: CancellationTokenLike,
    progress: { report(value: { message?: string; increment?: number }): void },
  ): Promise<TransferSummary> {
    const summary: MutableSummary = {
      uploaded: 0,
      createdDirectories: 0,
      mergedDirectories: 0,
      skipped: [...plan.skippedUnsupported],
      skippedLinks: [...plan.skippedLinks],
      failed: [],
      cancelled: false,
      cleanupWarnings: [],
      completedFiles: 0,
      bytesTransferred: 0,
      bytesAccurate: plan.totalBytes !== undefined,
    };
    const conflicts: ConflictState = {
      fileOverwriteAll: false,
      fileSkipAll: false,
      directoryMergeAll: false,
      directorySkipAll: false,
    };
    const skippedDirectories = new Set<string>();
    const locks = new Map<string, Promise<void>>();
    let promptTail = Promise.resolve();
    const prompt = async <T>(task: () => PromiseLike<T>): Promise<T> => {
      const previous = promptTail;
      let release!: () => void;
      promptTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await task();
      } finally {
        release();
      }
    };
    const withPathLock = async <T>(path: string, task: () => Promise<T>): Promise<T> => {
      const previous = locks.get(path) ?? Promise.resolve();
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.set(
        path,
        previous.then(() => done),
      );
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (locks.get(path) === done) locks.delete(path);
      }
    };

    const lease = await this.pool.acquire(plan.connectionId, cancellation, 'background');
    try {
      // This preflight is advisory only; every mutation is checked again below.
      for (const entry of plan.entries) {
        checkCancelled(cancellation);
        await statOrUndefined(lease.client, entry.targetPath);
      }
      const directories = plan.entries.filter(
        (entry): entry is Extract<UploadPlanEntry, { kind: 'directory' }> =>
          entry.kind === 'directory',
      );
      for (const directory of directories) {
        if (cancellation.isCancellationRequested) {
          summary.cancelled = true;
          break;
        }
        if (isSkippedPath(directory.targetPath, skippedDirectories)) continue;
        try {
          await withPathLock(directory.targetPath, async () => {
            const result = await this.ensureRemoteDirectory(
              lease.client,
              directory.targetPath,
              conflicts,
              cancellation,
              prompt,
            );
            if (result === 'created') {
              summary.createdDirectories += 1;
              this.reportCommit(plan.connectionId, directory.targetPath, 'created');
            } else if (result === 'merged') {
              summary.mergedDirectories += 1;
            } else if (result === 'skip') {
              skippedDirectories.add(directory.targetPath);
              summary.skipped.push({
                path: relativeUploadPath(plan.targetDirectory, directory.targetPath),
                reason: 'Destination directory was skipped.',
              });
            } else {
              summary.cancelled = true;
            }
          });
        } catch (error) {
          if (isCancellation(error)) {
            summary.cancelled = true;
            break;
          }
          summary.failed.push({
            path: relativeUploadPath(plan.targetDirectory, directory.targetPath),
            reason: errorMessage(error, 'Unable to create remote directory.'),
          });
          skippedDirectories.add(directory.targetPath);
        }
      }
      if (!summary.cancelled) {
        const files = plan.entries.filter(
          (entry): entry is Extract<UploadPlanEntry, { kind: 'file' }> => entry.kind === 'file',
        );
        let next = 0;
        const worker = async (): Promise<void> => {
          while (!summary.cancelled && !cancellation.isCancellationRequested) {
            const index = next;
            next += 1;
            const file = files[index];
            if (!file) return;
            if (isSkippedPath(posix.dirname(file.targetPath), skippedDirectories)) {
              summary.skipped.push({
                path: relativeUploadPath(plan.targetDirectory, file.targetPath),
                reason: 'A parent destination directory was skipped.',
              });
              continue;
            }
            try {
              await withPathLock(file.targetPath, async () => {
                const outcome = await this.uploadFile(
                  plan,
                  file,
                  lease.client,
                  conflicts,
                  cancellation,
                  prompt,
                  summary,
                );
                if (outcome === 'uploaded') {
                  summary.uploaded += 1;
                  summary.completedFiles += 1;
                  progress.report({ message: progressMessage(plan, file, summary) });
                } else if (outcome === 'skip') {
                  summary.skipped.push({
                    path: relativeUploadPath(plan.targetDirectory, file.targetPath),
                    reason: 'Destination file was skipped.',
                  });
                } else if (outcome === 'cancel') {
                  summary.cancelled = true;
                }
              });
            } catch (error) {
              if (isCancellation(error) || cancellation.isCancellationRequested) {
                summary.cancelled = true;
                return;
              }
              summary.failed.push({
                path: relativeUploadPath(plan.targetDirectory, file.targetPath),
                reason: errorMessage(error, 'Unable to upload workspace file.'),
              });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, files.length) }, worker));
        if (cancellation.isCancellationRequested) summary.cancelled = true;
      }
    } finally {
      await lease[Symbol.asyncDispose]();
    }
    return freezeSummary(plan, summary);
  }

  private async ensureRemoteDirectory(
    client: SftpClient,
    path: string,
    conflicts: ConflictState,
    cancellation: CancellationTokenLike,
    prompt: <T>(task: () => PromiseLike<T>) => Promise<T>,
  ): Promise<'created' | 'merged' | 'skip' | 'cancel'> {
    checkCancelled(cancellation);
    let existing = await statOrUndefined(client, path);
    if (!existing) {
      try {
        await client.mkdir(path);
        return 'created';
      } catch (error) {
        if (!(error instanceof EasySshError) || error.code !== 'ALREADY_EXISTS') throw error;
        existing = await statOrUndefined(client, path);
      }
    }
    if (!existing) throw new EasySshError('REMOTE_IO', `Remote directory '${path}' disappeared.`);
    if (existing.kind !== 'directory') return this.typeConflict(path, prompt, cancellation);
    if (conflicts.directorySkipAll) return 'skip';
    if (conflicts.directoryMergeAll) return 'merged';
    const choice = await prompt(() =>
      this.host.window.showWarningMessage(
        `Remote directory '${path}' already exists.`,
        { modal: true },
        'Merge',
        'Merge All',
        'Skip',
        'Skip All',
        'Cancel',
      ),
    );
    if (choice === 'Merge All') {
      conflicts.directoryMergeAll = true;
      return 'merged';
    }
    if (choice === 'Merge') return 'merged';
    if (choice === 'Skip All') {
      conflicts.directorySkipAll = true;
      return 'skip';
    }
    if (choice === 'Skip') return 'skip';
    return 'cancel';
  }

  private async uploadFile(
    plan: UploadPlan,
    file: Extract<UploadPlanEntry, { kind: 'file' }>,
    client: SftpClient,
    conflicts: ConflictState,
    cancellation: CancellationTokenLike,
    prompt: <T>(task: () => PromiseLike<T>) => Promise<T>,
    summary: MutableSummary,
  ): Promise<'uploaded' | 'skip' | 'cancel'> {
    checkCancelled(cancellation);
    const decision = await this.fileDecision(
      client,
      file.targetPath,
      conflicts,
      cancellation,
      prompt,
    );
    if (decision === 'cancel' || decision === 'skip') return decision;
    const freshDecision = async (): Promise<'write' | 'overwrite' | 'skip' | 'cancel'> => {
      const current = await statOrUndefined(client, file.targetPath);
      if (!current) return 'write';
      if (current.kind !== 'file') return this.typeConflict(file.targetPath, prompt, cancellation);
      // An already-approved overwrite remains valid after the required fresh lstat.
      // If a previously missing destination appeared, ask exactly once at that point.
      return decision === 'overwrite'
        ? 'overwrite'
        : this.fileDecision(client, file.targetPath, conflicts, cancellation, prompt);
    };
    let fresh: vscode.FileStat;
    try {
      fresh = await this.host.workspace.fs.stat(file.source);
    } catch (error) {
      throw workspaceProviderError(file.source, error);
    }
    if (workspaceKind(fresh.type, this.host.FileType) !== 'file') {
      throw new EasySshError(
        'CONFLICT',
        'The selected workspace source changed type before upload.',
      );
    }
    if (fresh.size !== file.size) summary.bytesAccurate = false;
    const sourceSize = fresh.size;
    let written: number;
    if (file.source.scheme === 'file' && client.createWriteStream) {
      try {
        written = await this.atomicStream(
          client,
          file.targetPath,
          createReadStream(file.source.fsPath),
          sourceSize,
          decision === 'overwrite',
          cancellation,
          freshDecision,
          summary,
        );
      } catch (error) {
        if (error instanceof UploadDecisionError) return error.outcome;
        throw error;
      }
    } else {
      const maximum = Math.floor(this.options.maxBufferedTransferMiB() * 1024 * 1024);
      if (!Number.isSafeInteger(sourceSize) || sourceSize < 0 || sourceSize > maximum) {
        const location =
          file.source.scheme === 'file' ? 'This SFTP adapter' : 'Virtual workspace files';
        throw new EasySshError(
          'OUTPUT_LIMIT',
          `${location} above ${this.options.maxBufferedTransferMiB()} MiB cannot be buffered for upload.`,
        );
      }
      let data: Uint8Array;
      try {
        data = await this.host.workspace.fs.readFile(file.source);
      } catch (error) {
        throw workspaceProviderError(file.source, error);
      }
      if (data.byteLength !== sourceSize) summary.bytesAccurate = false;
      try {
        written = await this.atomicBytes(
          client,
          file.targetPath,
          data,
          decision === 'overwrite',
          cancellation,
          freshDecision,
          summary,
        );
      } catch (error) {
        if (error instanceof UploadDecisionError) return error.outcome;
        throw error;
      }
    }
    summary.bytesTransferred += written;
    this.reportCommit(
      plan.connectionId,
      file.targetPath,
      decision === 'overwrite' ? 'changed' : 'created',
    );
    return 'uploaded';
  }

  private async fileDecision(
    client: SftpClient,
    targetPath: string,
    conflicts: ConflictState,
    cancellation: CancellationTokenLike,
    prompt: <T>(task: () => PromiseLike<T>) => Promise<T>,
  ): Promise<'write' | 'overwrite' | 'skip' | 'cancel'> {
    checkCancelled(cancellation);
    const existing = await statOrUndefined(client, targetPath);
    if (!existing) return 'write';
    if (existing.kind !== 'file') return this.typeConflict(targetPath, prompt, cancellation);
    if (conflicts.fileSkipAll) return 'skip';
    if (conflicts.fileOverwriteAll) return 'overwrite';
    const choice = await prompt(() =>
      this.host.window.showWarningMessage(
        `Remote file '${targetPath}' already exists.`,
        { modal: true },
        'Overwrite',
        'Overwrite All',
        'Skip',
        'Skip All',
        'Cancel',
      ),
    );
    if (choice === 'Overwrite All') {
      conflicts.fileOverwriteAll = true;
      return 'overwrite';
    }
    if (choice === 'Overwrite') return 'overwrite';
    if (choice === 'Skip All') {
      conflicts.fileSkipAll = true;
      return 'skip';
    }
    if (choice === 'Skip') return 'skip';
    return 'cancel';
  }

  private async typeConflict(
    path: string,
    prompt: <T>(task: () => PromiseLike<T>) => Promise<T>,
    cancellation: CancellationTokenLike,
  ): Promise<'skip' | 'cancel'> {
    checkCancelled(cancellation);
    const choice = await prompt(() =>
      this.host.window.showWarningMessage(
        `Remote destination '${path}' has a different item type and will not be replaced.`,
        { modal: true },
        'Skip',
        'Cancel',
      ),
    );
    return choice === 'Skip' ? 'skip' : 'cancel';
  }

  private async atomicBytes(
    client: SftpClient,
    target: string,
    data: Uint8Array,
    overwrite: boolean,
    cancellation: CancellationTokenLike,
    freshDecision: () => Promise<'write' | 'overwrite' | 'skip' | 'cancel'>,
    summary: MutableSummary,
  ): Promise<number> {
    const temp = await this.writeTemporaryBytes(client, target, data, cancellation, summary);
    let committed = false;
    try {
      const stat = await client.stat(temp);
      if (stat.kind !== 'file' || stat.size !== data.byteLength) {
        throw new EasySshError(
          'REMOTE_IO',
          `Temporary upload verification failed for '${target}'.`,
        );
      }
      checkCancelled(cancellation);
      const decision = await freshDecision();
      if (decision === 'skip' || decision === 'cancel') throw new UploadDecisionError(decision);
      await client.rename(temp, target, decision === 'overwrite' || overwrite);
      committed = true;
      const final = await client.stat(target);
      if (final.kind !== 'file' || final.size !== data.byteLength) {
        throw new EasySshError('REMOTE_IO', `Remote upload verification failed for '${target}'.`);
      }
      return data.byteLength;
    } finally {
      if (!committed) await this.cleanupTemp(client, temp, summary);
    }
  }

  private async atomicStream(
    client: SftpClient,
    target: string,
    source: Readable,
    expectedSize: number,
    overwrite: boolean,
    cancellation: CancellationTokenLike,
    freshDecision: () => Promise<'write' | 'overwrite' | 'skip' | 'cancel'>,
    summary: MutableSummary,
  ): Promise<number> {
    const temp = await this.reserveStreamTemporary(client, target, cancellation, summary);
    let committed = false;
    try {
      const destination = client.createWriteStream?.(temp, { create: true, overwrite: true });
      if (!destination) {
        throw new EasySshError(
          'UNSUPPORTED',
          'Streaming upload is not available for this SFTP connection.',
        );
      }
      const written = await copyStream(source, destination, cancellation);
      const stat = await client.stat(temp);
      if (stat.kind !== 'file' || stat.size !== written) {
        throw new EasySshError(
          'REMOTE_IO',
          `Temporary upload verification failed for '${target}'.`,
        );
      }
      if (written !== expectedSize) summary.bytesAccurate = false;
      checkCancelled(cancellation);
      const decision = await freshDecision();
      if (decision === 'skip' || decision === 'cancel') throw new UploadDecisionError(decision);
      await client.rename(temp, target, decision === 'overwrite' || overwrite);
      committed = true;
      const final = await client.stat(target);
      if (final.kind !== 'file' || final.size !== written) {
        throw new EasySshError('REMOTE_IO', `Remote upload verification failed for '${target}'.`);
      }
      return written;
    } finally {
      if (!committed) {
        source.destroy();
        await this.cleanupTemp(client, temp, summary);
      }
    }
  }

  private async writeTemporaryBytes(
    client: SftpClient,
    target: string,
    data: Uint8Array,
    cancellation: CancellationTokenLike,
    summary: MutableSummary,
  ): Promise<string> {
    const directory = posix.dirname(target);
    const basename = posix.basename(target);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      checkCancelled(cancellation);
      const temp = posix.join(directory, `.${basename}.easyssh-upload-${randomUUID()}`);
      try {
        await client.writeFile(temp, data, { create: true, overwrite: false });
        return temp;
      } catch (error) {
        // An exclusive-create collision belongs to another operation; never
        // remove that operation's temporary artifact.
        if (error instanceof EasySshError && error.code === 'ALREADY_EXISTS') continue;
        await this.cleanupTemp(client, temp, summary);
        throw error;
      }
    }
    throw new EasySshError(
      'ALREADY_EXISTS',
      `Unable to allocate a temporary upload for '${target}'.`,
    );
  }

  private async reserveStreamTemporary(
    client: SftpClient,
    target: string,
    cancellation: CancellationTokenLike,
    summary: MutableSummary,
  ): Promise<string> {
    const directory = posix.dirname(target);
    const basename = posix.basename(target);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      checkCancelled(cancellation);
      const temp = posix.join(directory, `.${basename}.easyssh-upload-${randomUUID()}`);
      try {
        // Reserve ownership first. A later stream failure can now clean only
        // a temp created by this operation, never another client's collision.
        await client.writeFile(temp, new Uint8Array(), { create: true, overwrite: false });
        return temp;
      } catch (error) {
        if (error instanceof EasySshError && error.code === 'ALREADY_EXISTS') continue;
        await this.cleanupTemp(client, temp, summary);
        throw error;
      }
    }
    throw new EasySshError(
      'ALREADY_EXISTS',
      `Unable to allocate a temporary upload for '${target}'.`,
    );
  }

  private async cleanupTemp(
    client: SftpClient,
    temp: string,
    summary: MutableSummary,
  ): Promise<void> {
    try {
      await client.unlink(temp);
    } catch (error) {
      if (!(error instanceof EasySshError) || error.code !== 'NOT_FOUND') {
        summary.cleanupWarnings.push(`Could not clean temporary remote file '${temp}'.`);
      }
    }
  }

  private reportCommit(connectionId: string, path: string, type: 'created' | 'changed'): void {
    this.cache.invalidatePath(connectionId, path);
    this.cache.invalidateParent(connectionId, path);
    const uri = this.codec.create(connectionId, path);
    this.reporter.emitMutationChanges([
      { type, uri },
      { type: 'changed', uri: this.codec.create(connectionId, posix.dirname(path)) },
    ]);
    for (const listener of [...this.commitListeners]) listener({ connectionId, path });
  }

  private assertTrusted(): void {
    if (!this.host.workspace.isTrusted) {
      throw new EasySshError(
        'WORKSPACE_UNTRUSTED',
        'Workspace uploads are disabled until this workspace is trusted.',
      );
    }
  }

  private assertActive(): void {
    if (this.disposed)
      throw new EasySshError('CANCELLED', 'Workspace upload service is shutting down.');
  }
}

export function validateWorkspaceDragPayload(value: unknown): WorkspaceDragPayload {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'type') ||
    !Object.prototype.hasOwnProperty.call(value, 'uris') ||
    (value as { type?: unknown }).type !== 'workspace-items' ||
    !Array.isArray((value as { uris?: unknown }).uris)
  ) {
    throw new EasySshError('VALIDATION', 'Invalid workspace drag payload.');
  }
  const uris = (value as { uris: unknown[] }).uris;
  if (
    uris.length === 0 ||
    uris.length > MAX_WORKSPACE_DRAG_ITEMS ||
    uris.some((uri) => typeof uri !== 'string' || uri.length === 0 || uri.length > 8_192)
  ) {
    throw new EasySshError('VALIDATION', 'Invalid workspace drag payload.');
  }
  if (new Set(uris).size !== uris.length) {
    throw new EasySshError('VALIDATION', 'Duplicate workspace drag items are not allowed.');
  }
  return { type: 'workspace-items', uris: [...uris] as string[] };
}

function workspaceKind(
  type: vscode.FileType,
  FileType: typeof vscode.FileType,
): WorkspaceEntryView['kind'] {
  if ((type & FileType.SymbolicLink) !== 0) return 'symbolicLink';
  if ((type & FileType.Directory) !== 0) return 'directory';
  if ((type & FileType.File) !== 0) return 'file';
  return 'other';
}

function isDirectory(type: vscode.FileType, FileType: typeof vscode.FileType): boolean {
  return workspaceKind(type, FileType) === 'directory';
}

function isSafeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function containsUri(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) return false;
  const rootPath =
    root.path.endsWith('/') && root.path !== '/' ? root.path.slice(0, -1) : root.path;
  return (
    candidate.path === rootPath ||
    (rootPath === '/' ? candidate.path.startsWith('/') : candidate.path.startsWith(`${rootPath}/`))
  );
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return (
    left.scheme === right.scheme &&
    left.authority === right.authority &&
    left.path === right.path &&
    left.query === right.query &&
    left.fragment === right.fragment
  );
}

function unsafeUriText(value: string): boolean {
  return value.includes('\0') || /%(?:2f|5c|00)/i.test(value);
}

function deduplicateUris(values: readonly vscode.Uri[]): readonly vscode.Uri[] {
  const sorted = [...new Map(values.map((uri) => [uri.toString(), uri])).values()].sort(
    (left, right) => left.path.length - right.path.length,
  );
  return sorted.filter(
    (candidate, index) =>
      !sorted.slice(0, index).some((ancestor) => containsUri(ancestor, candidate)),
  );
}

function hasAncestorSelection(values: readonly vscode.Uri[]): boolean {
  return values.some((candidate, index) =>
    values.some((other, otherIndex) => index !== otherIndex && containsUri(candidate, other)),
  );
}

function uriBasename(uri: vscode.Uri): string {
  return uri.path.split('/').filter(Boolean).at(-1) ?? '';
}

function containedRemoteTarget(targetDirectory: string, segments: readonly string[]): string {
  if (segments.length === 0 || segments.some((segment) => !isSafeSegment(segment))) {
    throw new EasySshError('VALIDATION', 'Upload paths must contain safe relative segments.');
  }
  const target = normalizeRemotePath(posix.join(targetDirectory, ...segments));
  if (
    target !== targetDirectory &&
    !(targetDirectory === '/' ? target.startsWith('/') : target.startsWith(`${targetDirectory}/`))
  ) {
    throw new EasySshError(
      'VALIDATION',
      'Derived upload target escaped the selected remote directory.',
    );
  }
  return target;
}

function addScanned(scanned: number, maximum: number): number {
  const next = scanned + 1;
  if (next > maximum) {
    throw new EasySshError(
      'OUTPUT_LIMIT',
      `Upload exceeds the ${maximum.toLocaleString()} entry limit.`,
    );
  }
  return next;
}

function isKnownSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0;
}

function comparePlanEntries(left: UploadPlanEntry, right: UploadPlanEntry): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  if (left.kind === 'directory') {
    const depth = left.targetPath.split('/').length - right.targetPath.split('/').length;
    if (depth !== 0) return depth;
  }
  return left.targetPath.localeCompare(right.targetPath);
}

async function statOrUndefined(client: SftpClient, path: string) {
  try {
    return await client.lstat(path);
  } catch (error) {
    if (error instanceof EasySshError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

function isSkippedPath(path: string, skipped: ReadonlySet<string>): boolean {
  return [...skipped].some((root) => path === root || path.startsWith(`${root}/`));
}

function relativeUploadPath(root: string, path: string): string {
  return root === '/' ? path.slice(1) : path.slice(root.length + 1);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof EasySshError ? error.message : fallback;
}

function workspaceProviderError(uri: vscode.Uri, error: unknown): EasySshError {
  if (error instanceof EasySshError) return error;
  return new EasySshError('REMOTE_IO', `Workspace resource '${uri.path}' is unavailable.`, error);
}

function checkCancelled(token: CancellationTokenLike): void {
  if (token.isCancellationRequested)
    throw new EasySshError('CANCELLED', 'Workspace upload cancelled.');
}

function neverCancelled(): CancellationTokenLike {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function combineCancellation(
  first: CancellationTokenLike,
  second: CancellationTokenLike,
): CancellationTokenLike {
  return {
    get isCancellationRequested() {
      return first.isCancellationRequested || second.isCancellationRequested;
    },
    onCancellationRequested: (listener) => {
      const left = first.onCancellationRequested(listener);
      const right = second.onCancellationRequested(listener);
      return {
        dispose: () => {
          left.dispose();
          right.dispose();
        },
      };
    },
  };
}

class OperationCancellation implements CancellationTokenLike {
  private cancelled = false;
  private readonly listeners = new Set<() => unknown>();

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  readonly onCancellationRequested = (listener: () => unknown): { dispose(): void } => {
    if (this.cancelled) {
      listener();
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

async function copyStream(
  source: Readable,
  destination: Writable,
  cancellation: CancellationTokenLike,
): Promise<number> {
  let bytes = 0;
  let failure: EasySshError | undefined;
  const onError = (error: Error): void => {
    failure = new EasySshError('REMOTE_IO', 'Local or remote upload stream failed.', error);
  };
  destination.once('error', onError);
  const subscription = cancellation.onCancellationRequested(() => {
    source.destroy();
    destination.destroy();
  });
  try {
    for await (const chunk of source) {
      checkCancelled(cancellation);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (!destination.write(buffer)) {
        await once(destination, 'drain');
      }
      if (failure) throw failure;
    }
    checkCancelled(cancellation);
    destination.end();
    await Promise.race([once(destination, 'finish'), once(destination, 'close')]);
    if (failure) throw failure;
    return bytes;
  } catch (error) {
    if (isCancellation(error) || cancellation.isCancellationRequested) {
      throw new EasySshError('CANCELLED', 'Workspace upload cancelled.');
    }
    throw error;
  } finally {
    subscription.dispose();
    destination.removeListener('error', onError);
  }
}

function progressMessage(
  plan: UploadPlan,
  file: Extract<UploadPlanEntry, { kind: 'file' }>,
  summary: MutableSummary,
): string {
  const prefix = `${summary.completedFiles}/${plan.totalFiles}: ${relativeUploadPath(plan.targetDirectory, file.targetPath)}`;
  if (!summary.bytesAccurate || plan.totalBytes === undefined) return prefix;
  return `${prefix} (${summary.bytesTransferred}/${plan.totalBytes} bytes)`;
}

function freezeSummary(plan: UploadPlan, summary: MutableSummary): TransferSummary {
  return Object.freeze({
    operationId: plan.operationId,
    uploaded: summary.uploaded,
    createdDirectories: summary.createdDirectories,
    mergedDirectories: summary.mergedDirectories,
    skipped: Object.freeze([...summary.skipped]),
    skippedLinks: Object.freeze([...summary.skippedLinks]),
    failed: Object.freeze([...summary.failed]),
    cancelled: summary.cancelled,
    cleanupWarnings: Object.freeze([...summary.cleanupWarnings]),
    completedFiles: summary.completedFiles,
    totalFiles: plan.totalFiles,
    bytesTransferred: summary.bytesTransferred,
    bytesAccurate: summary.bytesAccurate,
  });
}
