import type { Readable, Writable } from 'node:stream';
import type { FileEntryWithStats, OpenMode, SFTPWrapper, Stats } from 'ssh2';

import { EasySshError } from '../common/errors';
import { normalizeRemotePath } from './SftpUriCodec';
import type {
  RemoteDirectoryEntry,
  RemoteEntryKind,
  RemoteStat,
  RemoteWriteOptions,
  SftpClient,
} from './ports';

type SftpError = Error & { code?: number | string };

const SFTP_STATUS = {
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

const FILE_TYPE_MASK = 0o170000;
const FILE_TYPE = {
  directory: 0o040000,
  file: 0o100000,
  symbolicLink: 0o120000,
} as const;

export class Ssh2SftpClient implements SftpClient {
  private closed = false;
  private terminalError: EasySshError | undefined;

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly operationTimeoutMs = 30_000,
    private readonly closeOwner?: () => void | PromiseLike<void>,
  ) {
    // A lifecycle listener prevents late protocol errors from becoming unhandled events.
    this.sftp.on('error', this.onTransportError);
    this.sftp.on('end', this.onTransportEnd);
    this.sftp.on('close', this.onTransportClose);
  }

  async lstat(path: string): Promise<RemoteStat> {
    const remotePath = this.path(path);
    const value = await this.callback<Stats>('lstat', remotePath, (done) =>
      this.sftp.lstat(remotePath, done),
    );
    return remoteStat(value, remotePath);
  }

  async stat(path: string): Promise<RemoteStat> {
    const remotePath = this.path(path);
    const value = await this.callback<Stats>('stat', remotePath, (done) =>
      this.sftp.stat(remotePath, done),
    );
    return remoteStat(value, remotePath);
  }

  async realpath(path: string): Promise<string> {
    const remotePath = this.path(path);
    const resolved = await this.callback<string>('realpath', remotePath, (done) =>
      this.sftp.realpath(remotePath, done),
    );
    return normalizeRemotePath(assertRemoteString(resolved, remotePath, 'realpath'));
  }

  async readlink(path: string): Promise<string> {
    const remotePath = this.path(path);
    const target = await this.callback<string>('readlink', remotePath, (done) =>
      this.sftp.readlink(remotePath, done),
    );
    return assertRemoteString(target, remotePath, 'link target');
  }

  async readDirectory(path: string): Promise<RemoteDirectoryEntry[]> {
    const remotePath = this.path(path);
    const entries = await this.callback<FileEntryWithStats[]>('readdir', remotePath, (done) =>
      this.sftp.readdir(remotePath, done),
    );
    if (!Array.isArray(entries)) throw invalidResponse(remotePath, 'directory listing');
    return entries.map((entry) => remoteDirectoryEntry(entry, remotePath));
  }

  async readFile(path: string, range?: { offset: number; length: number }): Promise<Uint8Array> {
    const remotePath = this.path(path);
    const validatedRange = validateRange(range);
    if (validatedRange?.length === 0) return new Uint8Array();
    this.assertOpen(remotePath);
    let stream: Readable;
    try {
      stream = this.sftp.createReadStream(remotePath, {
        autoClose: true,
        ...(validatedRange === undefined
          ? {}
          : {
              start: validatedRange.offset,
              end: validatedRange.offset + validatedRange.length - 1,
            }),
      });
    } catch (error) {
      throw mapSftpError(error, remotePath, 'read');
    }
    try {
      return await readStreamFully(stream, remotePath, this.operationTimeoutMs);
    } catch (error) {
      if (this.terminalError) throw this.terminalError;
      throw error;
    }
  }

  async writeFile(path: string, data: Uint8Array, options: RemoteWriteOptions): Promise<void> {
    const remotePath = this.path(path);
    if (!(data instanceof Uint8Array)) {
      throw new EasySshError('VALIDATION', `Write data for '${remotePath}' must be bytes.`);
    }
    validateWriteOptions(options, remotePath);
    if (!options.create) {
      await this.lstat(remotePath);
      if (!options.overwrite) {
        throw new EasySshError('ALREADY_EXISTS', `Remote path '${remotePath}' already exists.`);
      }
    }
    this.assertOpen(remotePath);
    const flags: OpenMode = options.overwrite ? 'w' : 'wx';
    let stream: Writable;
    try {
      stream = this.sftp.createWriteStream(remotePath, {
        flags,
        autoClose: true,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
    } catch (error) {
      throw mapSftpError(error, remotePath, options.overwrite ? 'write' : 'exclusive-create');
    }
    try {
      await writeStreamFully(
        stream,
        Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        remotePath,
        this.operationTimeoutMs,
        options.overwrite ? 'write' : 'exclusive-create',
      );
    } catch (error) {
      if (this.terminalError) throw this.terminalError;
      throw error;
    }
  }

  createWriteStream(path: string, options: RemoteWriteOptions): Writable {
    const remotePath = this.path(path);
    validateWriteOptions(options, remotePath);
    this.assertOpen(remotePath);
    try {
      return this.sftp.createWriteStream(remotePath, {
        flags: options.overwrite ? 'w' : 'wx',
        autoClose: true,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
    } catch (error) {
      throw mapSftpError(error, remotePath, options.overwrite ? 'write' : 'exclusive-create');
    }
  }

  async mkdir(path: string): Promise<void> {
    const remotePath = this.path(path);
    await this.callbackVoid('mkdir', remotePath, (done) => this.sftp.mkdir(remotePath, done));
  }

  async rename(source: string, target: string, overwrite: boolean): Promise<void> {
    const sourcePath = this.path(source);
    const targetPath = this.path(target);
    if (sourcePath === targetPath) return;
    if (!overwrite) {
      try {
        await this.lstat(targetPath);
        throw new EasySshError('ALREADY_EXISTS', `Remote path '${targetPath}' already exists.`);
      } catch (error) {
        if (!(error instanceof EasySshError) || error.code !== 'NOT_FOUND') throw error;
      }
    }
    await this.callbackVoid(
      overwrite ? 'atomic overwrite rename' : 'rename',
      sourcePath,
      (done) => {
        if (overwrite) this.sftp.ext_openssh_rename(sourcePath, targetPath, done);
        else this.sftp.rename(sourcePath, targetPath, done);
      },
    );
  }

  async unlink(path: string): Promise<void> {
    const remotePath = this.path(path);
    await this.callbackVoid('unlink', remotePath, (done) => this.sftp.unlink(remotePath, done));
  }

  async rmdir(path: string): Promise<void> {
    const remotePath = this.path(path);
    await this.callbackVoid('rmdir', remotePath, (done) => this.sftp.rmdir(remotePath, done));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sftp.end();
    } catch {
      // The underlying channel may already be closed. Close remains idempotent.
    }
    await this.closeOwner?.();
  }

  private path(path: string): string {
    this.assertOpen(path);
    return normalizeRemotePath(path);
  }

  private assertOpen(path: string): void {
    if (this.terminalError) throw this.terminalError;
    if (this.closed) {
      throw new EasySshError('CONNECTION_LOST', `SFTP connection is closed for '${path}'.`);
    }
  }

  private readonly onTransportError = (error: Error): void => {
    this.terminalError = mapSftpError(error, '/', 'transport');
  };

  private readonly onTransportEnd = (): void => {
    this.terminalError = new EasySshError('CONNECTION_LOST', 'SFTP connection ended.');
  };

  private readonly onTransportClose = (): void => {
    this.terminalError = new EasySshError('CONNECTION_LOST', 'SFTP connection closed.');
  };

  private callback<T>(
    operation: string,
    path: string,
    register: (done: (error: Error | undefined, value: T) => void) => void,
  ): Promise<T> {
    this.assertOpen(path);
    return sftpCallback(this.sftp, register, {
      operation,
      path,
      timeoutMs: this.operationTimeoutMs,
    }).catch((error: unknown) => {
      if (this.terminalError) throw this.terminalError;
      throw error;
    });
  }

  private callbackVoid(
    operation: string,
    path: string,
    register: (done: (error?: Error | null) => void) => void,
  ): Promise<void> {
    return this.callback<void>(operation, path, (done) =>
      register((error) => done(error ?? undefined, undefined)),
    );
  }
}

interface CallbackOptions {
  readonly operation: string;
  readonly path: string;
  readonly timeoutMs: number;
}

export function sftpCallback<T>(
  sftp: SFTPWrapper,
  register: (done: (error: Error | undefined, value: T) => void) => void,
  options: CallbackOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(
          new EasySshError(
            'TIMEOUT',
            `Remote ${options.operation} timed out for '${options.path}'.`,
          ),
        ),
      options.timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      sftp.removeListener('error', onError);
      sftp.removeListener('end', onEnd);
      sftp.removeListener('close', onClose);
    };
    const finish = (error: EasySshError | undefined, value?: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value as T);
    };
    const onError = (error: Error): void =>
      finish(mapSftpError(error, options.path, options.operation));
    const onEnd = (): void =>
      finish(
        new EasySshError('CONNECTION_LOST', `SFTP connection ended during '${options.path}'.`),
      );
    const onClose = (): void =>
      finish(
        new EasySshError('CONNECTION_LOST', `SFTP connection closed during '${options.path}'.`),
      );
    sftp.once('error', onError);
    sftp.once('end', onEnd);
    sftp.once('close', onClose);
    try {
      register((error, value) => {
        if (error) finish(mapSftpError(error, options.path, options.operation));
        else finish(undefined, value);
      });
    } catch (error) {
      finish(mapSftpError(error, options.path, options.operation));
    }
  });
}

export function readStreamFully(
  stream: Readable,
  path: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let ended = false;
    let closed = false;
    const timer = setTimeout(
      () => finish(new EasySshError('TIMEOUT', `Remote read timed out for '${path}'.`)),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const finish = (error?: EasySshError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        safelyDestroyStream(stream);
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: string | Buffer): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = (): void => {
      ended = true;
      if (closed) finish();
    };
    const onError = (error: Error): void => finish(mapSftpError(error, path, 'read'));
    const onClose = (): void => {
      closed = true;
      if (!ended && !stream.readableEnded) {
        finish(new EasySshError('CONNECTION_LOST', `Remote read closed early for '${path}'.`));
      } else if (ended || stream.readableEnded) finish();
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

export function writeStreamFully(
  stream: Writable,
  data: Buffer,
  path: string,
  timeoutMs: number,
  operation = 'write',
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new EasySshError('TIMEOUT', `Remote write timed out for '${path}'.`)),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };
    const finish = (error?: EasySshError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        safelyDestroyStream(stream);
        reject(error);
      } else resolve();
    };
    const onError = (error: Error): void => finish(mapSftpError(error, path, operation));
    const onClose = (): void => {
      // ssh2 closes the confirmed remote handle before Node emits `finish`.
      // Stream/protocol failures arrive through `error`; a clean close is durable completion.
      finish();
    };
    stream.once('error', onError);
    stream.once('close', onClose);
    try {
      stream.end(data);
    } catch (error) {
      finish(mapSftpError(error, path, operation));
    }
  });
}

export function mapSftpError(error: unknown, path: string, operation: string): EasySshError {
  if (error instanceof EasySshError) return error;
  const value = error as SftpError;
  const code = value?.code;
  const message = value?.message ?? '';
  if (code === SFTP_STATUS.NO_SUCH_FILE || code === 'ENOENT') {
    return new EasySshError('NOT_FOUND', `Remote path '${path}' was not found.`, error);
  }
  if (code === 'EEXIST') {
    return new EasySshError('ALREADY_EXISTS', `Remote path '${path}' already exists.`, error);
  }
  if (code === SFTP_STATUS.PERMISSION_DENIED || code === 'EACCES' || code === 'EPERM') {
    return new EasySshError('PERMISSION_DENIED', `Permission denied for '${path}'.`, error);
  }
  if (code === 'ENOTDIR' || /not a directory/i.test(message)) {
    return new EasySshError('NOT_DIRECTORY', `Remote path '${path}' is not a directory.`, error);
  }
  if (code === 'EISDIR' || /is a directory/i.test(message)) {
    return new EasySshError('IS_DIRECTORY', `Remote path '${path}' is a directory.`, error);
  }
  if (
    code === SFTP_STATUS.OP_UNSUPPORTED ||
    code === 'ENOSYS' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOTSUP'
  ) {
    return new EasySshError(
      'UNSUPPORTED',
      `Remote ${operation} is not supported for '${path}'.`,
      error,
    );
  }
  if (
    code === SFTP_STATUS.NO_CONNECTION ||
    code === SFTP_STATUS.CONNECTION_LOST ||
    ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTCONN'].includes(String(code))
  ) {
    return new EasySshError('CONNECTION_LOST', `SFTP connection lost during '${path}'.`, error);
  }
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) {
    return new EasySshError('TIMEOUT', `Remote ${operation} timed out for '${path}'.`, error);
  }
  // SFTP v3 reports an exclusive-open collision as the otherwise-generic FAILURE status.
  if (operation === 'exclusive-create') {
    return new EasySshError('ALREADY_EXISTS', `Remote path '${path}' already exists.`, error);
  }
  return new EasySshError('REMOTE_IO', `Remote ${operation} failed for '${path}'.`, error);
}

export function remoteStat(attributes: Stats, path: string): RemoteStat {
  if (attributes === null || typeof attributes !== 'object') {
    throw invalidResponse(path, 'attributes');
  }
  const size = safeInteger(attributes.size, path, 'size', true);
  const mtimeMs = secondsToMilliseconds(attributes.mtime, path, 'mtime');
  const mode = optionalSafeInteger(attributes.mode, path, 'mode', true);
  const uid = optionalSafeInteger(attributes.uid, path, 'uid', true);
  const gid = optionalSafeInteger(attributes.gid, path, 'gid', true);
  const atimeMs =
    attributes.atime === undefined
      ? undefined
      : secondsToMilliseconds(attributes.atime, path, 'atime');
  return {
    kind: kindFromMode(mode),
    size,
    ...(mode === undefined ? {} : { mode }),
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
    ...(atimeMs === undefined ? {} : { atimeMs }),
    mtimeMs,
  };
}

function kindFromMode(mode: number | undefined): RemoteEntryKind {
  switch ((mode ?? 0) & FILE_TYPE_MASK) {
    case FILE_TYPE.file:
      return 'file';
    case FILE_TYPE.directory:
      return 'directory';
    case FILE_TYPE.symbolicLink:
      return 'symbolicLink';
    default:
      return 'other';
  }
}

function validateRange(
  range: { offset: number; length: number } | undefined,
): { offset: number; length: number } | undefined {
  if (range === undefined) return undefined;
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.length) ||
    range.length < 0 ||
    !Number.isSafeInteger(range.offset + range.length)
  ) {
    throw new EasySshError(
      'VALIDATION',
      'SFTP read range must contain safe non-negative integers.',
    );
  }
  return range;
}

function validateWriteOptions(options: RemoteWriteOptions, path: string): void {
  if (typeof options.create !== 'boolean' || typeof options.overwrite !== 'boolean') {
    throw new EasySshError('VALIDATION', `Invalid write options for '${path}'.`);
  }
  if (
    options.mode !== undefined &&
    (!Number.isSafeInteger(options.mode) || options.mode < 0 || options.mode > 0o7777)
  ) {
    throw new EasySshError('VALIDATION', `Invalid write mode for '${path}'.`);
  }
}

function directoryEntryName(name: unknown, path: string): string {
  const value = assertRemoteString(name, path, 'directory entry');
  if (value.length === 0 || value.includes('/'))
    throw invalidResponse(path, 'directory entry name');
  return value;
}

function remoteDirectoryEntry(entry: unknown, parentPath: string): RemoteDirectoryEntry {
  if (entry === null || typeof entry !== 'object') {
    throw invalidResponse(parentPath, 'directory entry');
  }
  const value = entry as { filename?: unknown; attrs?: unknown };
  const name = directoryEntryName(value.filename, parentPath);
  const childPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
  return { name, stat: remoteStat(value.attrs as Stats, childPath) };
}

function safelyDestroyStream(stream: Readable | Writable): void {
  const swallowLateError = (): void => undefined;
  stream.on('error', swallowLateError);
  stream.once('close', () => stream.removeListener('error', swallowLateError));
  try {
    stream.destroy();
  } catch {
    stream.removeListener('error', swallowLateError);
  }
}

function assertRemoteString(value: unknown, path: string, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || hasMalformedUtf16(value)) {
    throw invalidResponse(path, label);
  }
  return value;
}

function hasMalformedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function optionalSafeInteger(
  value: unknown,
  path: string,
  label: string,
  nonNegative: boolean,
): number | undefined {
  return value === undefined ? undefined : safeInteger(value, path, label, nonNegative);
}

function safeInteger(value: unknown, path: string, label: string, nonNegative: boolean): number {
  if (!Number.isSafeInteger(value) || (nonNegative && (value as number) < 0)) {
    throw invalidResponse(path, label);
  }
  return value as number;
}

function secondsToMilliseconds(value: unknown, path: string, label: string): number {
  const seconds = safeInteger(value, path, label, false);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw invalidResponse(path, label);
  return milliseconds;
}

function invalidResponse(path: string, label: string): EasySshError {
  return new EasySshError('REMOTE_IO', `Invalid remote ${label} received for '${path}'.`);
}
