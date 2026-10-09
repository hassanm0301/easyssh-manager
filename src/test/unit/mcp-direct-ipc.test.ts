import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultAgentAccessPolicy,
  emptyPersistedState,
  type RemoteConnection,
} from '../../connections/types';
import { McpAgentService } from '../../mcp/McpAgentService';
import { McpBridge } from '../../mcp/McpBridge';
import { IpcFrameDecoder, encodeFrame } from '../../mcp/ipcProtocol';

const fixtureConnection: RemoteConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'fixture',
  folderId: null,
  order: 0,
  host: '127.0.0.1',
  port: 22,
  username: 'test',
  defaultRemotePath: '/',
  authentication: { type: 'agent' },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
  createdAt: 1,
  updatedAt: 1,
};

describe.runIf(process.platform === 'linux')('direct authenticated IPC authorization', () => {
  let directory = '';
  let bridge: McpBridge | undefined;

  afterEach(async () => {
    await bridge?.dispose();
    bridge = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('enforces the same strict schema and fresh grants without using the stdio companion', async () => {
    const state = emptyPersistedState();
    state.connections.push(structuredClone(fixtureConnection));
    directory = await mkdtemp(join(tmpdir(), 'easyssh-direct-ipc-'));
    const service = new McpAgentService(
      { load: async () => structuredClone(state) },
      {
        connect: async () => {
          throw new Error('SSH must not be reached.');
        },
      } as never,
      {} as never,
      {} as never,
    );
    bridge = new McpBridge(join(directory, 'storage'), (method, params, signal, requestId) =>
      service.dispatch(method, params, signal, requestId),
    );
    await bridge.start();
    const discovery = JSON.parse(await readFile(bridge.discoveryPath, 'utf8')) as {
      instanceId: string;
      socketPath: string;
      token: string;
    };
    const call = (
      requestId: string,
      params: Record<string, unknown>,
    ): Promise<{ ok: boolean; error?: { code: string } }> =>
      new Promise((resolve, reject) => {
        const socket = connect(discovery.socketPath);
        const decoder = new IpcFrameDecoder();
        socket.once('connect', () => {
          socket.write(
            encodeFrame({
              protocolVersion: 1,
              requestId,
              instanceId: discovery.instanceId,
              token: discovery.token,
              method: 'ssh_exec',
              params,
            }),
          );
        });
        socket.once('data', (chunk) => {
          try {
            const [response] = decoder.push(chunk) as Array<{
              ok: boolean;
              error?: { code: string };
            }>;
            if (!response) throw new Error('IPC returned an empty response.');
            resolve(response);
          } catch (error) {
            reject(error);
          } finally {
            socket.destroy();
          }
        });
        socket.once('error', reject);
      });

    const malformed = await call('malformed', {
      connectionId: fixtureConnection.id,
      command: 'id',
      privateKey: 'must-not-be-accepted',
    });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(malformed)).not.toContain('must-not-be-accepted');
    const disabled = await call('disabled', {
      connectionId: fixtureConnection.id,
      command: 'id',
    });
    expect(disabled).toMatchObject({ ok: false, error: { code: 'POLICY_DISABLED' } });

    state.connections[0]!.agentAccess = {
      ...defaultAgentAccessPolicy(),
      enabled: true,
      allowExec: false,
    };
    const grantDenied = await call('grant-denied', {
      connectionId: fixtureConnection.id,
      command: 'id',
    });
    expect(grantDenied).toMatchObject({ ok: false, error: { code: 'ACCESS_DENIED' } });
  });
});
