import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError } from '../common/errors';
import type { SftpConnectionPool, SftpUriCodec } from './ports';

export const FILE_SAMPLE_BYTES = 8 * 1024;

export type RemoteFileClassification = 'empty' | 'text' | 'binary' | 'image';

interface OpenHost {
  readonly ViewColumn: typeof vscode.ViewColumn;
  readonly window: Pick<
    typeof vscode.window,
    'showWarningMessage' | 'showInformationMessage' | 'showTextDocument'
  >;
  readonly workspace: Pick<typeof vscode.workspace, 'openTextDocument'>;
  readonly commands: Pick<typeof vscode.commands, 'executeCommand'>;
}

export class RemoteFileOpenService {
  constructor(
    private readonly host: OpenHost,
    private readonly codec: SftpUriCodec,
    private readonly pool: SftpConnectionPool,
    private readonly maxInlineFileSizeMiB: () => number,
  ) {}

  async open(uri: vscode.Uri): Promise<void> {
    const { connectionId, remotePath } = this.codec.parse(uri);
    const lease = await this.pool.acquire(connectionId, undefined, 'editor');
    try {
      const stat = await lease.client.stat(remotePath);
      if (stat.kind === 'directory') {
        throw new EasySshError('IS_DIRECTORY', `Remote path '${remotePath}' is a directory.`);
      }
      const maximumBytes = this.maxInlineFileSizeMiB() * 1024 * 1024;
      if (stat.size > maximumBytes) {
        const choice = await this.host.window.showWarningMessage(
          `'${remotePath}' is larger than ${formatMiB(this.maxInlineFileSizeMiB())}.`,
          'Open Anyway',
          'Download',
          'Cancel',
        );
        if (choice === 'Download') {
          await this.host.window.showInformationMessage(
            'Remote download will be available in the SFTP browser milestone.',
          );
          return;
        }
        if (choice !== 'Open Anyway') return;
      }

      const sample = await lease.client.readFile(remotePath, {
        offset: 0,
        length: Math.min(FILE_SAMPLE_BYTES, stat.size),
      });
      const classification = classifyRemoteFile(remotePath, sample);
      if (classification === 'image') {
        await this.host.commands.executeCommand('vscode.open', uri, {
          viewColumn: this.host.ViewColumn.Beside,
        });
        return;
      }
      if (classification === 'binary') {
        const choice = await this.host.window.showWarningMessage(
          `'${remotePath}' appears to contain binary data.`,
          'Download',
          'Open Anyway',
          'Cancel',
        );
        if (choice === 'Download') {
          await this.host.window.showInformationMessage(
            'Remote download will be available in the SFTP browser milestone.',
          );
          return;
        }
        if (choice !== 'Open Anyway') return;
      }

      const document = await this.host.workspace.openTextDocument(uri);
      await this.host.window.showTextDocument(document, {
        viewColumn: this.host.ViewColumn.Beside,
      });
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }
}

export function classifyRemoteFile(path: string, sample: Uint8Array): RemoteFileClassification {
  if (isRecognizedImage(path, sample)) return 'image';
  if (sample.byteLength === 0) return 'empty';
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return 'binary';
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      controls += 1;
    }
  }
  if (controls / sample.byteLength > 0.1) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'text';
  } catch {
    return 'binary';
  }
}

function isRecognizedImage(path: string, sample: Uint8Array): boolean {
  const extension = posix.extname(path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'].includes(extension)) {
    return true;
  }
  return (
    startsWith(sample, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(sample, [0xff, 0xd8, 0xff]) ||
    startsWith(sample, [0x47, 0x49, 0x46, 0x38]) ||
    (startsWith(sample, [0x52, 0x49, 0x46, 0x46]) &&
      sample.byteLength >= 12 &&
      String.fromCharCode(...sample.slice(8, 12)) === 'WEBP')
  );
}

function startsWith(sample: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => sample[index] === byte);
}

function formatMiB(value: number): string {
  return `${value.toLocaleString()} MiB`;
}
