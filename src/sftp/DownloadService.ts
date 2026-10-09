import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import * as fs from 'node:fs/promises';
import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError, isCancellation } from '../common/errors';
import type { ConnectionId } from '../connections/types';
import { normalizeRemotePath } from './SftpUriCodec';
import type { SftpConnectionPool } from './ports';

export type LocalConflictDecision = 'overwrite' | 'overwriteAll' | 'skip' | 'skipAll' | 'cancel';

export interface DownloadPlanItem {
  readonly sourcePath: string;
  readonly destination: vscode.Uri;
  readonly kind: 'file' | 'directory' | 'symbolicLink';
}

interface PlannedDownload extends DownloadPlanItem {
  readonly relativePath: string;
  readonly size: number;
}

export interface DownloadPlan {
  readonly destinationRoot: vscode.Uri;
  readonly items: readonly PlannedDownload[];
  readonly totalBytes: number;
}

export interface DownloadSummary {
  readonly planned: number;
  readonly completed: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly failed: readonly { readonly path: string; readonly message: string }[];
  readonly cancelled: boolean;
  readonly bytesTransferred: number;
  readonly cleanupFailures: readonly string[];
}

export interface DownloadOptions {
  readonly maxEntries?: number;
  readonly maxBufferedTransferMiB: () => number;
  readonly chunkBytes?: number;
  /** Injectable for platform-specific preflight tests. Defaults to the extension host platform. */
  readonly platform?: NodeJS.Platform;
}

interface DownloadHost {
  readonly Uri: typeof vscode.Uri;
  readonly FileType: typeof vscode.FileType;
  readonly ProgressLocation: typeof vscode.ProgressLocation;
  readonly workspace: Pick<typeof vscode.workspace, 'fs'>;
  readonly window: Pick<
    typeof vscode.window,
    'showOpenDialog' | 'showWarningMessage' | 'showInformationMessage' | 'withProgress'
  >;
}

/** Safe host-side remote download service. Webviews only request remote source paths. */
export class DownloadService {
  private readonly maxEntries: number;
  private readonly chunkBytes: number;

  constructor(
    private readonly host: DownloadHost,
    private readonly pool: SftpConnectionPool,
    private readonly options: DownloadOptions,
  ) {
    this.maxEntries = options.maxEntries ?? 100_000;
    this.chunkBytes = options.chunkBytes ?? 256 * 1024;
  }

  async chooseAndDownload(
    connectionId: ConnectionId,
    sources: readonly string[],
  ): Promise<DownloadSummary> {
    const selected = await this.host.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Download Here',
    });
    if (!selected?.[0])
      throw new EasySshError('CANCELLED', 'No download destination was selected.');
    const plan = await this.preflight(connectionId, sources, selected[0]);
    return this.run(connectionId, plan);
  }

  async preflight(
    connectionId: ConnectionId,
    sources: readonly string[],
    destinationRoot: vscode.Uri,
  ): Promise<DownloadPlan> {
    if (sources.length === 0)
      throw new EasySshError('VALIDATION', 'Select at least one remote item.');
    const roots = [...new Set(sources.map((source) => normalizeRemotePath(source)))];
    const items: PlannedDownload[] = [];
    let totalBytes = 0;
    const lease = await this.pool.acquire(connectionId, undefined, 'background');
    try {
      for (const root of roots) {
        const rootName = posix.basename(root);
        if (!isSafeRelativeSegment(rootName)) {
          throw new EasySshError('VALIDATION', 'The selected remote root has an unsafe name.');
        }
        const rootStat = await lease.client.lstat(root);
        const rootDestination = safeDestination(this.host.Uri, destinationRoot, [rootName]);
        if (rootStat.kind === 'symbolicLink') {
          addPlan(items, this.maxEntries, {
            sourcePath: root,
            destination: rootDestination,
            kind: 'symbolicLink',
            relativePath: rootName,
            size: rootStat.size,
          });
          continue;
        }
        const canonical = normalizeRemotePath(await lease.client.realpath(root));
        if (canonical !== root) {
          throw new EasySshError(
            'VALIDATION',
            `Remote source '${root}' resolves through a link and cannot be downloaded safely.`,
          );
        }
        if (rootStat.kind === 'file') {
          addPlan(items, this.maxEntries, {
            sourcePath: root,
            destination: rootDestination,
            kind: 'file',
            relativePath: rootName,
            size: rootStat.size,
          });
          totalBytes += rootStat.size;
          continue;
        }
        if (rootStat.kind !== 'directory') {
          throw new EasySshError('UNSUPPORTED', `Remote item '${root}' cannot be downloaded.`);
        }
        addPlan(items, this.maxEntries, {
          sourcePath: root,
          destination: rootDestination,
          kind: 'directory',
          relativePath: rootName,
          size: 0,
        });
        const pending: { readonly sourcePath: string; readonly segments: readonly string[] }[] = [
          { sourcePath: root, segments: [rootName] },
        ];
        while (pending.length > 0) {
          const current = pending.pop();
          if (!current) break;
          const children = await lease.client.readDirectory(current.sourcePath);
          for (const child of children) {
            if (child.name === '.' || child.name === '..') continue;
            if (!isSafeRelativeSegment(child.name)) {
              throw new EasySshError(
                'REMOTE_IO',
                'The server returned an unsafe directory entry name.',
              );
            }
            const sourcePath = normalizeRemotePath(posix.join(current.sourcePath, child.name));
            const destination = safeDestination(this.host.Uri, destinationRoot, [
              ...current.segments,
              child.name,
            ]);
            // lstat makes a symlink an explicit, skipped leaf even if readdir statistics lie.
            const stat = await lease.client.lstat(sourcePath);
            const relativePath = [...current.segments, child.name].join('/');
            if (stat.kind === 'symbolicLink') {
              addPlan(items, this.maxEntries, {
                sourcePath,
                destination,
                kind: 'symbolicLink',
                relativePath,
                size: stat.size,
              });
              continue;
            }
            if (stat.kind === 'file') {
              addPlan(items, this.maxEntries, {
                sourcePath,
                destination,
                kind: 'file',
                relativePath,
                size: stat.size,
              });
              totalBytes += stat.size;
              continue;
            }
            if (stat.kind === 'directory') {
              addPlan(items, this.maxEntries, {
                sourcePath,
                destination,
                kind: 'directory',
                relativePath,
                size: 0,
              });
              pending.push({ sourcePath, segments: [...current.segments, child.name] });
              continue;
            }
            throw new EasySshError(
              'UNSUPPORTED',
              `Remote item '${sourcePath}' cannot be downloaded.`,
            );
          }
        }
      }
    } finally {
      await lease[Symbol.asyncDispose]();
    }
    if (
      (this.options.platform ?? process.platform) === 'win32' &&
      destinationRoot.scheme === 'file'
    ) {
      validateWindowsDestinations(items);
    }
    return { destinationRoot, items, totalBytes };
  }

  private async run(connectionId: ConnectionId, plan: DownloadPlan): Promise<DownloadSummary> {
    return this.host.window.withProgress(
      {
        location: this.host.ProgressLocation.Notification,
        title: 'Downloading remote files',
        cancellable: true,
      },
      async (progress, token) => {
        const summary: MutableSummary = {
          planned: plan.items.length,
          completed: 0,
          skipped: [],
          failed: [],
          cancelled: false,
          bytesTransferred: 0,
          cleanupFailures: [],
        };
        const decisions: ConflictState = { overwriteAll: false, skipAll: false };
        const skippedTrees = new Set<string>();
        const lease = await this.pool.acquire(connectionId, undefined, 'background');
        try {
          for (const item of plan.items) {
            if (token.isCancellationRequested) {
              summary.cancelled = true;
              break;
            }
            if (isSkippedTree(item.sourcePath, skippedTrees)) {
              summary.skipped.push({
                path: item.relativePath,
                reason: 'Parent directory was skipped.',
              });
              continue;
            }
            progress.report({
              message: `${summary.completed + 1}/${plan.items.length}: ${item.relativePath}`,
            });
            if (item.kind === 'symbolicLink') {
              summary.skipped.push({
                path: item.relativePath,
                reason: 'Symbolic links are not downloaded.',
              });
              continue;
            }
            try {
              if (item.kind === 'directory') {
                const directory = await this.ensureDirectory(item.destination);
                if (directory === 'skip') {
                  skippedTrees.add(item.sourcePath);
                  summary.skipped.push({
                    path: item.relativePath,
                    reason: 'Destination is not a mergeable directory.',
                  });
                } else {
                  summary.completed += 1;
                }
                continue;
              }
              const decision = await this.conflictDecision(item.destination, decisions);
              if (decision === 'cancel') {
                summary.cancelled = true;
                break;
              }
              if (decision === 'skip') {
                summary.skipped.push({
                  path: item.relativePath,
                  reason: 'Existing destination was skipped.',
                });
                continue;
              }
              const transferred =
                item.destination.scheme === 'file'
                  ? await this.streamToLocalFile(
                      lease.client,
                      item,
                      token,
                      decision === 'overwrite',
                      summary,
                    )
                  : await this.bufferToVirtualFile(
                      lease.client,
                      item,
                      token,
                      decision === 'overwrite',
                    );
              summary.bytesTransferred += transferred;
              summary.completed += 1;
              progress.report({
                message: `${summary.completed}/${plan.items.length}: ${item.relativePath}`,
                ...(plan.totalBytes > 0
                  ? { increment: (transferred / plan.totalBytes) * 100 }
                  : {}),
              });
            } catch (error) {
              if (isCancellation(error) || token.isCancellationRequested) {
                summary.cancelled = true;
                break;
              }
              summary.failed.push({
                path: item.relativePath,
                message:
                  error instanceof EasySshError
                    ? error.message
                    : error instanceof Error
                      ? error.message
                      : 'Download failed.',
              });
            }
          }
        } finally {
          await lease[Symbol.asyncDispose]();
        }
        return freezeSummary(summary);
      },
    );
  }

  private async ensureDirectory(destination: vscode.Uri): Promise<'created' | 'merged' | 'skip'> {
    const existing = await statOrUndefined(this.host.workspace.fs, destination);
    if (!existing) {
      await this.host.workspace.fs.createDirectory(destination);
      return 'created';
    }
    return (existing.type & this.host.FileType.Directory) !== 0 ? 'merged' : 'skip';
  }

  private async conflictDecision(
    destination: vscode.Uri,
    state: ConflictState,
  ): Promise<'write' | 'overwrite' | 'skip' | 'cancel'> {
    const existing = await statOrUndefined(this.host.workspace.fs, destination);
    if (!existing) return 'write';
    if ((existing.type & this.host.FileType.Directory) !== 0) return 'skip';
    if (state.skipAll) return 'skip';
    if (state.overwriteAll) return 'overwrite';
    const choice = await this.host.window.showWarningMessage(
      `A downloaded file already exists at '${destination.fsPath || destination.path}'.`,
      { modal: true },
      'Overwrite',
      'Overwrite All',
      'Skip',
      'Skip All',
      'Cancel',
    );
    if (choice === 'Overwrite All') {
      state.overwriteAll = true;
      return 'overwrite';
    }
    if (choice === 'Overwrite') return 'overwrite';
    if (choice === 'Skip All') {
      state.skipAll = true;
      return 'skip';
    }
    if (choice === 'Skip') return 'skip';
    return 'cancel';
  }

  private async streamToLocalFile(
    client: import('./ports').SftpClient,
    item: PlannedDownload,
    token: vscode.CancellationToken,
    overwriteAuthorized: boolean,
    summary: MutableSummary,
  ): Promise<number> {
    const destinationPath = item.destination.fsPath;
    const tempPath = join(
      dirname(destinationPath),
      `.${basename(destinationPath)}.easyssh-download-${randomUUID()}`,
    );
    let temporaryKnown = true;
    try {
      const handle = await fs.open(tempPath, 'wx');
      try {
        let offset = 0;
        while (offset < item.size) {
          if (token.isCancellationRequested)
            throw new EasySshError('CANCELLED', 'Download cancelled.');
          const data = await client.readFile(item.sourcePath, {
            offset,
            length: Math.min(this.chunkBytes, item.size - offset),
          });
          if (data.byteLength === 0) {
            throw new EasySshError(
              'REMOTE_IO',
              `Remote file '${item.sourcePath}' ended unexpectedly.`,
            );
          }
          await handle.write(data);
          offset += data.byteLength;
        }
      } finally {
        await handle.close();
      }
      if (token.isCancellationRequested) throw new EasySshError('CANCELLED', 'Download cancelled.');
      const current = await statOrUndefined(this.host.workspace.fs, item.destination);
      if (current && (current.type & this.host.FileType.Directory) !== 0) {
        throw new EasySshError(
          'CONFLICT',
          'A destination directory cannot be replaced by a downloaded file.',
        );
      }
      if (current && !overwriteAuthorized) {
        throw new EasySshError(
          'CONFLICT',
          'The destination appeared after conflict authorization.',
        );
      }
      await fs.rename(tempPath, destinationPath);
      temporaryKnown = false;
      return item.size;
    } finally {
      if (temporaryKnown) {
        try {
          await fs.rm(tempPath, { force: true });
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'Unknown cleanup error.';
          summary.cleanupFailures.push(`${tempPath}: ${detail}`);
        }
      }
    }
  }

  private async bufferToVirtualFile(
    client: import('./ports').SftpClient,
    item: PlannedDownload,
    token: vscode.CancellationToken,
    overwriteAuthorized: boolean,
  ): Promise<number> {
    const maximum = this.options.maxBufferedTransferMiB() * 1024 * 1024;
    if (item.size > maximum) {
      throw new EasySshError(
        'UNSUPPORTED',
        `Cannot download '${item.relativePath}' to this virtual filesystem: files above ${this.options.maxBufferedTransferMiB()} MiB require a local destination.`,
      );
    }
    if (token.isCancellationRequested) throw new EasySshError('CANCELLED', 'Download cancelled.');
    const data = await client.readFile(item.sourcePath);
    if (data.byteLength !== item.size) {
      throw new EasySshError(
        'REMOTE_IO',
        `Remote file '${item.sourcePath}' changed during download.`,
      );
    }
    if (token.isCancellationRequested) throw new EasySshError('CANCELLED', 'Download cancelled.');
    const current = await statOrUndefined(this.host.workspace.fs, item.destination);
    if (current && (current.type & this.host.FileType.Directory) !== 0) {
      throw new EasySshError(
        'CONFLICT',
        'A destination directory cannot be replaced by a downloaded file.',
      );
    }
    if (current && !overwriteAuthorized) {
      throw new EasySshError('CONFLICT', 'The destination appeared after conflict authorization.');
    }
    await this.host.workspace.fs.writeFile(item.destination, data);
    return data.byteLength;
  }
}

interface ConflictState {
  overwriteAll: boolean;
  skipAll: boolean;
}

interface MutableSummary {
  planned: number;
  completed: number;
  skipped: { path: string; reason: string }[];
  failed: { path: string; message: string }[];
  cancelled: boolean;
  bytesTransferred: number;
  cleanupFailures: string[];
}

function addPlan(items: PlannedDownload[], maximum: number, item: PlannedDownload): void {
  if (items.length >= maximum) {
    throw new EasySshError(
      'OUTPUT_LIMIT',
      `Download plan exceeds the ${maximum.toLocaleString()} entry limit.`,
    );
  }
  items.push(item);
}

function safeDestination(
  Uri: typeof vscode.Uri,
  root: vscode.Uri,
  segments: readonly string[],
): vscode.Uri {
  if (segments.length === 0 || segments.some((segment) => !isSafeRelativeSegment(segment))) {
    throw new EasySshError('VALIDATION', 'A remote path cannot escape the selected destination.');
  }
  const destination = Uri.joinPath(root, ...segments);
  const rootPath = trimPath(root.path);
  const candidatePath = trimPath(destination.path);
  if (
    destination.scheme !== root.scheme ||
    destination.authority !== root.authority ||
    !isContainedPath(rootPath, candidatePath)
  ) {
    throw new EasySshError(
      'VALIDATION',
      'A remote path attempted to escape the selected destination.',
    );
  }
  return destination;
}

function isSafeRelativeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

/** Windows file destinations cannot represent several POSIX names, and paths are case-insensitive. */
function validateWindowsDestinations(items: readonly PlannedDownload[]): void {
  const destinations = new Map<string, string>();
  const prefixes = new Map<string, string>();
  for (const item of items) {
    const segments = item.relativePath.split('/');
    for (const segment of segments) {
      if (isInvalidWindowsFilename(segment)) {
        throw new EasySshError(
          'VALIDATION',
          `Remote filename '${segment}' cannot be represented on Windows.`,
        );
      }
    }
    let originalPrefix = '';
    for (const segment of segments) {
      originalPrefix = originalPrefix ? `${originalPrefix}/${segment}` : segment;
      const foldedPrefix = originalPrefix.toUpperCase();
      const previousPrefix = prefixes.get(foldedPrefix);
      if (previousPrefix !== undefined && previousPrefix !== originalPrefix) {
        throw new EasySshError(
          'VALIDATION',
          `Remote paths '${previousPrefix}' and '${originalPrefix}' collide on a Windows destination.`,
        );
      }
      prefixes.set(foldedPrefix, originalPrefix);
    }

    const folded = originalPrefix.toUpperCase();
    const previous = destinations.get(folded);
    if (previous !== undefined) {
      throw new EasySshError(
        'VALIDATION',
        `Remote paths '${previous}' and '${item.relativePath}' collide on a Windows destination.`,
      );
    }
    destinations.set(folded, item.relativePath);
  }
}

function isInvalidWindowsFilename(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Windows rejects every ASCII control character in a filename.
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(value) || /[ .]$/u.test(value)) return true;
  // Windows reserves these device names even when an extension is present.
  const stem = value
    .split('.', 1)[0]!
    .replace(/[ .]+$/u, '')
    .toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(stem);
}

function trimPath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function isContainedPath(rootPath: string, candidatePath: string): boolean {
  return rootPath === '/'
    ? candidatePath.startsWith('/')
    : candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

async function statOrUndefined(
  workspaceFs: Pick<typeof vscode.workspace.fs, 'stat'>,
  uri: vscode.Uri,
): Promise<vscode.FileStat | undefined> {
  try {
    return await workspaceFs.stat(uri);
  } catch {
    return undefined;
  }
}

function isSkippedTree(sourcePath: string, skipped: ReadonlySet<string>): boolean {
  return [...skipped].some((root) => sourcePath !== root && sourcePath.startsWith(`${root}/`));
}

function freezeSummary(summary: MutableSummary): DownloadSummary {
  return {
    planned: summary.planned,
    completed: summary.completed,
    skipped: summary.skipped,
    failed: summary.failed,
    cancelled: summary.cancelled,
    bytesTransferred: summary.bytesTransferred,
    cleanupFailures: summary.cleanupFailures,
  };
}
