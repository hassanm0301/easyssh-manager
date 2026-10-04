import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

import { EasySshError } from '../../common/errors';
import { RemoteResourceCache } from '../../sftp/RemoteResourceCache';
import { RemoteSftpFileSystemProvider } from '../../sftp/RemoteSftpFileSystemProvider';
import { DefaultSftpUriCodec, type SftpUriComponents } from '../../sftp/SftpUriCodec';
import type { RemoteStat, SftpClient, SftpConnectionPool } from '../../sftp/ports';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

class TestUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  constructor(components: SftpUriComponents) {
    this.scheme = components.scheme;
    this.authority = components.authority ?? '';
    this.path = components.path ?? '';
    this.query = components.query ?? '';
    this.fragment = components.fragment ?? '';
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

const codec = new DefaultSftpUriCodec(
  { from: (components) => new TestUri(components) as unknown as vscode.Uri },
  (id) => id === FIRST_ID || id === SECOND_ID,
);

class TestEventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  readonly event = (listener: (event: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

class TestFileSystemError extends Error {
  constructor(
    message: string,
    readonly code = 'Unknown',
  ) {
    super(message);
  }
  static FileNotFound(): TestFileSystemError {
    return new TestFileSystemError('not found', 'FileNotFound');
  }
  static FileExists(): TestFileSystemError {
    return new TestFileSystemError('exists', 'FileExists');
  }
  static FileNotADirectory(): TestFileSystemError {
    return new TestFileSystemError('not directory', 'FileNotADirectory');
  }
  static FileIsADirectory(): TestFileSystemError {
    return new TestFileSystemError('is directory', 'FileIsADirectory');
  }
  static NoPermissions(): TestFileSystemError {
    return new TestFileSystemError('permission', 'NoPermissions');
  }
  static Unavailable(): TestFileSystemError {
    return new TestFileSystemError('unavailable', 'Unavailable');
  }
}

const api = {
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FileSystemError: TestFileSystemError,
  EventEmitter: TestEventEmitter,
} as unknown as ConstructorParameters<typeof RemoteSftpFileSystemProvider>[0];

const file = (size = 3, mtimeMs = 10): RemoteStat => ({ kind: 'file', size, mtimeMs });

function client(overrides: Partial<SftpClient> = {}): SftpClient {
  return {
    lstat: vi.fn(async () => file()),
    stat: vi.fn(async () => file()),
    realpath: vi.fn(async (path: string) => path),
    readlink: vi.fn(async () => 'target'),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async () => Buffer.from('abc')),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function harness(remote = client(), created = false) {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const acquire = vi.fn(async (connectionId: string) => {
    const release = vi.fn(async () => undefined);
    releases.push(release);
    return {
      connectionId,
      client: remote,
      touch: () => undefined,
      [Symbol.asyncDispose]: release,
    };
  });
  const pool = {
    acquire,
    invalidate: vi.fn(),
    disposeAll: vi.fn(),
  } as unknown as SftpConnectionPool;
  const cache = new RemoteResourceCache(codec);
  const write = vi.fn(async () => ({ created, stat: file(3, 20) }));
  const provider = new RemoteSftpFileSystemProvider(api, codec, pool, cache, {
    write,
  } as unknown as ConstructorParameters<typeof RemoteSftpFileSystemProvider>[4]);
  return { provider, pool, cache, write, releases };
}

async function nextMicrotask(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe('remote SFTP FileSystemProvider', () => {
  it('maps stats and listings while filtering protocol dot entries', async () => {
    const remote = client({
      lstat: vi.fn<SftpClient['lstat']>(async () => ({
        kind: 'symbolicLink',
        size: 4,
        mtimeMs: 12,
      })),
      readDirectory: vi.fn<SftpClient['readDirectory']>(async () => [
        { name: '.', stat: { kind: 'directory', size: 0, mtimeMs: 1 } },
        { name: '..', stat: { kind: 'directory', size: 0, mtimeMs: 1 } },
        { name: 'file', stat: file() },
        { name: 'dir', stat: { kind: 'directory', size: 0, mtimeMs: 2 } },
        { name: 'link', stat: { kind: 'symbolicLink', size: 2, mtimeMs: 3 } },
      ]),
    });
    const { provider, releases } = harness(remote);
    const uri = codec.create(FIRST_ID, '/path');
    await expect(provider.stat(uri)).resolves.toEqual({ type: 64, ctime: 12, mtime: 12, size: 4 });
    await expect(provider.readDirectory(uri)).resolves.toEqual([
      ['file', 1],
      ['dir', 2],
      ['link', 64],
    ]);
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it('retries one changing read, remembers its fresh version, and always releases', async () => {
    const stat = vi
      .fn<SftpClient['stat']>()
      .mockResolvedValueOnce(file(3, 1))
      .mockResolvedValueOnce(file(3, 2))
      .mockResolvedValueOnce(file(3, 2))
      .mockResolvedValueOnce(file(3, 2));
    const remote = client({ stat });
    const { provider, cache, releases } = harness(remote);
    const uri = codec.create(FIRST_ID, '/file');
    await expect(provider.readFile(uri)).resolves.toEqual(Buffer.from('abc'));
    expect(remote.readFile).toHaveBeenCalledTimes(2);
    expect(cache.getVersion(uri)).toEqual({ mtimeMs: 2, size: 3 });
    expect(releases[0]).toHaveBeenCalledOnce();

    const unstable = client({
      stat: vi
        .fn<SftpClient['stat']>()
        .mockResolvedValueOnce(file(1, 1))
        .mockResolvedValueOnce(file(1, 2))
        .mockResolvedValueOnce(file(1, 3))
        .mockResolvedValueOnce(file(1, 4)),
    });
    const unstableHarness = harness(unstable);
    await expect(unstableHarness.provider.readFile(uri)).rejects.toMatchObject({
      code: 'Unavailable',
    });
    expect(unstableHarness.releases[0]).toHaveBeenCalledOnce();
  });

  it('emits exact batched write and create-directory events', async () => {
    const { provider, write } = harness(client(), true);
    const events: vscode.FileChangeEvent[][] = [];
    provider.onDidChangeFile((batch) => events.push(batch));
    const fileUri = codec.create(FIRST_ID, '/dir/file');
    await provider.writeFile(fileUri, Buffer.from('abc'), { create: true, overwrite: false });
    await nextMicrotask();
    expect(write).toHaveBeenCalledWith(fileUri, expect.anything(), Buffer.from('abc'), {
      create: true,
      overwrite: false,
    });
    expect(events.shift()?.map((event) => [event.type, event.uri.path])).toEqual([
      [1, '/dir/file'],
      [1, '/dir'],
    ]);

    const directoryUri = codec.create(FIRST_ID, '/dir/new');
    await provider.createDirectory(directoryUri);
    await nextMicrotask();
    expect(events.shift()?.map((event) => [event.type, event.uri.path])).toEqual([
      [2, '/dir/new'],
      [1, '/dir'],
    ]);
  });

  it('deletes links without following them and directories only through rmdir', async () => {
    const lstat = vi
      .fn<SftpClient['lstat']>()
      .mockResolvedValueOnce({ kind: 'symbolicLink', size: 1, mtimeMs: 1 })
      .mockResolvedValueOnce({ kind: 'directory', size: 0, mtimeMs: 1 });
    const remote = client({ lstat });
    const { provider } = harness(remote);
    const events: vscode.FileChangeEvent[][] = [];
    provider.onDidChangeFile((batch) => events.push(batch));
    await provider.delete(codec.create(FIRST_ID, '/dir/link'), { recursive: true });
    await nextMicrotask();
    await provider.delete(codec.create(FIRST_ID, '/dir/empty'), { recursive: true });
    await nextMicrotask();
    expect(remote.unlink).toHaveBeenCalledWith('/dir/link');
    expect(remote.rmdir).toHaveBeenCalledWith('/dir/empty');
    expect(events[0]?.map((event) => [event.type, event.uri.path])).toEqual([
      [3, '/dir/link'],
      [1, '/dir'],
    ]);
  });

  it('honors rename overwrite and emits both distinct parent changes', async () => {
    const remote = client({
      lstat: vi.fn(async () => {
        throw new EasySshError('NOT_FOUND', 'missing');
      }),
    });
    const { provider } = harness(remote);
    const events: vscode.FileChangeEvent[][] = [];
    provider.onDidChangeFile((batch) => events.push(batch));
    const oldUri = codec.create(FIRST_ID, '/old/file');
    const newUri = codec.create(FIRST_ID, '/new/file');
    await provider.rename(oldUri, newUri, { overwrite: true });
    await nextMicrotask();
    expect(remote.rename).toHaveBeenCalledWith('/old/file', '/new/file', true);
    expect(events[0]?.map((event) => [event.type, event.uri.path])).toEqual([
      [3, '/old/file'],
      [2, '/new/file'],
      [1, '/old'],
      [1, '/new'],
    ]);
    await expect(
      provider.rename(oldUri, codec.create(SECOND_ID, '/new/file'), { overwrite: false }),
    ).rejects.toMatchObject({ code: 'Unavailable' });
  });

  it('maps domain errors and returns an idempotent no-op watcher', async () => {
    const remote = client({
      lstat: vi.fn(async () => {
        throw new EasySshError('PERMISSION_DENIED', 'denied');
      }),
    });
    const { provider, releases } = harness(remote);
    await expect(provider.stat(codec.create(FIRST_ID, '/private'))).rejects.toMatchObject({
      code: 'NoPermissions',
    });
    expect(releases[0]).toHaveBeenCalledOnce();
    const watcher = provider.watch(codec.create(FIRST_ID, '/'), { recursive: true, excludes: [] });
    expect(() => {
      watcher.dispose();
      watcher.dispose();
    }).not.toThrow();
  });
});
