import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsFailures = vi.hoisted(() => ({
  rename: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
  rm: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (...args: unknown[]) =>
      fsFailures.rename?.(...args) ?? actual.rename(...(args as [string, string])),
    rm: (...args: unknown[]) =>
      fsFailures.rm?.(...args) ?? actual.rm(...(args as Parameters<typeof actual.rm>)),
  };
});

import { DownloadService } from '../../sftp/DownloadService';
import type { SftpClient, SftpConnectionPool } from '../../sftp/ports';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

type TestUri = { scheme: string; authority: string; path: string; fsPath: string };

function harness(
  overrides: Partial<SftpClient> = {},
  platform: NodeJS.Platform = 'linux',
  cancellation: { requested: boolean } = { requested: false },
) {
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
        task(
          { report: () => undefined },
          {
            get isCancellationRequested() {
              return cancellation.requested;
            },
          },
        ),
      ),
    },
  };
  return {
    service: new DownloadService(host as never, pool, {
      maxBufferedTransferMiB: () => 1,
      platform,
    }),
    client,
    host,
    root,
    cancellation,
  };
}

afterEach(() => {
  fsFailures.rename = undefined;
  fsFailures.rm = undefined;
  vi.restoreAllMocks();
});

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

  it('rejects an invalid Windows filename discovered late before creating any destination', async () => {
    const destination = 'C:\\downloads';
    const { service, host } = harness(
      {
        lstat: vi.fn(async (path: string) =>
          path === '/tree'
            ? { kind: 'directory' as const, size: 0, mtimeMs: 1 }
            : { kind: 'file' as const, size: 1, mtimeMs: 1 },
        ),
        readDirectory: vi.fn(async () => [
          { name: 'valid.txt', stat: { kind: 'file' as const, size: 1, mtimeMs: 1 } },
          { name: 'bad:name.txt', stat: { kind: 'file' as const, size: 1, mtimeMs: 1 } },
        ]),
      },
      'win32',
    );
    host.window.showOpenDialog.mockResolvedValue([
      { scheme: 'file', authority: '', path: destination, fsPath: destination },
    ]);

    await expect(service.chooseAndDownload(CONNECTION_ID, ['/tree'])).rejects.toThrow(
      'cannot be represented on Windows',
    );
    expect(host.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(host.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it.each([
    'CON',
    'nul.txt',
    'COM1.log',
    'LPT².txt',
    'trailing.',
    'trailing ',
    'stream:ads',
    'a?b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
    'a*b',
    'control\u0001',
  ])('rejects Windows local filename %j before writing', async (name) => {
    const { service, client, host } = harness({}, 'win32');
    host.window.showOpenDialog.mockResolvedValue([
      { scheme: 'file', authority: '', path: '/c:/downloads', fsPath: 'C:\\downloads' },
    ]);
    await expect(service.chooseAndDownload(CONNECTION_ID, [`/${name}`])).rejects.toThrow(
      'cannot be represented on Windows',
    );
    expect(host.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(host.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(client.readFile).not.toHaveBeenCalled();
  });

  it('keeps provider-specific filenames available for virtual Windows destinations', async () => {
    const { service, root } = harness({}, 'win32');
    await expect(
      service.preflight(CONNECTION_ID, ['/CON', '/stream:ads'], root as never),
    ).resolves.toMatchObject({ items: [{ relativePath: 'CON' }, { relativePath: 'stream:ads' }] });
  });

  it.each([
    ['Report.txt', 'report.txt'],
    ['Σ.txt', 'ς.txt'],
  ])('rejects case-insensitive Windows roots %s and %s before writing', async (first, second) => {
    const destination = 'C:\\downloads';
    const { service, host } = harness({}, 'win32');
    host.window.showOpenDialog.mockResolvedValue([
      { scheme: 'file', authority: '', path: destination, fsPath: destination },
    ]);

    await expect(
      service.chooseAndDownload(CONNECTION_ID, [`/${first}`, `/${second}`]),
    ).rejects.toThrow('collide on a Windows destination');
    expect(host.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(host.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects case aliases in selected directory roots even when their leaves differ', async () => {
    const { service, host } = harness(
      {
        lstat: vi.fn(async (path: string) =>
          path === '/Foo' || path === '/foo'
            ? { kind: 'directory' as const, size: 0, mtimeMs: 1 }
            : { kind: 'file' as const, size: 1, mtimeMs: 1 },
        ),
        readDirectory: vi.fn(async (path: string) =>
          path === '/Foo'
            ? [{ name: 'a.txt', stat: { kind: 'file' as const, size: 1, mtimeMs: 1 } }]
            : [{ name: 'b.txt', stat: { kind: 'file' as const, size: 1, mtimeMs: 1 } }],
        ),
      },
      'win32',
    );
    host.window.showOpenDialog.mockResolvedValue([
      { scheme: 'file', authority: '', path: 'C:\\downloads', fsPath: 'C:\\downloads' },
    ]);

    await expect(service.chooseAndDownload(CONNECTION_ID, ['/Foo', '/foo'])).rejects.toThrow(
      'collide on a Windows destination',
    );
    expect(host.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(host.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects case aliases nested in one selected Windows tree before writing', async () => {
    const { service, host } = harness(
      {
        lstat: vi.fn(async (path: string) =>
          path === '/tree' || path === '/tree/Foo' || path === '/tree/foo'
            ? { kind: 'directory' as const, size: 0, mtimeMs: 1 }
            : { kind: 'file' as const, size: 1, mtimeMs: 1 },
        ),
        readDirectory: vi.fn(async (path: string) =>
          path === '/tree'
            ? [
                { name: 'Foo', stat: { kind: 'directory' as const, size: 0, mtimeMs: 1 } },
                { name: 'foo', stat: { kind: 'directory' as const, size: 0, mtimeMs: 1 } },
              ]
            : [
                {
                  name: path.endsWith('/Foo') ? 'a.txt' : 'b.txt',
                  stat: { kind: 'file' as const, size: 1, mtimeMs: 1 },
                },
              ],
        ),
      },
      'win32',
    );
    host.window.showOpenDialog.mockResolvedValue([
      { scheme: 'file', authority: '', path: 'C:\\downloads', fsPath: 'C:\\downloads' },
    ]);

    await expect(service.chooseAndDownload(CONNECTION_ID, ['/tree'])).rejects.toThrow(
      'collide on a Windows destination',
    );
    expect(host.workspace.fs.createDirectory).not.toHaveBeenCalled();
    expect(host.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('keeps POSIX filenames valid on Linux', async () => {
    const { service } = harness({}, 'linux');
    await expect(
      service.preflight(CONNECTION_ID, ['/bad:name.txt'], {
        scheme: 'file',
        authority: '',
        path: '/downloads',
        fsPath: '/downloads',
      } as never),
    ).resolves.toMatchObject({ items: [{ relativePath: 'bad:name.txt' }] });
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

  it('atomically replaces an authorized existing local file', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
    try {
      await writeFile(join(destination, 'sample.txt'), 'old content');
      const { service, host } = harness({
        lstat: vi.fn(async () => ({ kind: 'file' as const, size: 6, mtimeMs: 1 })),
        readFile: vi.fn(async () => Buffer.from('sample')),
      });
      host.window.showOpenDialog.mockResolvedValue([
        { scheme: 'file', authority: '', path: destination, fsPath: destination },
      ]);
      const summary = await service.chooseAndDownload(CONNECTION_ID, ['/sample.txt']);
      expect(summary).toMatchObject({ completed: 1, failed: [], cleanupFailures: [] });
      await expect(readFile(join(destination, 'sample.txt'), 'utf8')).resolves.toBe('sample');
      expect(
        (await readdir(destination)).filter((name) => name.includes('.easyssh-download-')),
      ).toEqual([]);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('commits a zero-byte local file', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
    try {
      const { service, host, client } = harness({
        lstat: vi.fn(async () => ({ kind: 'file' as const, size: 0, mtimeMs: 1 })),
      });
      host.window.showOpenDialog.mockResolvedValue([
        { scheme: 'file', authority: '', path: destination, fsPath: destination },
      ]);
      const summary = await service.chooseAndDownload(CONNECTION_ID, ['/empty']);
      expect(summary).toMatchObject({ completed: 1, bytesTransferred: 0 });
      expect(client.readFile).not.toHaveBeenCalled();
      expect((await readFile(join(destination, 'empty'))).byteLength).toBe(0);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('cancels after a streamed chunk and leaves no partial destination', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
    try {
      const cancellation = { requested: false };
      const { service, host } = harness(
        {
          lstat: vi.fn(async () => ({ kind: 'file' as const, size: 4, mtimeMs: 1 })),
          readFile: vi.fn(async (_path: string, range) => {
            cancellation.requested = true;
            return Buffer.from('data').subarray(range!.offset, range!.offset + range!.length);
          }),
        },
        'linux',
        cancellation,
      );
      // Keep cancellation false until the write completes, then make the next loop observe it.
      host.window.showOpenDialog.mockResolvedValue([
        { scheme: 'file', authority: '', path: destination, fsPath: destination },
      ]);
      const summary = await service.chooseAndDownload(CONNECTION_ID, ['/sample']);
      expect(summary.cancelled).toBe(true);
      expect(summary.completed).toBe(0);
      expect(await readdir(destination)).toEqual([]);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('honors cancellation before opening or writing a local destination', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
    try {
      const cancellation = { requested: true };
      const { service, host, client } = harness(
        {
          lstat: vi.fn(async () => ({ kind: 'file' as const, size: 4, mtimeMs: 1 })),
        },
        'linux',
        cancellation,
      );
      host.window.showOpenDialog.mockResolvedValue([
        { scheme: 'file', authority: '', path: destination, fsPath: destination },
      ]);
      const summary = await service.chooseAndDownload(CONNECTION_ID, ['/sample']);
      expect(summary.cancelled).toBe(true);
      expect(client.readFile).not.toHaveBeenCalled();
      expect(await readdir(destination)).toEqual([]);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it.each(['EPERM', 'EACCES'] as const)(
    'preserves existing content and cleans the temporary file when replacement fails with %s',
    async (code) => {
      const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
      try {
        const target = join(destination, 'sample');
        await writeFile(target, 'original');
        const { service, host } = harness({
          lstat: vi.fn(async () => ({ kind: 'file' as const, size: 4, mtimeMs: 1 })),
          readFile: vi.fn(async () => Buffer.from('data')),
        });
        host.window.showOpenDialog.mockResolvedValue([
          { scheme: 'file', authority: '', path: destination, fsPath: destination },
        ]);
        fsFailures.rename = async () => {
          throw Object.assign(new Error(code), { code });
        };
        const summary = await service.chooseAndDownload(CONNECTION_ID, ['/sample']);
        expect(summary.failed).toHaveLength(1);
        expect(summary.failed[0]?.message).toContain(code);
        await expect(readFile(target, 'utf8')).resolves.toBe('original');
        expect(
          (await readdir(destination)).filter((name) => name.includes('.easyssh-download-')),
        ).toEqual([]);
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    },
  );

  it('includes temporary cleanup failures in the returned summary', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'easyssh-download-'));
    try {
      const { service, host } = harness({
        lstat: vi.fn(async () => ({ kind: 'file' as const, size: 4, mtimeMs: 1 })),
        readFile: vi.fn(async () => Buffer.from('data')),
      });
      host.window.showOpenDialog.mockResolvedValue([
        { scheme: 'file', authority: '', path: destination, fsPath: destination },
      ]);
      fsFailures.rename = async () => {
        throw new Error('locked');
      };
      fsFailures.rm = async () => {
        throw new Error('access denied');
      };
      const summary = await service.chooseAndDownload(CONNECTION_ID, ['/sample']);
      expect(summary.cleanupFailures).toHaveLength(1);
      expect(summary.cleanupFailures[0]).toContain('.easyssh-download-');
    } finally {
      fsFailures.rename = undefined;
      fsFailures.rm = undefined;
      vi.restoreAllMocks();
      await rm(destination, { recursive: true, force: true });
    }
  });
});
