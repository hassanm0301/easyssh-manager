import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError } from '../common/errors';
import type { CancellationTokenLike } from '../ssh/ports';
import type { RemoteResourceCache } from './RemoteResourceCache';
import type {
  RemoteStat,
  RemoteVersion,
  RemoteWriteOptions,
  SftpClient,
  SftpUriCodec,
} from './ports';

export type RemoteConflictReason = 'changed' | 'deleted' | 'created';

export interface AtomicWritePrompt {
  confirmOverwrite(uri: vscode.Uri, reason: RemoteConflictReason): Promise<boolean>;
  confirmNonAtomicOverwrite(uri: vscode.Uri): Promise<boolean>;
}

export interface AtomicWriteLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface AtomicWriteResult {
  readonly created: boolean;
  readonly stat: RemoteStat;
}

/** Same-directory temporary upload and conflict-aware commit boundary. */
export class AtomicSftpWriter {
  constructor(
    private readonly codec: SftpUriCodec,
    private readonly cache: RemoteResourceCache,
    private readonly prompt: AtomicWritePrompt,
    private readonly logger: AtomicWriteLogger,
    private readonly randomName: () => string = randomUUID,
    private readonly maximumTempAttempts = 5,
  ) {}

  async write(
    uri: vscode.Uri,
    client: SftpClient,
    data: Uint8Array,
    options: RemoteWriteOptions,
    cancellation?: CancellationTokenLike,
  ): Promise<AtomicWriteResult> {
    checkCancellation(cancellation);
    const { connectionId, remotePath } = this.codec.parse(uri);
    if (remotePath === '/') {
      throw new EasySshError('IS_DIRECTORY', "Remote path '/' is a directory.");
    }

    const initial = await optionalStat(client, remotePath);
    validateDestination(initial, remotePath, options);
    let baseline = versionOf(initial);
    const remembered = this.cache.getVersion(uri);
    if (initial && remembered && !sameVersion(remembered, baseline)) {
      await this.authorizeConflict(uri, 'changed', cancellation);
      baseline = versionOf(initial);
    }

    const tempPath = await this.uploadTemporary(client, remotePath, data, cancellation);
    let committed = false;
    try {
      const uploaded = await client.stat(tempPath);
      if (uploaded.kind !== 'file' || uploaded.size !== data.byteLength) {
        throw new EasySshError(
          'REMOTE_IO',
          `Temporary upload verification failed for '${remotePath}'.`,
        );
      }
      checkCancellation(cancellation);

      const beforeCommit = await optionalStat(client, remotePath);
      const reason = conflictReason(initial, baseline, beforeCommit);
      if (reason) await this.authorizeConflict(uri, reason, cancellation);
      const replacing = beforeCommit !== undefined;

      try {
        await client.rename(tempPath, remotePath, replacing);
      } catch (error) {
        if (!(error instanceof EasySshError) || error.code !== 'UNSUPPORTED' || !replacing) {
          throw error;
        }
        checkCancellation(cancellation);
        if (!(await this.prompt.confirmNonAtomicOverwrite(uri))) throw cancelledSave();
        checkCancellation(cancellation);
        await client.unlink(remotePath);
        await client.rename(tempPath, remotePath, false);
      }
      committed = true;

      const finalStat = await client.stat(remotePath);
      if (finalStat.kind !== 'file') {
        throw new EasySshError('REMOTE_IO', `Remote write produced a non-file at '${remotePath}'.`);
      }
      this.cache.invalidatePath(connectionId, remotePath);
      this.cache.invalidateParent(connectionId, remotePath);
      this.cache.rememberMetadata(connectionId, remotePath, finalStat);
      this.cache.rememberVersion(uri, versionOf(finalStat));
      return { created: initial === undefined, stat: finalStat };
    } finally {
      if (!committed) await this.cleanupTemporary(client, tempPath);
    }
  }

  private async uploadTemporary(
    client: SftpClient,
    targetPath: string,
    data: Uint8Array,
    cancellation?: CancellationTokenLike,
  ): Promise<string> {
    const directory = posix.dirname(targetPath);
    const basename = posix.basename(targetPath);
    for (let attempt = 0; attempt < this.maximumTempAttempts; attempt += 1) {
      checkCancellation(cancellation);
      const suffix = safeSuffix(this.randomName());
      const tempPath = posix.join(directory, `.${basename}.easyssh-upload-${suffix}`);
      try {
        await client.writeFile(tempPath, data, { create: true, overwrite: false });
        checkCancellation(cancellation);
        return tempPath;
      } catch (error) {
        if (error instanceof EasySshError && error.code === 'ALREADY_EXISTS') continue;
        await this.cleanupTemporary(client, tempPath);
        throw error;
      }
    }
    throw new EasySshError(
      'ALREADY_EXISTS',
      `Unable to allocate a temporary upload name for '${targetPath}'.`,
    );
  }

  private async authorizeConflict(
    uri: vscode.Uri,
    reason: RemoteConflictReason,
    cancellation?: CancellationTokenLike,
  ): Promise<void> {
    checkCancellation(cancellation);
    if (!(await this.prompt.confirmOverwrite(uri, reason))) throw cancelledSave();
    checkCancellation(cancellation);
  }

  private async cleanupTemporary(client: SftpClient, tempPath: string): Promise<void> {
    try {
      await client.unlink(tempPath);
    } catch (error) {
      if (error instanceof EasySshError && error.code === 'NOT_FOUND') return;
      this.logger.debug('Unable to clean up an SFTP temporary upload', {
        operation: 'sftp-temp-cleanup',
        path: tempPath,
      });
    }
  }
}

async function optionalStat(client: SftpClient, path: string): Promise<RemoteStat | undefined> {
  try {
    return await client.lstat(path);
  } catch (error) {
    if (error instanceof EasySshError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

function validateDestination(
  stat: RemoteStat | undefined,
  path: string,
  options: RemoteWriteOptions,
): void {
  if (!stat && !options.create) {
    throw new EasySshError('NOT_FOUND', `Remote path '${path}' was not found.`);
  }
  if (stat?.kind === 'directory') {
    throw new EasySshError('IS_DIRECTORY', `Remote path '${path}' is a directory.`);
  }
  if (stat && !options.overwrite) {
    throw new EasySshError('ALREADY_EXISTS', `Remote path '${path}' already exists.`);
  }
}

function conflictReason(
  initial: RemoteStat | undefined,
  baseline: RemoteVersion | undefined,
  current: RemoteStat | undefined,
): RemoteConflictReason | undefined {
  if (!initial && current) return 'created';
  if (initial && !current) return 'deleted';
  if (baseline && current && !sameVersion(baseline, versionOf(current))) return 'changed';
  return undefined;
}

function versionOf(stat: RemoteStat): RemoteVersion;
function versionOf(stat: RemoteStat | undefined): RemoteVersion | undefined;
function versionOf(stat: RemoteStat | undefined): RemoteVersion | undefined {
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
}

function sameVersion(left: RemoteVersion, right: RemoteVersion | undefined): boolean {
  return right !== undefined && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function safeSuffix(value: string): string {
  const suffix = value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80);
  return suffix || randomUUID();
}

function checkCancellation(cancellation: CancellationTokenLike | undefined): void {
  if (cancellation?.isCancellationRequested) throw cancelledSave();
}

function cancelledSave(): EasySshError {
  return new EasySshError('CANCELLED', 'Remote save cancelled.');
}
