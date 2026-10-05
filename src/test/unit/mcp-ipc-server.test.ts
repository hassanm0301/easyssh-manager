import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpIpcServer, type IpcDispatch } from '../../mcp/IpcServer';
import { IpcFrameDecoder, encodeFrame } from '../../mcp/ipcProtocol';

describe('authenticated MCP IPC server', () => {
  let directory = '';
  let server: McpIpcServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('binds each request to the activation token and returns only stable results', async () => {
    const socketPath = await startServer(async (method, params) => ({ method, params }));
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const response = await exchange(socketPath, request('r1'));
    expect(response).toMatchObject({
      requestId: 'r1',
      ok: true,
      result: { method: 'remote_list_connections', params: {} },
    });
    const denied = await exchange(socketPath, request('r2', { token: 'f'.repeat(64) }));
    expect(denied).toBeUndefined();
  });

  it('cancels active work when its authenticated socket closes', async () => {
    let aborted = false;
    const socketPath = await startServer(
      (_method, _params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(encodeFrame(request('active')));
    socket.destroy();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  async function startServer(dispatch: IpcDispatch): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-mcp-'));
    const socketPath = join(directory, 'agent.sock');
    server = new McpIpcServer(
      { instanceId: 'activation-1', token: 'a'.repeat(64), socketPath },
      dispatch,
    );
    await server.start();
    return socketPath;
  }
});

function request(requestId: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId,
    instanceId: 'activation-1',
    token: 'a'.repeat(64),
    method: 'remote_list_connections',
    params: {},
    ...extra,
  };
}

function exchange(socketPath: string, value: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const decoder = new IpcFrameDecoder();
    let settled = false;
    const done = (result: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => socket.write(encodeFrame(value)));
    socket.on('data', (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length) done(frames[0]);
    });
    socket.on('error', () => done(undefined));
    socket.on('close', () => done(undefined));
  });
}
