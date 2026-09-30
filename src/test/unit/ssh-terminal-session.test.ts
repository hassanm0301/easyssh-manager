import { Duplex, PassThrough } from 'node:stream';
import type * as vscode from 'vscode';

import { describe, expect, it, vi } from 'vitest';

import { EasySshLogger } from '../../common/logger';
import { SshTerminalSession } from '../../ssh/SshTerminalSession';
import type {
  ConnectionPurpose,
  Event,
  SshCloseReason,
  SshConnectionHandle,
  SshSessionManager,
} from '../../ssh/ports';

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly event = (listener: (value: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

class CancellationSource {
  private readonly emitter = new Emitter<void>();
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

const api = {
  EventEmitter: Emitter,
  CancellationTokenSource: CancellationSource,
} as unknown as typeof vscode;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class MockChannel extends Duplex {
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  readonly setWindow = vi.fn();
  readonly close = vi.fn();
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(chunk.toString());
    callback();
  }
}

describe('SSH pseudoterminal', () => {
  it('bounds pre-open input, preserves stream bytes, resizes, and cleans up once', async () => {
    const connected = deferred<SshConnectionHandle>();
    const closeEvents = new Emitter<SshCloseReason>();
    const stream = new MockChannel();
    const shellDispose = vi.fn(async () => undefined);
    const handleDispose = vi.fn(async () => undefined);
    const openShell = vi.fn(async () => ({
      stream,
      [Symbol.asyncDispose]: shellDispose,
    }));
    const handle = {
      id: 'handle-1',
      connectionId: 'connection-1',
      client: {},
      onDidClose: closeEvents.event as Event<SshCloseReason>,
      openShell,
      openSftp: vi.fn(),
      exec: vi.fn(),
      [Symbol.asyncDispose]: handleDispose,
    } as unknown as SshConnectionHandle;
    const manager = {
      connect: vi.fn((id: string, purpose: ConnectionPurpose) => {
        void id;
        void purpose;
        return connected.promise;
      }),
      connectCandidate: vi.fn(),
      disposeConnection: vi.fn(),
      disposeAll: vi.fn(),
      activeConnectionCount: 1,
      [Symbol.asyncDispose]: vi.fn(),
    } as unknown as SshSessionManager;
    const logger = new EasySshLogger(
      { appendLine: () => undefined, dispose: () => undefined },
      () => 'debug',
    );
    const terminal = new SshTerminalSession(
      'connection-1',
      manager,
      api,
      logger,
      () => 'session-1',
    );
    const output: string[] = [];
    const closes: (number | void)[] = [];
    terminal.onDidWrite((value) => output.push(value));
    terminal.onDidClose((value) => closes.push(value));
    terminal.open({ columns: 100, rows: 40 });
    terminal.handleInput('queued');
    terminal.handleInput('x'.repeat(64 * 1024));
    expect(output).toContain('\u0007');

    connected.resolve(handle);
    await nextTurn();
    expect(openShell).toHaveBeenCalledWith({
      columns: 100,
      rows: 40,
      terminal: 'xterm-256color',
    });
    expect(stream.writes).toEqual(['queued']);

    terminal.setDimensions({ columns: 120, rows: 50 });
    expect(stream.setWindow).toHaveBeenCalledWith(50, 120, 0, 0);
    const unicode = Buffer.from('🙂');
    stream.emit('data', unicode.subarray(0, 2));
    stream.emit('data', unicode.subarray(2));
    stream.stderr.emit('data', Buffer.from('\u001b[31merror\u001b[0m'));
    expect(output.join('')).toContain('🙂');
    expect(output.join('')).toContain('\u001b[31merror\u001b[0m');

    stream.emit('eof');
    stream.emit('close');
    await nextTurn();
    expect(closes).toEqual([0]);
    expect(shellDispose).toHaveBeenCalledOnce();
    expect(handleDispose).toHaveBeenCalledOnce();
    await terminal[Symbol.asyncDispose]();
    expect(handleDispose).toHaveBeenCalledOnce();
  });
});
