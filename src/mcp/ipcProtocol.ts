import { timingSafeEqual } from 'node:crypto';

export const IPC_PROTOCOL_VERSION = 1;
export const IPC_MAX_FRAME_BYTES = 24 * 1024 * 1024;
export const IPC_MAX_REQUEST_ID = 128;
export const IPC_MAX_CONCURRENT_REQUESTS = 8;

export const IPC_METHODS = [
  'remote_list_connections',
  'ssh_exec',
  'sftp_list',
  'sftp_stat',
  'sftp_read',
  'sftp_write',
  'sftp_mkdir',
  'sftp_rename',
  'sftp_delete',
  'cancel',
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

export interface IpcRequest {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly instanceId: string;
  readonly token: string;
  readonly method: IpcMethod;
  readonly params: Record<string, unknown>;
}

export interface IpcResponse {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > IPC_MAX_FRAME_BYTES)
    throw new Error('IPC frame size is invalid.');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** Incremental length-prefixed JSON decoder. It never retains more than one capped frame. */
export class IpcFrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (this.pending.length + chunk.length > IPC_MAX_FRAME_BYTES + 4)
      throw new Error('IPC frame size is invalid.');
    this.pending = Buffer.concat([this.pending, chunk]);
    const values: unknown[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length === 0 || length > IPC_MAX_FRAME_BYTES)
        throw new Error('IPC frame size is invalid.');
      if (this.pending.length < length + 4) break;
      let value: unknown;
      try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(
          this.pending.subarray(4, length + 4),
        );
        value = JSON.parse(json);
      } catch {
        throw new Error('IPC frame is malformed.');
      }
      values.push(value);
      this.pending = this.pending.subarray(length + 4);
    }
    return values;
  }

  finish(): void {
    if (this.pending.length !== 0) throw new Error('IPC frame is truncated.');
  }
}

const allowedRequestFields = new Set([
  'protocolVersion',
  'requestId',
  'instanceId',
  'token',
  'method',
  'params',
]);

export function validateIpcRequest(value: unknown): IpcRequest {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowedRequestFields.has(key)))
    throw new Error('IPC request is invalid.');
  if (
    value.protocolVersion !== IPC_PROTOCOL_VERSION ||
    !boundedString(value.requestId, IPC_MAX_REQUEST_ID) ||
    !boundedString(value.instanceId, 128) ||
    !boundedString(value.token, 128) ||
    typeof value.method !== 'string' ||
    !IPC_METHODS.includes(value.method as IpcMethod) ||
    !isSafeRecord(value.params)
  )
    throw new Error('IPC request is invalid.');
  return value as unknown as IpcRequest;
}

export function validateIpcResponse(value: unknown, expectedRequestId: string): IpcResponse {
  if (!isPlainRecord(value)) throw new Error('IPC response is invalid.');
  const keys = Object.keys(value);
  if (
    keys.some((key) => !['protocolVersion', 'requestId', 'ok', 'result', 'error'].includes(key)) ||
    value.protocolVersion !== IPC_PROTOCOL_VERSION ||
    value.requestId !== expectedRequestId ||
    typeof value.ok !== 'boolean' ||
    (value.ok && Object.hasOwn(value, 'error')) ||
    (!value.ok && Object.hasOwn(value, 'result')) ||
    (Object.hasOwn(value, 'result') && !isSafeJsonValue(value.result))
  )
    throw new Error('IPC response is invalid.');
  if (!value.ok) {
    if (
      !isPlainRecord(value.error) ||
      Object.keys(value.error).some((key) => !['code', 'message', 'retryable'].includes(key)) ||
      !boundedString(value.error.code, 64) ||
      !boundedString(value.error.message, 512) ||
      typeof value.error.retryable !== 'boolean'
    )
      throw new Error('IPC response is invalid.');
  }
  return value as unknown as IpcResponse;
}

export function constantTimeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    // Keep a timing-safe operation on unequal-sized values as well.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeRecord(value: unknown, depth = 0): value is Record<string, unknown> {
  if (depth > 32 || !isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, child]) =>
      key !== '__proto__' &&
      key !== 'prototype' &&
      key !== 'constructor' &&
      (child === null ||
        typeof child !== 'object' ||
        (Array.isArray(child)
          ? child.every(
              (item) => item === null || typeof item !== 'object' || isSafeRecord(item, depth + 1),
            )
          : isSafeRecord(child, depth + 1))),
  );
}

function isSafeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every((item) => isSafeJsonValue(item, depth + 1));
  return (
    isSafeRecord(value) && Object.values(value).every((item) => isSafeJsonValue(item, depth + 1))
  );
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
