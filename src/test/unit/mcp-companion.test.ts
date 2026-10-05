import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { registerShutdownHandlers } from '../../mcp/companion';

describe('MCP companion shutdown', () => {
  it.each(['SIGINT', 'SIGTERM', 'stdin-close'] as const)(
    'closes active IPC sockets and server on %s',
    async (trigger) => {
      const signals = new EventEmitter();
      const stdin = new EventEmitter();
      const client = { close: vi.fn() };
      const handle = { close: vi.fn(async () => undefined) };
      const exit = vi.fn();
      registerShutdownHandlers(client, handle, exit, signals as never, stdin as never);
      if (trigger === 'stdin-close') stdin.emit('close');
      else signals.emit(trigger);
      signals.emit('SIGTERM');
      stdin.emit('close');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(client.close).toHaveBeenCalledOnce();
      expect(handle.close).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
    },
  );

  it('uses a failure exit code when closing the MCP server fails', async () => {
    const signals = new EventEmitter();
    const stdin = new EventEmitter();
    const exit = vi.fn();
    registerShutdownHandlers(
      { close: vi.fn() },
      { close: vi.fn(async () => Promise.reject(new Error('shutdown failure'))) },
      exit,
      signals as never,
      stdin as never,
    );
    signals.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
