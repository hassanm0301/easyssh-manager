import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { McpBridge } from '../../mcp/McpBridge';
import { IpcFrameDecoder, encodeFrame } from '../../mcp/ipcProtocol';

describe('activation-scoped MCP bridge', () => {
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
    const privateDirectory = dirname(first.socketPath);
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(first.socketPath)).mode & 0o777).toBe(0o600);
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
