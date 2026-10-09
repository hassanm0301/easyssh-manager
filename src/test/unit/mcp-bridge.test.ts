import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpBridge } from '../../mcp/McpBridge';
import { McpIpcServer } from '../../mcp/IpcServer';
import { IpcFrameDecoder, encodeFrame } from '../../mcp/ipcProtocol';

describe.runIf(process.platform === 'linux')('activation-scoped MCP bridge', () => {
  let directory = '';
  let bridge: McpBridge | undefined;
  const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

  afterEach(async () => {
    await bridge?.dispose();
    bridge = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
    if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  });

  it('writes private discovery/socket state, serves an authenticated request, and cleans up', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-bridge-test-'));
    const runtimeDirectory = join(directory, 'runtime');
    await mkdir(runtimeDirectory, { mode: 0o700 });
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    const storage = join(directory, 'global');
    bridge = new McpBridge(storage, async (method, params) => ({ method, params }));

    await bridge.start();
    const first = JSON.parse(await readFile(bridge.discoveryPath, 'utf8')) as {
      protocolVersion: number;
      instanceId: string;
      socketPath: string;
      token: string;
      createdAt: number;
      expiresAt: number;
    };
    expect(Object.keys(first).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'instanceId',
      'protocolVersion',
      'socketPath',
      'token',
    ]);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(bridge.discoveryPath)).mode & 0o777).toBe(0o600);
    expect((await stat(bridge.discoveryPath)).uid).toBe(process.getuid?.());
    const privateDirectory = dirname(first.socketPath);
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(privateDirectory)).uid).toBe(process.getuid?.());
    expect((await stat(first.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(first.socketPath)).uid).toBe(process.getuid?.());
    expect(first.expiresAt).toBeGreaterThan(first.createdAt);

    await expect(ipcCall(first)).resolves.toEqual({
      method: 'remote_list_connections',
      params: {},
    });
    await bridge.dispose();
    await expect(stat(first.socketPath)).rejects.toThrow();
    await expect(stat(privateDirectory)).rejects.toThrow();
    await expect(stat(bridge.discoveryPath)).rejects.toThrow();

    await bridge.start();
    const second = JSON.parse(await readFile(bridge.discoveryPath, 'utf8')) as typeof first;
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(second.token).not.toBe(first.token);
    expect(second.socketPath).not.toBe(first.socketPath);
    expect(second.socketPath).toMatch(/mcp-[0-9a-f]{16}\.sock$/);
    await bridge.dispose();
  });

  it('rejects an unsafe XDG runtime directory instead of placing a socket there', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-bridge-test-'));
    const unsafe = join(directory, 'unsafe');
    await mkdir(unsafe);
    await chmod(unsafe, 0o755);
    process.env.XDG_RUNTIME_DIR = unsafe;
    bridge = new McpBridge(join(directory, 'global'), async () => ({}));
    await expect(bridge.start()).rejects.toThrow('XDG_RUNTIME_DIR');
    await expect(stat(bridge.discoveryPath)).rejects.toThrow();
  });

  it('removes stale activation metadata and refuses to overwrite a live bridge', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-bridge-test-'));
    const runtimeDirectory = join(directory, 'runtime');
    await mkdir(runtimeDirectory, { mode: 0o700 });
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    const storage = join(directory, 'global');
    await mkdir(storage, { mode: 0o700 });
    const staleRuntime = join(runtimeDirectory, `easyssh-mcp-${process.getuid?.()}-deadbeef`);
    await mkdir(staleRuntime, { mode: 0o700 });
    const staleSocket = join(staleRuntime, 'mcp-0123456789abcdef.sock');
    await writeFile(
      join(storage, 'mcp-discovery.json'),
      JSON.stringify({
        protocolVersion: 1,
        instanceId: 'stale-instance',
        socketPath: staleSocket,
        token: 'a'.repeat(64),
        createdAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,
      }),
      { mode: 0o600 },
    );
    await chmod(join(storage, 'mcp-discovery.json'), 0o600);
    bridge = new McpBridge(storage, async () => ({}));
    await bridge.start();
    await expect(stat(staleRuntime)).rejects.toThrow();

    const second = new McpBridge(storage, async () => ({}));
    await expect(second.start()).rejects.toThrow('already active');
  });

  it('cleans private runtime artifacts after a partial startup failure', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-bridge-test-'));
    const runtimeDirectory = join(directory, 'runtime');
    await mkdir(runtimeDirectory, { mode: 0o700 });
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
    const storage = join(directory, 'global');
    bridge = new McpBridge(storage, async () => ({}));
    const start = vi
      .spyOn(McpIpcServer.prototype, 'start')
      .mockRejectedValue(new Error('simulated startup failure'));
    try {
      await expect(bridge.start()).rejects.toThrow('simulated startup failure');
      await expect(stat(bridge.discoveryPath)).rejects.toThrow();
      expect(await readdir(runtimeDirectory)).toEqual([]);
    } finally {
      start.mockRestore();
    }
  });

  it('uses a private short-path temp fallback when XDG_RUNTIME_DIR is unset', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-bridge-test-'));
    delete process.env.XDG_RUNTIME_DIR;
    bridge = new McpBridge(join(directory, 'global'), async () => ({}));
    await bridge.start();
    const discovery = JSON.parse(await readFile(bridge.discoveryPath, 'utf8')) as {
      socketPath: string;
    };
    expect(dirname(discovery.socketPath)).toMatch(/^\/tmp\/easyssh-mcp-/);
    expect(Buffer.byteLength(discovery.socketPath)).toBeLessThanOrEqual(100);
    expect((await stat(dirname(discovery.socketPath))).mode & 0o777).toBe(0o700);
  });
});

function ipcCall(discovery: {
  protocolVersion: number;
  instanceId: string;
  socketPath: string;
  token: string;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(discovery.socketPath);
    const decoder = new IpcFrameDecoder();
    socket.once('connect', () =>
      socket.write(
        encodeFrame({
          protocolVersion: discovery.protocolVersion,
          requestId: 'bridge-test',
          instanceId: discovery.instanceId,
          token: discovery.token,
          method: 'remote_list_connections',
          params: {},
        }),
      ),
    );
    socket.on('data', (chunk) => {
      try {
        const frames = decoder.push(chunk);
        if (!frames.length) return;
        socket.destroy();
        const response = frames[0] as { ok: boolean; result?: unknown };
        if (!response.ok) reject(new Error('Bridge request failed.'));
        else resolve(response.result);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}
