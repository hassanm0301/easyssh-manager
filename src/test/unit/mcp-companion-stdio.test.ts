import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { McpIpcServer } from '../../mcp/IpcServer';

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ text?: string }>;
  };
}

describe.runIf(process.platform === 'linux')('MCP stdio companion integration', () => {
  let directory = '';
  let child: ChildProcessWithoutNullStreams | undefined;
  let ipc: McpIpcServer | undefined;

  afterEach(async () => {
    child?.kill('SIGTERM');
    child = undefined;
    await ipc?.dispose();
    ipc = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('speaks MCP stdio, maps schemas and forwards each call freshly through authenticated IPC', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-mcp-stdio-'));
    const socketPath = join(directory, 'bridge.sock');
    const discoveryPath = join(directory, 'discovery.json');
    const instanceId = randomUUID();
    const token = 'a'.repeat(64);
    let calls = 0;
    ipc = new McpIpcServer({ instanceId, token, socketPath }, async (method, params) => {
      calls += 1;
      expect(method).toBe('remote_list_connections');
      expect(params).toEqual({});
      return [
        {
          id: `fresh-${calls}`,
          name: 'fixture',
          host: 'localhost',
          port: 22,
          username: 'test',
          read: false,
          write: false,
          exec: false,
          allowedRoots: [],
        },
      ];
    });
    await ipc.start();
    const now = Date.now();
    await writeFile(
      discoveryPath,
      JSON.stringify({
        protocolVersion: 1,
        instanceId,
        socketPath,
        token,
        createdAt: now,
        expiresAt: now + 60_000,
      }),
      { mode: 0o600 },
    );

    child = spawn(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        join(process.cwd(), 'src/mcp/companion.ts'),
        '--discovery',
        discoveryPath,
      ],
      { stdio: 'pipe' },
    );
    const reader = new JsonLineReader(child);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`,
    );
    const initialized = await reader.read();
    expect(initialized.jsonrpc).toBe('2.0');
    expect(initialized.id).toBe(1);
    expect(initialized.result?.serverInfo?.name).toBe('easyssh-manager');
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    const listed = await reader.read();
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('remote_list_connections');

    for (const id of [3, 4]) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'remote_list_connections', arguments: {} } })}\n`,
      );
      const result = await reader.read();
      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe(id);
      expect(result.result?.content?.[0]?.text).toContain(`fresh-${id - 2}`);
    }
    expect(calls).toBe(2);
    child.kill('SIGTERM');
    await reader.closed();
    child = undefined;
  }, 15_000);
});

class JsonLineReader {
  private buffer = '';
  private readonly waiting: Array<(value: JsonRpcMessage) => void> = [];
  private readonly rows: JsonRpcMessage[] = [];

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const row = JSON.parse(line) as JsonRpcMessage;
        const resolve = this.waiting.shift();
        if (resolve) resolve(row);
        else this.rows.push(row);
      }
    });
  }

  async read(): Promise<JsonRpcMessage> {
    const row = this.rows.shift();
    if (row) return row;
    return Promise.race([
      new Promise<JsonRpcMessage>((resolve) => this.waiting.push(resolve)),
      delay(5000).then(() => {
        throw new Error('Timed out waiting for companion stdio response.');
      }),
    ]);
  }

  async closed(): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => this.process.once('exit', () => resolve())),
      delay(5000).then(() => {
        throw new Error('Companion did not exit after SIGTERM.');
      }),
    ]);
  }
}
