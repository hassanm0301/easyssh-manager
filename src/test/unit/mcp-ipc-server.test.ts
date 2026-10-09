import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpIpcServer, type IpcDispatch } from '../../mcp/IpcServer';
import { IpcFrameDecoder, encodeFrame } from '../../mcp/ipcProtocol';
import { EasySshError } from '../../common/errors';

describe.runIf(process.platform === 'linux')('authenticated MCP IPC server', () => {
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

  it('rejects identity rebinding after the first authenticated frame', async () => {
    let dispatched = 0;
    const socketPath = await startServer(async () => {
      dispatched += 1;
      return { ok: true };
    });
    const socket = connect(socketPath);
    const decoder = new IpcFrameDecoder();
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const firstResponse = new Promise<void>((resolve) =>
      socket.once('data', (chunk) => {
        expect(decoder.push(chunk)).toHaveLength(1);
        resolve();
      }),
    );
    socket.write(encodeFrame(request('bound-first')));
    await firstResponse;
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    socket.write(encodeFrame(request('bound-rebind', { instanceId: 'other-instance' })));
    await closed;
    expect(dispatched).toBe(1);
  });

  it('rejects duplicate request ids on the same authenticated socket', async () => {
    let dispatched = 0;
    let aborted = false;
    const socketPath = await startServer(
      (_method, _params, signal) =>
        new Promise((_resolve, reject) => {
          dispatched += 1;
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
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    socket.write(
      Buffer.concat([encodeFrame(request('duplicate')), encodeFrame(request('duplicate'))]),
    );
    await closed;
    expect(dispatched).toBe(1);
    expect(aborted).toBe(true);
  });

  it('maps internal errors to bounded stable IPC errors without causes', async () => {
    const socketPath = await startServer(async () => {
      throw new EasySshError('NETWORK', 'secret host and password details');
    });
    const response = await exchange(socketPath, request('safe-error'));
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'CONNECTION_FAILED',
        message: 'The SSH connection failed.',
        retryable: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
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

  it('waits for cancelled dispatches before IPC disposal completes', async () => {
    let started!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let settled = false;
    const socketPath = await startServer(
      (_method, _params, signal) =>
        new Promise((resolve) => {
          started();
          signal.addEventListener(
            'abort',
            () =>
              setTimeout(() => {
                settled = true;
                resolve({});
              }, 10),
            { once: true },
          );
        }),
    );
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(encodeFrame(request('shutdown-active')));
    await dispatchStarted;
    await server?.dispose();
    expect(settled).toBe(true);
  });

  it('caps in-flight work globally at eight across companion sockets', async () => {
    let entered = 0;
    let release!: (value: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const socketPath = await startServer(async () => {
      entered += 1;
      return gate;
    });
    const replies = new Map<string, unknown>();
    const sockets = Array.from({ length: 9 }, (_, index) => {
      const socket = connect(socketPath);
      const decoder = new IpcFrameDecoder();
      socket.on('data', (chunk) => {
        for (const response of decoder.push(chunk)) {
          if (response && typeof response === 'object' && 'requestId' in response)
            replies.set(String(response.requestId), response);
        }
      });
      return { socket, index };
    });
    await Promise.all(
      sockets.map(({ socket }) => new Promise<void>((resolve) => socket.once('connect', resolve))),
    );
    for (const { socket, index } of sockets) socket.write(encodeFrame(request(`global-${index}`)));
    await vi.waitFor(() => expect(entered).toBe(8));
    await vi.waitFor(() =>
      expect(replies.get('global-8')).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } }),
    );
    release({ accepted: true });
    await vi.waitFor(() => expect(replies.size).toBe(9));
    for (const { socket } of sockets) socket.destroy();
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
