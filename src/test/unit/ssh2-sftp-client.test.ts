import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type {
  FileEntryWithStats,
  ReadStreamOptions,
  SFTPWrapper,
  Stats,
  WriteStreamOptions,
} from 'ssh2';
import { describe, expect, it } from 'vitest';

import { EasySshError } from '../../common/errors';
import { mapSftpError, remoteStat, Ssh2SftpClient } from '../../sftp/Ssh2SftpClient';

type ValueCallback<T> = (error: Error | undefined, value: T) => void;
type VoidCallback = (error?: Error | null) => void;

interface SftpFixture {
  readonly wrapper: SFTPWrapper;
  readonly calls: string[];
  readonly writes: Buffer[];
  readonly writeOptions: WriteStreamOptions[];
  readonly readOptions: ReadStreamOptions[];
  readonly missing: Set<string>;
  readonly emitter: EventEmitter;
  closeCount(): number;
}

function stats(mode = 0o100644, overrides: Partial<Stats> = {}): Stats {
  return {
    mode,
    uid: 1000,
    gid: 1000,
    size: 5,
    atime: 10,
    mtime: 20,
    isDirectory: () => (mode & 0o170000) === 0o040000,
    isFile: () => (mode & 0o170000) === 0o100000,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => (mode & 0o170000) === 0o120000,
    isFIFO: () => false,
    isSocket: () => false,
    ...overrides,
  };
}

function fixture(): SftpFixture {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  const writes: Buffer[] = [];
  const writeOptions: WriteStreamOptions[] = [];
  const readOptions: ReadStreamOptions[] = [];
  const missing = new Set<string>();
  let closes = 0;
  const complete = <T>(callback: ValueCallback<T>, value: T): void => {
    queueMicrotask(() => callback(undefined, value));
  };
  const completeVoid = (callback: VoidCallback): void => {
    queueMicrotask(() => callback());
  };
  const valueStats = stats();
  const wrapper = Object.assign(emitter, {
    lstat(path: string, callback: ValueCallback<Stats>): void {
      calls.push(`lstat:${path}`);
      if (missing.has(path)) {
        queueMicrotask(() =>
          callback(Object.assign(new Error('missing'), { code: 2 }), valueStats),
        );
      } else complete(callback, valueStats);
    },
    stat(path: string, callback: ValueCallback<Stats>): void {
      calls.push(`stat:${path}`);
      complete(callback, stats(0o040755));
    },
    realpath(path: string, callback: ValueCallback<string>): void {
      calls.push(`realpath:${path}`);
      complete(callback, '/resolved//path');
    },
    readlink(path: string, callback: ValueCallback<string>): void {
      calls.push(`readlink:${path}`);
      complete(callback, '../target');
    },
    readdir(path: string, callback: ValueCallback<FileEntryWithStats[]>): void {
      calls.push(`readdir:${path}`);
      complete(callback, [
        { filename: 'file.txt', longname: 'file.txt', attrs: valueStats },
        { filename: 'link', longname: 'link', attrs: stats(0o120777) },
      ]);
    },
    createReadStream(path: string, options: ReadStreamOptions): PassThrough {
      calls.push(`read:${path}`);
      readOptions.push(options);
      const stream = new PassThrough();
      queueMicrotask(() => stream.end(Buffer.from('hello')));
      return stream;
    },
    createWriteStream(path: string, options: WriteStreamOptions): Writable {
      calls.push(`write:${path}`);
      writeOptions.push(options);
      const stream = new Writable({
        write(chunk: Buffer, _encoding, callback): void {
          writes.push(Buffer.from(chunk));
          callback();
        },
      });
      stream.once('finish', () => queueMicrotask(() => stream.emit('close')));
      return stream;
    },
    mkdir(path: string, callback: VoidCallback): void {
      calls.push(`mkdir:${path}`);
      completeVoid(callback);
    },
    rename(source: string, target: string, callback: VoidCallback): void {
      calls.push(`rename:${source}:${target}`);
      completeVoid(callback);
    },
    ext_openssh_rename(source: string, target: string, callback: VoidCallback): void {
      calls.push(`rename:${source}:${target}`);
      completeVoid(callback);
    },
    unlink(path: string, callback: VoidCallback): void {
      calls.push(`unlink:${path}`);
      completeVoid(callback);
    },
    rmdir(path: string, callback: VoidCallback): void {
      calls.push(`rmdir:${path}`);
      completeVoid(callback);
    },
    end(): void {
      closes += 1;
    },
  }) as unknown as SFTPWrapper;
  return {
    wrapper,
    calls,
    writes,
    writeOptions,
    readOptions,
    missing,
    emitter,
    closeCount: () => closes,
  };
}

describe('ssh2 SFTP domain adapter', () => {
  it('normalizes stats, links, real paths, and one-level directory listings', async () => {
    const fake = fixture();
    const client = new Ssh2SftpClient(fake.wrapper);

    await expect(client.lstat('//file.txt')).resolves.toEqual({
      kind: 'file',
      size: 5,
      mode: 0o100644,
      uid: 1000,
      gid: 1000,
      atimeMs: 10_000,
      mtimeMs: 20_000,
    });
    await expect(client.stat('/directory')).resolves.toMatchObject({ kind: 'directory' });
    await expect(client.realpath('/path')).resolves.toBe('/resolved/path');
    await expect(client.readlink('/link')).resolves.toBe('../target');
    await expect(client.readDirectory('/')).resolves.toEqual([
      { name: 'file.txt', stat: expect.objectContaining({ kind: 'file' }) },
      { name: 'link', stat: expect.objectContaining({ kind: 'symbolicLink' }) },
    ]);
    expect(fake.calls).toContain('lstat:/file.txt');
  });

  it('reads exact bytes and applies inclusive ssh2 range boundaries', async () => {
    const fake = fixture();
    const client = new Ssh2SftpClient(fake.wrapper);
    await expect(client.readFile('/file')).resolves.toEqual(Buffer.from('hello'));
    await expect(client.readFile('/file', { offset: 10, length: 5 })).resolves.toEqual(
      Buffer.from('hello'),
    );
    await expect(client.readFile('/file', { offset: 0, length: 0 })).resolves.toEqual(
      new Uint8Array(),
    );
    expect(fake.readOptions).toEqual([
      { autoClose: true },
      { autoClose: true, start: 10, end: 14 },
    ]);
  });

  it('writes with exclusive-create/overwrite flags and validates existing-only writes', async () => {
    const fake = fixture();
    const client = new Ssh2SftpClient(fake.wrapper);
    await client.writeFile('/new', Buffer.from('new'), { create: true, overwrite: false });
    await client.writeFile('/existing', Buffer.from('replace'), {
      create: false,
      overwrite: true,
      mode: 0o600,
    });
    expect(fake.writeOptions).toEqual([
      { flags: 'wx', autoClose: true },
      { flags: 'w', autoClose: true, mode: 0o600 },
    ]);
    expect(Buffer.concat(fake.writes).toString()).toBe('newreplace');
    expect(fake.calls).toContain('lstat:/existing');

    fake.missing.add('/missing');
    await expect(
      client.writeFile('/missing', Buffer.from('x'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      client.writeFile('/existing', Buffer.from('x'), { create: false, overwrite: false }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('implements mkdir, rename overwrite policy, unlink, rmdir, and idempotent close', async () => {
    const fake = fixture();
    fake.missing.add('/new-name');
    const client = new Ssh2SftpClient(fake.wrapper);
    await client.mkdir('/directory');
    await client.rename('/old', '/new-name', false);
    await expect(client.rename('/old', '/existing', false)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    await client.rename('/old', '/existing', true);
    await client.unlink('/file');
    await client.rmdir('/directory');
    await client.close();
    await client.close();

    expect(fake.calls).toEqual(
      expect.arrayContaining([
        'mkdir:/directory',
        'rename:/old:/new-name',
        'rename:/old:/existing',
        'unlink:/file',
        'rmdir:/directory',
      ]),
    );
    expect(fake.closeCount()).toBe(1);
    await expect(client.stat('/after-close')).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('settles callback/event races once and removes temporary listeners', async () => {
    const fake = fixture();
    const wrapper = fake.wrapper as unknown as {
      lstat(path: string, callback: ValueCallback<Stats>): void;
    };
    wrapper.lstat = (_path, callback) => {
      fake.emitter.emit('close');
      callback(undefined, stats());
      fake.emitter.emit('error', Object.assign(new Error('late'), { code: 7 }));
    };
    const client = new Ssh2SftpClient(fake.wrapper);
    await expect(client.lstat('/race')).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(fake.emitter.listenerCount('close')).toBe(1);
    expect(fake.emitter.listenerCount('error')).toBe(1);
    await expect(client.lstat('/after-race')).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('maps SFTP status codes and platform errors to stable domain errors', () => {
    const cases: [number | string, EasySshError['code']][] = [
      [2, 'NOT_FOUND'],
      [3, 'PERMISSION_DENIED'],
      [6, 'CONNECTION_LOST'],
      [7, 'CONNECTION_LOST'],
      [8, 'UNSUPPORTED'],
      ['EEXIST', 'ALREADY_EXISTS'],
      ['ENOTDIR', 'NOT_DIRECTORY'],
      ['EISDIR', 'IS_DIRECTORY'],
      ['ETIMEDOUT', 'TIMEOUT'],
      ['UNKNOWN', 'REMOTE_IO'],
    ];
    for (const [code, expected] of cases) {
      expect(
        mapSftpError(Object.assign(new Error('failure'), { code }), '/path', 'read').code,
      ).toBe(expected);
    }
    expect(
      mapSftpError(Object.assign(new Error('failure'), { code: 4 }), '/path', 'exclusive-create'),
    ).toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('rejects unsafe attributes, ranges, names, and paths', async () => {
    expect(() =>
      remoteStat(stats(0o100644, { size: Number.MAX_SAFE_INTEGER + 1 }), '/bad'),
    ).toThrow(/Invalid remote size/);
    expect(() => remoteStat(stats(0o100644, { mtime: Number.MAX_SAFE_INTEGER }), '/bad')).toThrow(
      /Invalid remote mtime/,
    );
    expect(remoteStat(stats(0o140000), '/socket').kind).toBe('other');

    const fake = fixture();
    const wrapper = fake.wrapper as unknown as {
      readdir(path: string, callback: ValueCallback<FileEntryWithStats[]>): void;
    };
    wrapper.readdir = (_path, callback) =>
      callback(undefined, [{ filename: 'bad/name', longname: '', attrs: stats() }]);
    const client = new Ssh2SftpClient(fake.wrapper);
    await expect(client.readDirectory('/')).rejects.toMatchObject({ code: 'REMOTE_IO' });
    await expect(client.readFile('/file', { offset: -1, length: 1 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(client.stat('../relative')).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
