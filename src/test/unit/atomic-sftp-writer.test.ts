import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

import { EasySshError } from '../../common/errors';
import { AtomicSftpWriter, type AtomicWritePrompt } from '../../sftp/AtomicSftpWriter';
import { RemoteResourceCache } from '../../sftp/RemoteResourceCache';
import { DefaultSftpUriCodec, type SftpUriComponents } from '../../sftp/SftpUriCodec';
import type { RemoteStat, SftpClient } from '../../sftp/ports';
import type { CancellationTokenLike } from '../../ssh/ports';

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

interface StoredFile {
  readonly bytes: Buffer;
  readonly stat: RemoteStat;
}

class MemorySftpClient implements SftpClient {
  readonly files = new Map<string, StoredFile>();
  readonly calls: string[] = [];
  mtime = 10;
  beforeTempStat?: () => void;
  renameFailure?: (source: string, target: string, overwrite: boolean) => Error | undefined;
  writeFailure?: (path: string) => Error | undefined;
  unlinkFailure?: (path: string) => Error | undefined;

  put(path: string, content: string, mtimeMs = this.mtime++): void {
    const bytes = Buffer.from(content);
    this.files.set(path, { bytes, stat: { kind: 'file', size: bytes.length, mtimeMs } });
  }

  async lstat(path: string): Promise<RemoteStat> {
    this.calls.push(`lstat:${path}`);
    return this.require(path).stat;
  }
  async stat(path: string): Promise<RemoteStat> {
    this.calls.push(`stat:${path}`);
    if (path.includes('.easyssh-upload-')) this.beforeTempStat?.();
    return this.require(path).stat;
  }
  async realpath(path: string): Promise<string> {
    return path;
  }
  async readlink(): Promise<string> {
    return 'target';
  }
  async readDirectory() {
    return [];
  }
  async readFile(path: string): Promise<Uint8Array> {
    return this.require(path).bytes;
  }
  async writeFile(
    path: string,
    data: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    this.calls.push(`write:${path}`);
    if (this.files.has(path) && !options.overwrite) throw exists(path);
    const bytes = Buffer.from(data);
    this.files.set(path, {
      bytes,
      stat: { kind: 'file', size: bytes.length, mtimeMs: this.mtime++ },
    });
    const failure = this.writeFailure?.(path);
    if (failure) throw failure;
  }
  async mkdir(): Promise<void> {}
  async rename(source: string, target: string, overwrite: boolean): Promise<void> {
    this.calls.push(`rename:${source}:${target}:${String(overwrite)}`);
    const failure = this.renameFailure?.(source, target, overwrite);
    if (failure) throw failure;
    if (this.files.has(target) && !overwrite) throw exists(target);
    const sourceFile = this.require(source);
    this.files.delete(source);
    this.files.set(target, sourceFile);
  }
  async unlink(path: string): Promise<void> {
    this.calls.push(`unlink:${path}`);
    const failure = this.unlinkFailure?.(path);
    if (failure) throw failure;
    if (!this.files.delete(path)) throw missing(path);
  }
  async rmdir(): Promise<void> {}
  async close(): Promise<void> {}

  private require(path: string): StoredFile {
    const value = this.files.get(path);
    if (!value) throw missing(path);
    return value;
  }
}

function missing(path: string): EasySshError {
  return new EasySshError('NOT_FOUND', `${path} missing`);
}
function exists(path: string): EasySshError {
  return new EasySshError('ALREADY_EXISTS', `${path} exists`);
}

function harness(names: string[] = ['one']) {
  const cache = new RemoteResourceCache(codec);
  const prompt: AtomicWritePrompt = {
    confirmOverwrite: vi.fn(async () => true),
    confirmNonAtomicOverwrite: vi.fn(async () => true),
  };
  const logger = { debug: vi.fn() };
  let index = 0;
  const writer = new AtomicSftpWriter(
    codec,
    cache,
    prompt,
    logger,
    () => names[index++] ?? `name-${index}`,
  );
  return { cache, prompt, logger, writer };
}

describe('atomic SFTP writer', () => {
  it('creates through a verified same-directory temporary file and updates caches', async () => {
    const remote = new MemorySftpClient();
    const { writer, cache } = harness();
    const uri = codec.create(CONNECTION_ID, '/dir/file.txt');
    const result = await writer.write(uri, remote, Buffer.from('content'), {
      create: true,
      overwrite: false,
    });

    expect(result.created).toBe(true);
    expect(remote.files.get('/dir/file.txt')?.bytes.toString()).toBe('content');
    expect([...remote.files.keys()]).toEqual(['/dir/file.txt']);
    expect(remote.calls).toContain('rename:/dir/.file.txt.easyssh-upload-one:/dir/file.txt:false');
    expect(cache.getVersion(uri)).toEqual({ mtimeMs: result.stat.mtimeMs, size: 7 });
    expect(cache.getMetadata(CONNECTION_ID, '/dir/file.txt')).toEqual(result.stat);
  });

  it('overwrites only after comparing a remembered fresh version', async () => {
    const remote = new MemorySftpClient();
    remote.put('/file', 'old', 100);
    const { writer, cache, prompt } = harness();
    const uri = codec.create(CONNECTION_ID, '/file');
    cache.rememberVersion(uri, { mtimeMs: 100, size: 3 });
    await writer.write(uri, remote, Buffer.from('new'), { create: false, overwrite: true });
    expect(remote.files.get('/file')?.bytes.toString()).toBe('new');
    expect(prompt.confirmOverwrite).not.toHaveBeenCalled();
    expect(remote.calls.some((call) => call.endsWith(':/file:true'))).toBe(true);
  });

  it('cancels before upload when remembered metadata changed externally', async () => {
    const remote = new MemorySftpClient();
    remote.put('/file', 'external', 200);
    const { writer, cache, prompt } = harness();
    const uri = codec.create(CONNECTION_ID, '/file');
    cache.rememberVersion(uri, { mtimeMs: 100, size: 3 });
    vi.mocked(prompt.confirmOverwrite).mockResolvedValueOnce(false);
    await expect(
      writer.write(uri, remote, Buffer.from('editor'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(remote.files.get('/file')?.bytes.toString()).toBe('external');
    expect(remote.calls.some((call) => call.startsWith('write:'))).toBe(false);
  });

  it('rechecks the destination immediately before commit and cleans the temp on conflict', async () => {
    const remote = new MemorySftpClient();
    remote.put('/file', 'old', 100);
    const { writer, cache, prompt } = harness();
    const uri = codec.create(CONNECTION_ID, '/file');
    cache.rememberVersion(uri, { mtimeMs: 100, size: 3 });
    remote.beforeTempStat = () => {
      delete remote.beforeTempStat;
      remote.put('/file', 'external', 200);
    };
    vi.mocked(prompt.confirmOverwrite).mockResolvedValueOnce(false);
    await expect(
      writer.write(uri, remote, Buffer.from('editor'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(remote.files.get('/file')?.bytes.toString()).toBe('external');
    expect([...remote.files.keys()]).toEqual(['/file']);
  });

  it('retries exclusive temporary-name collisions', async () => {
    const remote = new MemorySftpClient();
    remote.put('/.file.easyssh-upload-collision', 'someone else');
    const { writer } = harness(['collision', 'available']);
    const uri = codec.create(CONNECTION_ID, '/file');
    await writer.write(uri, remote, Buffer.from('new'), { create: true, overwrite: false });
    expect(remote.files.get('/.file.easyssh-upload-collision')?.bytes.toString()).toBe(
      'someone else',
    );
    expect(remote.files.get('/file')?.bytes.toString()).toBe('new');
  });

  it('cleans a partial temp after disconnect or cancellation without touching the destination', async () => {
    const remote = new MemorySftpClient();
    remote.put('/file', 'old', 100);
    remote.writeFailure = () => new EasySshError('CONNECTION_LOST', 'upload disconnected');
    const { writer } = harness();
    const uri = codec.create(CONNECTION_ID, '/file');
    await expect(
      writer.write(uri, remote, Buffer.from('new'), { create: false, overwrite: true }),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(remote.files.get('/file')?.bytes.toString()).toBe('old');
    expect([...remote.files.keys()]).toEqual(['/file']);

    const cancelledRemote = new MemorySftpClient();
    const cancellation: CancellationTokenLike = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    cancelledRemote.writeFailure = () => {
      (cancellation as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return undefined;
    };
    await expect(
      writer.write(
        uri,
        cancelledRemote,
        Buffer.from('new'),
        { create: true, overwrite: false },
        cancellation,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelledRemote.files.size).toBe(0);
  });

  it('uses the authorized non-atomic fallback only for unsupported replacement rename', async () => {
    const remote = new MemorySftpClient();
    remote.put('/file', 'old', 100);
    let firstRename = true;
    remote.renameFailure = () => {
      if (firstRename) {
        firstRename = false;
        return new EasySshError('UNSUPPORTED', 'overwrite rename unsupported');
      }
      return undefined;
    };
    const { writer, prompt } = harness();
    const uri = codec.create(CONNECTION_ID, '/file');
    await writer.write(uri, remote, Buffer.from('new'), { create: false, overwrite: true });
    expect(prompt.confirmNonAtomicOverwrite).toHaveBeenCalledOnce();
    expect(remote.files.get('/file')?.bytes.toString()).toBe('new');

    const denied = new MemorySftpClient();
    denied.put('/file', 'old', 100);
    denied.renameFailure = () => new EasySshError('UNSUPPORTED', 'unsupported');
    const deniedHarness = harness();
    vi.mocked(deniedHarness.prompt.confirmNonAtomicOverwrite).mockResolvedValue(false);
    await expect(
      deniedHarness.writer.write(uri, denied, Buffer.from('new'), {
        create: false,
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(denied.files.get('/file')?.bytes.toString()).toBe('old');
    expect([...denied.files.keys()]).toEqual(['/file']);
  });

  it('preserves the primary failure and logs only a failed known-temp cleanup path', async () => {
    const remote = new MemorySftpClient();
    remote.writeFailure = () => new EasySshError('CONNECTION_LOST', 'primary failure');
    remote.unlinkFailure = () => new EasySshError('PERMISSION_DENIED', 'cleanup failed');
    const { writer, logger } = harness();
    await expect(
      writer.write(codec.create(CONNECTION_ID, '/file'), remote, Buffer.from('new'), {
        create: true,
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST', message: 'primary failure' });
    expect(logger.debug).toHaveBeenCalledWith(
      'Unable to clean up an SFTP temporary upload',
      expect.objectContaining({ path: '/.file.easyssh-upload-one' }),
    );
  });
});
