import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';

import { McpIpcServer, type IpcDispatch } from './IpcServer';
import { IPC_PROTOCOL_VERSION } from './ipcProtocol';

const DISCOVERY_NAME = 'mcp-discovery.json';
const DISCOVERY_LIFETIME_MS = 12 * 60 * 60 * 1000;
const SOCKET_PATH_MAX = 100;

interface DiscoveryFile {
  protocolVersion: 1;
  instanceId: string;
  socketPath: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

/** Owns activation-scoped IPC credentials, runtime socket, and discovery file. */
export class McpBridge {
  private server: McpIpcServer | undefined;
  private discovery: DiscoveryFile | undefined;
  private runtimeDirectory: string | undefined;
  private disposed = false;

  constructor(
    private readonly globalStoragePath: string,
    private readonly dispatch: IpcDispatch,
  ) {}

  get discoveryPath(): string {
    return join(this.globalStoragePath, DISCOVERY_NAME);
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('MCP bridge already started.');
    this.disposed = false;
    const uid = currentUid();
    await ensurePrivateStorage(this.globalStoragePath, uid);
    await clearStaleActivation(this.discoveryPath, uid);
    const runtimeDirectory = await createRuntimeDirectory(uid);
    this.runtimeDirectory = runtimeDirectory;
    const instanceId = randomUUID();
    const generation = randomUUID();
    const socketPath = join(
      runtimeDirectory,
      `mcp-${generation.replace(/-/g, '').slice(0, 16)}.sock`,
    );
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX)
      throw new Error('A safe short MCP socket path is unavailable.');
    const token = randomBytes(32).toString('hex');
    const createdAt = Date.now();
    const discovery: DiscoveryFile = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      instanceId,
      socketPath,
      token,
      createdAt,
      expiresAt: createdAt + DISCOVERY_LIFETIME_MS,
    };
    const server = new McpIpcServer({ instanceId, token, socketPath }, this.dispatch);
    this.server = server;
    try {
      await server.start();
      await writeDiscovery(this.discoveryPath, discovery, uid);
      this.discovery = discovery;
    } catch (error) {
      await server.dispose();
      await removeSocket(socketPath, uid);
      await removeDiscovery(this.discoveryPath, discovery).catch(() => undefined);
      await removeRuntimeDirectory(runtimeDirectory).catch(() => undefined);
      this.server = undefined;
      this.runtimeDirectory = undefined;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const uid = currentUid();
    await this.server?.dispose();
    this.server = undefined;
    const discovery = this.discovery;
    this.discovery = undefined;
    if (discovery) {
      await removeDiscovery(this.discoveryPath, discovery).catch(() => undefined);
      await removeSocket(discovery.socketPath, uid).catch(() => undefined);
      discovery.token = '';
    }
    const runtimeDirectory = this.runtimeDirectory;
    this.runtimeDirectory = undefined;
    if (runtimeDirectory) await removeRuntimeDirectory(runtimeDirectory).catch(() => undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw new Error('MCP IPC is available on Linux only.');
  return process.getuid();
}

async function ensurePrivateStorage(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
    throw new Error('Extension global storage is not a safe directory.');
  await chmod(path, 0o700);
  if (((await lstat(path)).mode & 0o777) !== 0o700)
    throw new Error('Extension global storage permissions are unsafe.');
}

async function clearStaleActivation(path: string, uid: number): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 4096
  )
    throw new Error('Existing MCP discovery state is unsafe.');

  let old: DiscoveryFile | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isActivationDiscovery(value, uid)) old = value;
  } catch {
    /* A private but malformed stale file can be discarded; it grants no authority. */
  }
  if (old && (await socketIsActive(old.socketPath)))
    throw new Error('Another EasySSH MCP bridge is already active for this user.');

  await unlink(path);
  if (!old) return;
  await removeSocket(old.socketPath, uid);
  await removeRuntimeDirectory(dirname(old.socketPath));
  old.token = '';
}

function isActivationDiscovery(value: unknown, uid: number): value is DiscoveryFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'createdAt,expiresAt,instanceId,protocolVersion,socketPath,token' ||
    record.protocolVersion !== IPC_PROTOCOL_VERSION ||
    typeof record.instanceId !== 'string' ||
    typeof record.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.token) ||
    typeof record.socketPath !== 'string' ||
    typeof record.createdAt !== 'number' ||
    typeof record.expiresAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.expiresAt) ||
    Buffer.byteLength(record.socketPath) > SOCKET_PATH_MAX
  )
    return false;
  const directory = dirname(record.socketPath);
  const runtimeName = `easyssh-mcp-${uid}-`;
  return (
    basename(directory).startsWith(runtimeName) &&
    /^mcp-[0-9a-f]{16}\.sock$/.test(basename(record.socketPath))
  );
}

function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (active: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(active);
    };
    const timer = setTimeout(
      () => finish(false, new Error('Could not safely check existing MCP socket state.')),
      1000,
    );
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'].includes(error.code ?? '')) finish(false);
      else finish(false, error);
    });
  });
}

async function createRuntimeDirectory(uid: number): Promise<string> {
  const xdg = process.env.XDG_RUNTIME_DIR;
  let parent: string;
  if (xdg) {
    parent = resolve(xdg);
    const parentStat = await lstat(parent).catch(() => undefined);
    if (
      !parentStat?.isDirectory() ||
      parentStat.isSymbolicLink() ||
      parentStat.uid !== uid ||
      (parentStat.mode & 0o077) !== 0 ||
      (await realpath(parent)) !== parent
    )
      throw new Error('XDG_RUNTIME_DIR is not a private user-owned directory.');
  } else {
    parent = '/tmp';
    const parentStat = await lstat(parent);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (parentStat.uid !== 0 && parentStat.uid !== uid) ||
      (parentStat.mode & 0o1000) === 0
    )
      throw new Error('A safe temporary directory is unavailable.');
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const child = join(parent, `easyssh-mcp-${uid}-${randomBytes(4).toString('hex')}`);
    try {
      await mkdir(child, { mode: 0o700 });
      const info = await lstat(child);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== uid ||
        (info.mode & 0o777) !== 0o700
      ) {
        await rmdir(child).catch(() => undefined);
        continue;
      }
      if (Buffer.byteLength(join(child, 'mcp-1234567890abcdef.sock')) <= SOCKET_PATH_MAX)
        return child;
      await rmdir(child).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('A private short MCP runtime directory is unavailable.');
}

async function writeDiscovery(path: string, discovery: DiscoveryFile, uid: number): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const payload = Buffer.from(JSON.stringify(discovery), 'utf8');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(payload);
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600)
      throw new Error('MCP discovery file permissions are unsafe.');
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeDiscovery(path: string, own: DiscoveryFile): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return;
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (
    value &&
    typeof value === 'object' &&
    'instanceId' in value &&
    value.instanceId === own.instanceId &&
    'token' in value &&
    value.token === own.token
  )
    await unlink(path);
}

async function removeSocket(path: string, uid: number): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSocket() && info.uid === uid) await unlink(path);
}

async function removeRuntimeDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isDirectory() && !info.isSymbolicLink() && info.uid === currentUid()) await rmdir(path);
}
