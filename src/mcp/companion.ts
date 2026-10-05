import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import {
  IPC_MAX_CONCURRENT_REQUESTS,
  IPC_PROTOCOL_VERSION,
  IpcFrameDecoder,
  encodeFrame,
  validateIpcRequest,
  validateIpcResponse,
  type IpcMethod,
} from './ipcProtocol';
import { mcpToolSchemas, type McpToolName } from './toolSchemas';
import { MCP_COMPANION_NODE_RANGE, supportedCompanionNode } from './runtime';

const MAX_DISCOVERY_BYTES = 4096;
const UNAVAILABLE_MS = 5000;
const ERROR_CODES = new Set([
  'ACCESS_DENIED',
  'AUTHENTICATION_FAILED',
  'CANCELLED',
  'CONFLICT',
  'CONNECTION_FAILED',
  'CONFIRMATION_DENIED',
  'CONFIRMATION_EXPIRED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'OUTPUT_LIMIT',
  'PATH_NOT_ALLOWED',
  'POLICY_DISABLED',
  'RATE_LIMITED',
  'STALE_VERSION',
  'TIMEOUT',
  'UNAVAILABLE',
]);

interface Discovery {
  protocolVersion: 1;
  instanceId: string;
  socketPath: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

export class McpIpcCompanionClient {
  private active = 0;
  private readonly sockets = new Set<ReturnType<typeof createConnection>>();

  constructor(private readonly discoveryPath: string) {}

  async call(
    method: IpcMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.active >= IPC_MAX_CONCURRENT_REQUESTS)
      throw new Error('RATE_LIMITED: Too many active requests.');
    this.active += 1;
    try {
      if (signal?.aborted) throw new Error('CANCELLED: Request cancelled.');
      const discovery = await readDiscovery(this.discoveryPath);
      return await this.exchange(discovery, method, params, signal);
    } finally {
      this.active -= 1;
    }
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private exchange(
    discovery: Discovery,
    method: IpcMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const socket = createConnection(discovery.socketPath);
      this.sockets.add(socket);
      const decoder = new IpcFrameDecoder();
      let settled = false;
      const timer = setTimeout(
        () => fail('UNAVAILABLE: Start VSCodium and enable the EasySSH MCP bridge.'),
        UNAVAILABLE_MS,
      );
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.sockets.delete(socket);
        socket.destroy();
        action();
      };
      const fail = (message: string): void => finish(() => reject(new Error(message)));
      const onAbort = (): void => fail('CANCELLED: Request cancelled.');
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.setNoDelay(true);
      socket.once('connect', () => {
        if (signal?.aborted) return onAbort();
        try {
          socket.write(
            encodeFrame(
              validateIpcRequest({
                protocolVersion: IPC_PROTOCOL_VERSION,
                requestId,
                instanceId: discovery.instanceId,
                token: discovery.token,
                method,
                params,
              }),
            ),
          );
        } catch {
          fail('UNAVAILABLE: Could not send the request to EasySSH Manager.');
        }
      });
      socket.on('data', (chunk) => {
        try {
          const values = decoder.push(chunk);
          if (values.length > 1) return fail('UNAVAILABLE: Invalid response from EasySSH Manager.');
          if (values.length === 0) return;
          const response = validateIpcResponse(values[0], requestId);
          if (response.ok) finish(() => resolve(response.result));
          else {
            const code = response.error?.code;
            const message = response.error?.message;
            fail(
              `${code && ERROR_CODES.has(code) ? code : 'UNAVAILABLE'}: ${
                typeof message === 'string' ? message.slice(0, 512) : 'Request failed.'
              }`,
            );
          }
        } catch {
          fail('UNAVAILABLE: Invalid response from EasySSH Manager.');
        }
      });
      socket.once('error', () =>
        fail('UNAVAILABLE: Start VSCodium and enable the EasySSH MCP bridge.'),
      );
      socket.once('close', () => {
        if (!settled) {
          try {
            decoder.finish();
          } catch {
            fail('UNAVAILABLE: Incomplete response from EasySSH Manager.');
            return;
          }
          fail('UNAVAILABLE: EasySSH Manager closed the request.');
        }
      });
    });
  }
}

export async function runCompanion(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--self-test') {
    if (!supportedCompanionNode(process.versions.node))
      throw new Error(
        `Unsupported Node.js version. EasySSH MCP requires ${MCP_COMPANION_NODE_RANGE}.`,
      );
    process.stdout.write('EasySSH MCP companion ready.\n');
    return;
  }
  if (args.length !== 2 || args[0] !== '--discovery' || !args[1])
    throw new Error('Usage: companion.js --discovery <absolute-path>');

  const client = new McpIpcCompanionClient(args[1]);
  const handle = serveStdio(
    () => {
      const server = new McpServer(
        { name: 'easyssh-manager', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      for (const [name, schema] of Object.entries(mcpToolSchemas)) {
        registerTool(server, name as McpToolName, schema, client);
      }
      return server;
    },
    {
      onerror: () => undefined,
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: 32 * 1024 * 1024,
      }),
    },
  );

  const shutdown = (): void => {
    client.close();
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('close', shutdown);
}

function registerTool(
  server: McpServer,
  name: McpToolName,
  schema: (typeof mcpToolSchemas)[McpToolName],
  client: McpIpcCompanionClient,
): void {
  server.registerTool(
    name,
    { title: name, description: toolDescription(name), inputSchema: schema as never } as never,
    (async (input: unknown): Promise<CallToolResult> => {
      try {
        const validated = schema.parse(input);
        const result = await client.call(name as IpcMethod, validated as Record<string, unknown>);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const [candidate, ...rest] = message.split(':');
        const code = candidate && ERROR_CODES.has(candidate) ? candidate : 'UNAVAILABLE';
        const safeMessage = rest.join(':').trim().slice(0, 512) || 'Request failed.';
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${safeMessage}` }],
        };
      }
    }) as never,
  );
}

async function readDiscovery(path: string): Promise<Discovery> {
  if (!path.startsWith('/')) throw new Error('UNAVAILABLE: Discovery path must be absolute.');
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_DISCOVERY_BYTES ||
      (info.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw new Error('unsafe discovery file');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isDiscovery(value)) throw new Error('invalid discovery file');
    const now = Date.now();
    if (
      value.createdAt > now ||
      value.expiresAt <= now ||
      value.expiresAt - value.createdAt > 24 * 60 * 60 * 1000
    )
      throw new Error('expired discovery file');
    if (!value.socketPath.startsWith('/') || Buffer.byteLength(value.socketPath) > 100)
      throw new Error('invalid socket path');
    return value;
  } catch {
    throw new Error('UNAVAILABLE: Start VSCodium and enable the EasySSH MCP bridge.');
  }
}

function isDiscovery(value: unknown): value is Discovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') ===
      'createdAt,expiresAt,instanceId,protocolVersion,socketPath,token' &&
    record.protocolVersion === IPC_PROTOCOL_VERSION &&
    typeof record.instanceId === 'string' &&
    record.instanceId.length > 0 &&
    typeof record.socketPath === 'string' &&
    typeof record.token === 'string' &&
    /^[0-9a-f]{64}$/.test(record.token) &&
    typeof record.createdAt === 'number' &&
    typeof record.expiresAt === 'number'
  );
}

function toolDescription(name: string): string {
  return `Perform an authorized ${name} operation through the running EasySSH Manager extension.`;
}

if (require.main === module) {
  void runCompanion(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'EasySSH MCP companion could not start. Check Node.js and discovery settings.\n',
    );
    process.exitCode = 1;
  });
}
