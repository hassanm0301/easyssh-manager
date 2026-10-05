import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { McpIpcCompanionClient } from '../../mcp/companion';
import { IpcFrameDecoder, encodeFrame } from '../../mcp/ipcProtocol';

describe('MCP companion discovery handling', () => {
  let directory = '';
  let silentServer: Server | undefined;
  const silentSockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of silentSockets) socket.destroy();
    silentSockets.clear();
    await new Promise<void>((resolve) => {
      if (!silentServer) return resolve();
      silentServer.close(() => resolve());
      silentServer = undefined;
    });
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('rejects expired discovery before attempting the unavailable socket timeout', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-companion-'));
    const path = join(directory, 'discovery.json');
    const now = Date.now();
    await writeFile(
      path,
      JSON.stringify({
        protocolVersion: 1,
        instanceId: 'expired-instance',
        socketPath: join(directory, 'missing.sock'),
        token: 'b'.repeat(64),
        createdAt: now - 60_000,
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    const client = new McpIpcCompanionClient(path);
    const started = Date.now();
    await expect(client.call('remote_list_connections', {})).rejects.toThrow(
      'UNAVAILABLE: Start VSCodium and enable the EasySSH MCP bridge.',
    );
    expect(Date.now() - started).toBeLessThan(1000);
    client.close();
  });

  it('fails quickly when discovery is valid but its socket is absent', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-companion-'));
    const path = join(directory, 'discovery.json');
    const now = Date.now();
    await writeFile(
      path,
      JSON.stringify({
        protocolVersion: 1,
        instanceId: 'missing-socket-instance',
        socketPath: join(directory, 'missing.sock'),
        token: 'e'.repeat(64),
        createdAt: now,
        expiresAt: now + 60_000,
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    const client = new McpIpcCompanionClient(path);
    const started = Date.now();
    await expect(client.call('remote_list_connections', {})).rejects.toThrow('UNAVAILABLE:');
    expect(Date.now() - started).toBeLessThan(1000);
    client.close();
  });

  it('rejects discovery files with unsafe permissions', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-companion-'));
    const path = join(directory, 'discovery.json');
    const now = Date.now();
    await writeFile(
      path,
      JSON.stringify({
        protocolVersion: 1,
        instanceId: 'unsafe-instance',
        socketPath: join(directory, 'missing.sock'),
        token: 'c'.repeat(64),
        createdAt: now,
        expiresAt: now + 60_000,
      }),
      { mode: 0o644 },
    );
    await chmod(path, 0o644);
    const client = new McpIpcCompanionClient(path);
    await expect(client.call('remote_list_connections', {})).rejects.toThrow('UNAVAILABLE:');
    client.close();
  });

  it('allows a connected MCP request to run longer than the five-second startup bound', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-companion-'));
    const socketPath = join(directory, 'slow.sock');
    silentServer = createServer((socket) => {
      silentSockets.add(socket);
      const decoder = new IpcFrameDecoder();
      let responseTimer: NodeJS.Timeout | undefined;
      socket.on('data', (chunk) => {
        const [request] = decoder.push(chunk) as Array<{ requestId: string }>;
        if (!request) return;
        responseTimer = setTimeout(() => {
          socket.write(
            encodeFrame({
              protocolVersion: 1,
              requestId: request.requestId,
              ok: true,
              result: { delayed: true },
            }),
          );
        }, 5200);
      });
      socket.once('close', () => {
        silentSockets.delete(socket);
        if (responseTimer) clearTimeout(responseTimer);
      });
    });
    await new Promise<void>((resolve, reject) => {
      silentServer?.once('error', reject);
      silentServer?.listen(socketPath, resolve);
    });
    const path = join(directory, 'discovery.json');
    const now = Date.now();
    await writeFile(
      path,
      JSON.stringify({
        protocolVersion: 1,
        instanceId: 'silent-instance',
        socketPath,
        token: 'd'.repeat(64),
        createdAt: now,
        expiresAt: now + 60_000,
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    const client = new McpIpcCompanionClient(path);
    const started = Date.now();
    await expect(client.call('remote_list_connections', {})).resolves.toEqual({ delayed: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5100);
    expect(Date.now() - started).toBeLessThan(7000);
    client.close();
  }, 9000);
});
