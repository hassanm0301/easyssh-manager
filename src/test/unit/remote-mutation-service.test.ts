import { describe, expect, it, vi } from 'vitest';

import { EasySshError } from '../../common/errors';
import { RemoteMutationService } from '../../sftp/RemoteMutationService';
import type { SftpClient, SftpConnectionPool } from '../../sftp/ports';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function harness(overrides: Partial<SftpClient> = {}) {
  const client: SftpClient = {
    lstat: vi.fn(async () => {
      throw new EasySshError('NOT_FOUND', 'missing');
    }),
    stat: vi.fn(async () => ({ kind: 'file' as const, size: 0, mtimeMs: 1 })),
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
  const release = vi.fn(async () => undefined);
  const pool = {
    acquire: vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      client,
      touch: () => undefined,
      [Symbol.asyncDispose]: release,
    })),
  } as unknown as SftpConnectionPool;
  const reported: unknown[] = [];
  const codec = {
    create: (connectionId: string, path: string) => ({
      scheme: 'remote-sftp',
      authority: connectionId,
      path,
    }),
    parse: (uri: { authority: string; path: string }) => ({
      connectionId: uri.authority,
      remotePath: uri.path,
    }),
  };
  const host = {
    workspace: {
      textDocuments: [] as { uri: { scheme: string; authority: string; path: string } }[],
    },
    window: {
      tabGroups: { all: [] },
      showWarningMessage: vi.fn(async () => 'Delete'),
      withProgress: vi.fn(async (_options, task) =>
        task({ report: () => undefined }, { isCancellationRequested: false }),
      ),
    },
    ProgressLocation: { Notification: 15 },
  };
  const service = new RemoteMutationService(
    host as never,
    codec as never,
    pool,
    {
      invalidatePath: vi.fn(),
      invalidateParent: vi.fn(),
    } as never,
    { emitMutationChanges: (changes) => reported.push(changes) },
  );
  return { service, client, host, reported, release };
}

describe('remote browser mutations', () => {
  it('creates a zero-byte file with exclusive create and emits only its parent changes', async () => {
    const { service, client, reported } = harness();
    await service.createFile(CONNECTION_ID, '/remote', 'new.txt');
    expect(client.writeFile).toHaveBeenCalledWith('/remote/new.txt', new Uint8Array(), {
      create: true,
      overwrite: false,
    });
    expect(reported).toEqual([
      [
        { type: 'created', uri: expect.objectContaining({ path: '/remote/new.txt' }) },
        { type: 'changed', uri: expect.objectContaining({ path: '/remote' }) },
      ],
    ]);
  });

  it('blocks a rename before any remote mutation while its provider-backed editor is open', async () => {
    const { service, client, host } = harness({
      lstat: vi.fn(async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 })),
    });
    host.workspace.textDocuments.push({
      uri: { scheme: 'remote-sftp', authority: CONNECTION_ID, path: '/remote/file.txt' },
    });
    await expect(service.rename(CONNECTION_ID, '/remote/file.txt', 'renamed.txt')).rejects.toThrow(
      'Close the remote editor',
    );
    expect(client.rename).not.toHaveBeenCalled();
  });

  it('deletes deep directories iteratively and unlinks a link without dereferencing it', async () => {
    const lstat = vi.fn(async (path: string) => {
      if (path === '/tree') return { kind: 'directory' as const, size: 0, mtimeMs: 1 };
      if (path === '/tree/link') return { kind: 'symbolicLink' as const, size: 5, mtimeMs: 1 };
      return { kind: 'file' as const, size: 2, mtimeMs: 1 };
    });
    const { service, client, host } = harness({
      lstat,
      readDirectory: vi.fn(async () => [
        { name: 'link', stat: { kind: 'symbolicLink' as const, size: 5, mtimeMs: 1 } },
        { name: 'file', stat: { kind: 'file' as const, size: 2, mtimeMs: 1 } },
      ]),
    });
    host.window.showWarningMessage.mockResolvedValue('Delete Recursively');
    const summary = await service.delete(CONNECTION_ID, '/tree');
    expect(summary).toMatchObject({ deleted: 3, failed: [], cancelled: false });
    expect(client.unlink).toHaveBeenCalledWith('/tree/link');
    expect(client.readlink).not.toHaveBeenCalled();
    expect(client.rmdir).toHaveBeenCalledWith('/tree');
  });
});
