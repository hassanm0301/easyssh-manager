import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DownloadService } from '../../sftp/DownloadService';
import type { SftpClient, SftpConnectionPool } from '../../sftp/ports';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

type TestUri = { scheme: string; authority: string; path: string; fsPath: string };

function harness(overrides: Partial<SftpClient> = {}) {
  const client: SftpClient = {
    lstat: vi.fn(async () => ({ kind: 'file' as const, size: 10, mtimeMs: 1 })),
    stat: vi.fn(async () => ({ kind: 'file' as const, size: 10, mtimeMs: 1 })),
    realpath: vi.fn(async (path: string) => path),
    readlink: vi.fn(async () => 'target'),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => new Uint8Array(10)),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  const pool = {
    acquire: vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      client,
      touch: () => undefined,
      [Symbol.asyncDispose]: vi.fn(async () => undefined),
    })),
  } as unknown as SftpConnectionPool;
  const root: TestUri = { scheme: 'mem', authority: '', path: '/downloads', fsPath: '' };
  const Uri = {
    joinPath: (base: TestUri, ...segments: string[]): TestUri => ({
      ...base,
      path: `${base.path.replace(/\/$/, '')}/${segments.join('/')}`,
      fsPath:
        base.scheme === 'file' ? `${base.fsPath.replace(/\/$/, '')}/${segments.join('/')}` : '',
    }),
  };
  const host = {
    Uri,
    FileType: { File: 1, Directory: 2 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      fs: {
        stat: vi.fn(async () => {
          throw new Error('not found');
        }),
        createDirectory: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
      },
    },
    window: {
      showOpenDialog: vi.fn(async () => [root]),
      showWarningMessage: vi.fn(async () => 'Overwrite'),
      showInformationMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task({ report: () => undefined }, { isCancellationRequested: false }),
      ),
    },
  };
  return {
    service: new DownloadService(host as never, pool, { maxBufferedTransferMiB: () => 1 }),
    client,
    host,
    root,
  };
}

describe('safe SFTP downloads', () => {
  it('skips a selected symbolic-link root without resolving or materializing it', async () => {
    const { service, client } = harness({
      lstat: vi.fn(async () => ({ kind: 'symbolicLink' as const, size: 0, mtimeMs: 1 })),
    });
    const summary = await service.chooseAndDownload(CONNECTION_ID, ['/link']);
    expect(summary.skipped).toEqual([
      { path: 'link', reason: 'Symbolic links are not downloaded.' },
    ]);
    expect(client.realpath).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
  });

  it('pre-rejects oversized virtual transfers before reading remote content', async () => {
    const { service, client } = harness({
      lstat: vi.fn(async () => ({ kind: 'file' as const, size: 2 * 1024 * 1024, mtimeMs: 1 })),
    });
    const summary = await service.chooseAndDownload(CONNECTION_ID, ['/large.bin']);
    expect(summary.completed).toBe(0);
    expect(summary.failed[0]?.message).toContain('require a local destination');
    expect(client.readFile).not.toHaveBeenCalled();
  });

  it('rejects unsafe server directory names during iterative preflight', async () => {
    const { service } = harness({
      lstat: vi.fn(async (path: string) =>
        path === '/tree'
          ? { kind: 'directory' as const, size: 0, mtimeMs: 1 }
          : { kind: 'file' as const, size: 1, mtimeMs: 1 },
      ),
      readDirectory: vi.fn(async () => [
        { name: '../escape', stat: { kind: 'file' as const, size: 1, mtimeMs: 1 } },
      ]),
    });
    await expect(
      service.preflight(CONNECTION_ID, ['/tree'], {
        scheme: 'mem',
        authority: '',
        path: '/downloads',
        fsPath: '',
      } as never),
    ).rejects.toThrow('unsafe directory entry name');
  });

  it('streams a local destination through a same-directory temporary file', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
    try {
      const { service, client, host } = harness({
        lstat: vi.fn(async () => ({ kind: 'file' as const, size: 6, mtimeMs: 1 })),
        readFile: vi.fn(async (_path: string, range) => {
          const data = Buffer.from('sample');
          return range ? data.subarray(range.offset, range.offset + range.length) : data;
        }),
      });
      host.window.showOpenDialog.mockResolvedValue([
        { scheme: 'file', authority: '', path: destination, fsPath: destination },
      ]);
      const summary = await service.chooseAndDownload(CONNECTION_ID, ['/sample.txt']);
      expect(summary).toMatchObject({ completed: 1, bytesTransferred: 6, failed: [] });
      await expect(readFile(join(destination, 'sample.txt'), 'utf8')).resolves.toBe('sample');
      expect(client.readFile).toHaveBeenCalledWith('/sample.txt', { offset: 0, length: 6 });
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
