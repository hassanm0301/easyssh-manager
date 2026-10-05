import { describe, expect, it } from 'vitest';

import {
  IPC_MAX_FRAME_BYTES,
  IpcFrameDecoder,
  constantTimeTokenEqual,
  encodeFrame,
  validateIpcRequest,
  validateIpcResponse,
} from '../../mcp/ipcProtocol';

describe('MCP IPC framing and contracts', () => {
  it('decodes fragmented and coalesced length-prefixed JSON frames', () => {
    const decoder = new IpcFrameDecoder();
    const first = encodeFrame({ value: 1 });
    const second = encodeFrame({ value: 2 });
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    decoder.finish();
  });

  it('rejects oversized, malformed, and truncated frames', () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(IPC_MAX_FRAME_BYTES + 1);
    expect(() => new IpcFrameDecoder().push(oversized)).toThrow('size');
    const malformed = Buffer.from([0, 0, 0, 1, 0xff]);
    expect(() => new IpcFrameDecoder().push(malformed)).toThrow('malformed');
    const truncated = new IpcFrameDecoder();
    truncated.push(Buffer.from([0, 0, 0, 2, 0x7b]));
    expect(() => truncated.finish()).toThrow('truncated');
  });

  it('validates exact request and response envelopes', () => {
    const request = {
      protocolVersion: 1,
      requestId: 'r1',
      instanceId: 'i1',
      token: 't1',
      method: 'remote_list_connections',
      params: {},
    };
    expect(validateIpcRequest(request)).toEqual(request);
    expect(() => validateIpcRequest({ ...request, secret: true })).toThrow('invalid');
    expect(() => validateIpcRequest({ ...request, method: 'unknown_method' })).toThrow('invalid');
    expect(() =>
      validateIpcRequest({ ...request, params: JSON.parse('{"__proto__":{"x":1}}') }),
    ).toThrow('invalid');
    expect(
      validateIpcResponse({ protocolVersion: 1, requestId: 'r1', ok: true, result: [] }, 'r1'),
    ).toMatchObject({ ok: true });
    expect(() =>
      validateIpcResponse({ protocolVersion: 1, requestId: 'r2', ok: true }, 'r1'),
    ).toThrow('invalid');
  });

  it('compares tokens without ordinary string equality', () => {
    expect(constantTimeTokenEqual('token', 'token')).toBe(true);
    expect(constantTimeTokenEqual('token', 'wrong')).toBe(false);
    expect(constantTimeTokenEqual('token', 'short')).toBe(false);
  });
});
