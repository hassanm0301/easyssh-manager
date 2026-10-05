import { chmod, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import {
  IPC_MAX_CONCURRENT_REQUESTS,
  IPC_PROTOCOL_VERSION,
  IpcFrameDecoder,
  constantTimeTokenEqual,
  encodeFrame,
  validateIpcRequest,
  validateIpcResponse,
  type IpcMethod,
} from './ipcProtocol';

export interface IpcServerIdentity {
  readonly instanceId: string;
  readonly token: string;
  readonly socketPath: string;
}

export interface IpcDispatch {
  (
    method: Exclude<IpcMethod, 'cancel'>,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const ERRORS: Record<string, { code: string; message: string; retryable: boolean }> = {
  ACCESS_DENIED: {
    code: 'ACCESS_DENIED',
    message: 'The requested operation is not authorized.',
    retryable: false,
  },
  CANCELLED: { code: 'CANCELLED', message: 'The request was cancelled.', retryable: true },
  CONFLICT: { code: 'CONFLICT', message: 'The remote resource changed.', retryable: true },
  CONNECTION_FAILED: {
    code: 'CONNECTION_FAILED',
    message: 'The SSH connection failed.',
    retryable: true,
  },
  CONFIRMATION_DENIED: {
    code: 'CONFIRMATION_DENIED',
    message: 'The operation was denied.',
    retryable: false,
  },
  CONFIRMATION_EXPIRED: {
    code: 'CONFIRMATION_EXPIRED',
    message: 'The confirmation expired.',
    retryable: false,
  },
  INVALID_INPUT: { code: 'INVALID_INPUT', message: 'The request is invalid.', retryable: false },
  OUTPUT_LIMIT: {
    code: 'OUTPUT_LIMIT',
    message: 'The operation exceeded its output limit.',
    retryable: false,
  },
  PATH_NOT_ALLOWED: {
    code: 'PATH_NOT_ALLOWED',
    message: 'The path is outside the allowed roots.',
    retryable: false,
  },
  POLICY_DISABLED: {
    code: 'POLICY_DISABLED',
    message: 'Agent access is disabled for this connection.',
    retryable: false,
  },
  RATE_LIMITED: { code: 'RATE_LIMITED', message: 'Too many requests are active.', retryable: true },
  STALE_VERSION: {
    code: 'STALE_VERSION',
    message: 'The remote file version no longer matches.',
    retryable: true,
  },
  TIMEOUT: { code: 'TIMEOUT', message: 'The operation timed out.', retryable: true },
  UNAVAILABLE: {
    code: 'UNAVAILABLE',
    message: 'The extension service is unavailable.',
    retryable: true,
  },
};

/** Authenticated, one-frame identity binding and bounded request dispatch over a Unix socket. */
export class McpIpcServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private accepting = false;

  constructor(
    private readonly identity: IpcServerIdentity,
    private readonly dispatch: IpcDispatch,
  ) {}

  async start(): Promise<void> {
    if (this.server) throw new Error('IPC server already started.');
    if (
      !this.identity.socketPath.startsWith('/') ||
      Buffer.byteLength(this.identity.socketPath) > 100 ||
      !/^[0-9a-f]{64}$/.test(this.identity.token) ||
      this.identity.instanceId.length === 0 ||
      this.identity.instanceId.length > 128
    )
      throw new Error('IPC server identity is invalid.');
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.identity.socketPath);
    });
    try {
      await chmod(this.identity.socketPath, 0o600);
      this.accepting = true;
    } catch (error) {
      await this.dispose();
      await unlink(this.identity.socketPath).catch(() => undefined);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.accepting = false;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    if (!this.accepting) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const decoder = new IpcFrameDecoder();
    const active = new Map<string, AbortController>();
    const seen = new Set<string>();
    let authenticated = false;
    let frameCount = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      try {
        const requests = decoder.push(chunk);
        for (const raw of requests) {
          frameCount += 1;
          if (frameCount > 1024) throw new Error('IPC request limit exceeded.');
          const request = validateIpcRequest(raw);
          if (
            request.instanceId !== this.identity.instanceId ||
            !constantTimeTokenEqual(request.token, this.identity.token)
          )
            throw new Error('IPC authentication failed.');
          authenticated = true;
          if (seen.has(request.requestId)) throw new Error('Duplicate IPC request id.');
          seen.add(request.requestId);
          if (request.method === 'cancel') {
            const target = request.params.requestId;
            if (
              Object.keys(request.params).length !== 1 ||
              typeof target !== 'string' ||
              target.length === 0 ||
              target.length > 128
            )
              throw new Error('Invalid IPC cancellation.');
            const controller = active.get(target);
            controller?.abort();
            this.respond(socket, request.requestId, true, { cancelled: controller !== undefined });
            continue;
          }
          if (active.size >= IPC_MAX_CONCURRENT_REQUESTS) {
            this.respond(socket, request.requestId, false, undefined, ERRORS.RATE_LIMITED);
            continue;
          }
          const controller = new AbortController();
          active.set(request.requestId, controller);
          void this.dispatch(request.method, request.params, controller.signal)
            .then(
              (result) => this.respond(socket, request.requestId, true, result),
              (error: unknown) =>
                this.respond(socket, request.requestId, false, undefined, stableError(error)),
            )
            .finally(() => active.delete(request.requestId));
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once('close', () => {
      this.sockets.delete(socket);
      for (const controller of active.values()) controller.abort();
      active.clear();
    });
    socket.once('error', () => {
      if (!authenticated) socket.destroy();
    });
  }

  private respond(
    socket: Socket,
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: { code: string; message: string; retryable: boolean },
  ): void {
    if (socket.destroyed) return;
    try {
      const response = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        requestId,
        ok,
        ...(ok ? { result } : { error }),
      };
      socket.write(encodeFrame(validateIpcResponse(response, requestId)));
    } catch {
      socket.destroy();
    }
  }
}

function stableError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error && typeof error === 'object' && 'code' in error) {
    const mapped = ERRORS[String(error.code)];
    if (mapped) return mapped;
  }
  return ERRORS.UNAVAILABLE!;
}
