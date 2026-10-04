import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyRemoteFile,
  FILE_SAMPLE_BYTES,
  RemoteFileOpenService,
} from '../../sftp/RemoteFileOpenService';
import { DefaultSftpUriCodec, type SftpUriComponents } from '../../sftp/SftpUriCodec';
import type { SftpClient, SftpConnectionPool } from '../../sftp/ports';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const codec = new DefaultSftpUriCodec(
  {
    from: (components: SftpUriComponents) =>
      ({
        scheme: components.scheme,
        authority: components.authority ?? '',
        path: components.path ?? '',
        query: '',
        fragment: '',
      }) as vscode.Uri,
  },
  (id) => id === CONNECTION_ID,
);

function remoteClient(size: number, sample: Uint8Array): SftpClient {
  return {
    lstat: vi.fn(async () => ({ kind: 'file' as const, size, mtimeMs: 1 })),
    stat: vi.fn(async () => ({ kind: 'file' as const, size, mtimeMs: 1 })),
    realpath: vi.fn(async (path: string) => path),
    readlink: vi.fn(async () => 'target'),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => sample),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function harness(size: number, sample: Uint8Array, choices: (string | undefined)[] = []) {
  const client = remoteClient(size, sample);
  const release = vi.fn(async () => undefined);
  const pool = {
    acquire: vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      client,
      touch: () => undefined,
      [Symbol.asyncDispose]: release,
    })),
  } as unknown as SftpConnectionPool;
  const showWarningMessage = vi.fn(async () => choices.shift());
  const host = {
    ViewColumn: { Beside: -2 },
    window: {
      showWarningMessage,
      showInformationMessage: vi.fn(async () => undefined),
      showTextDocument: vi.fn(async () => undefined),
    },
    workspace: { openTextDocument: vi.fn(async () => ({ uri: 'document' })) },
    commands: { executeCommand: vi.fn(async () => undefined) },
  };
  const service = new RemoteFileOpenService(
    host as unknown as ConstructorParameters<typeof RemoteFileOpenService>[0],
    codec,
    pool,
    () => 20,
  );
  return { service, client, release, host, showWarningMessage };
}

describe('remote file classification', () => {
  it.each([
    ['empty', '/file', new Uint8Array(), 'empty'],
    ['UTF-8', '/file', Buffer.from('hello, 世界'), 'text'],
    ['UTF-8 BOM', '/file', Buffer.from([0xef, 0xbb, 0xbf, 0x61]), 'text'],
    ['invalid UTF-8', '/file', Buffer.from([0xc3, 0x28]), 'binary'],
    ['NUL', '/file', Buffer.from([0x61, 0, 0x62]), 'binary'],
    ['controls', '/file', Buffer.from([1, 2, 3, 4, 0x61]), 'binary'],
    ['image extension', '/photo.PNG', Buffer.from([0, 1]), 'image'],
    ['image signature', '/unknown', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image'],
  ])('classifies %s', (_label, path, sample, expected) => {
    expect(classifyRemoteFile(path, sample)).toBe(expected);
  });
});

describe('guarded remote file open', () => {
  it('samples at most 8 KiB and opens text in the normal editor beside the current view', async () => {
    const { service, client, release, host } = harness(100, Buffer.from('hello'));
    const uri = codec.create(CONNECTION_ID, '/file.txt');
    await service.open(uri);
    expect(client.readFile).toHaveBeenCalledWith('/file.txt', { offset: 0, length: 100 });
    expect(host.workspace.openTextDocument).toHaveBeenCalledWith(uri);
    expect(host.window.showTextDocument).toHaveBeenCalledWith(
      { uri: 'document' },
      { viewColumn: -2 },
    );
    expect(release).toHaveBeenCalledOnce();

    const largeSample = harness(FILE_SAMPLE_BYTES * 2, Buffer.from('sample'));
    await largeSample.service.open(uri);
    expect(largeSample.client.readFile).toHaveBeenCalledWith('/file.txt', {
      offset: 0,
      length: FILE_SAMPLE_BYTES,
    });
  });

  it('warns strictly above the size boundary and scopes Open Anyway to the invocation', async () => {
    const boundary = 20 * 1024 * 1024;
    const exact = harness(boundary, Buffer.from('text'));
    await exact.service.open(codec.create(CONNECTION_ID, '/exact'));
    expect(exact.showWarningMessage).not.toHaveBeenCalled();

    const over = harness(boundary + 1, Buffer.from('text'), ['Open Anyway']);
    await over.service.open(codec.create(CONNECTION_ID, '/over'));
    expect(over.showWarningMessage).toHaveBeenCalledOnce();
    expect(over.host.workspace.openTextDocument).toHaveBeenCalledOnce();

    const cancelled = harness(boundary + 1, Buffer.from('text'), ['Cancel']);
    await cancelled.service.open(codec.create(CONNECTION_ID, '/over'));
    expect(cancelled.client.readFile).not.toHaveBeenCalled();
    expect(cancelled.release).toHaveBeenCalledOnce();
  });

  it('routes images through normal VS Code opening and guards probable binary files', async () => {
    const image = harness(4, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const imageUri = codec.create(CONNECTION_ID, '/image');
    await image.service.open(imageUri);
    expect(image.host.commands.executeCommand).toHaveBeenCalledWith('vscode.open', imageUri, {
      viewColumn: -2,
    });
    expect(image.host.workspace.openTextDocument).not.toHaveBeenCalled();

    const binary = harness(3, Buffer.from([0, 1, 2]), ['Open Anyway']);
    await binary.service.open(codec.create(CONNECTION_ID, '/binary'));
    expect(binary.host.workspace.openTextDocument).toHaveBeenCalledOnce();
  });

  it('reports Download as unavailable and releases leases on every guarded exit', async () => {
    const over = harness(21 * 1024 * 1024, Buffer.from('text'), ['Download']);
    await over.service.open(codec.create(CONNECTION_ID, '/large'));
    expect(over.host.window.showInformationMessage).toHaveBeenCalledWith(
      'Remote download will be available in the SFTP browser milestone.',
    );
    expect(over.host.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(over.release).toHaveBeenCalledOnce();
  });
});
