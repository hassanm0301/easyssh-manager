import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type * as vscode from 'vscode';

import type { EasySshLogger } from '../common/logger';
import type { SshConnectionHandle, SshSessionManager, SshShellHandle } from './ports';

const MAX_PREOPEN_INPUT_BYTES = 64 * 1024;

export class SshTerminalSession implements vscode.Pseudoterminal {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly onDidWrite: vscode.Event<string>;
  readonly onDidClose: vscode.Event<number | void>;
  private readonly writeEmitter: vscode.EventEmitter<string>;
  private readonly closeEmitter: vscode.EventEmitter<number | void>;
  private readonly cancellation: vscode.CancellationTokenSource;
  private dimensions = { columns: 80, rows: 24 };
  private readonly queuedInput: string[] = [];
  private queuedInputBytes = 0;
  private overflowSignalled = false;
  private handle?: SshConnectionHandle;
  private shell?: SshShellHandle;
  private decoders?: { output: StringDecoder; errors: StringDecoder; flushed: boolean };
  private opened = false;
  private disposed = false;
  private closeEmitted = false;

  constructor(
    connectionId: string,
    private readonly sessions: SshSessionManager,
    private readonly vscodeApi: typeof vscode,
    private readonly logger: EasySshLogger,
    uuid: () => string = randomUUID,
  ) {
    this.connectionId = connectionId;
    this.sessionId = uuid();
    this.writeEmitter = new vscodeApi.EventEmitter<string>();
    this.closeEmitter = new vscodeApi.EventEmitter<number | void>();
    this.cancellation = new vscodeApi.CancellationTokenSource();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) this.setDimensions(initialDimensions);
    this.status('Connecting…');
    void this.start();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.shell) {
      this.shell.stream.write(data);
      return;
    }
    const bytes = Buffer.byteLength(data);
    if (this.queuedInputBytes + bytes <= MAX_PREOPEN_INPUT_BYTES) {
      this.queuedInput.push(data);
      this.queuedInputBytes += bytes;
    } else if (!this.overflowSignalled) {
      this.overflowSignalled = true;
      this.writeEmitter.fire('\u0007');
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (
      !Number.isInteger(dimensions.columns) ||
      !Number.isInteger(dimensions.rows) ||
      dimensions.columns <= 0 ||
      dimensions.rows <= 0
    )
      return;
    this.dimensions = { columns: dimensions.columns, rows: dimensions.rows };
    this.shell?.stream.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  close(): void {
    void this[Symbol.asyncDispose]();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancellation.cancel();
    this.queuedInput.length = 0;
    this.queuedInputBytes = 0;
    if (this.shell) await Promise.resolve(this.shell[Symbol.asyncDispose]()).catch(() => undefined);
    if (this.handle)
      await Promise.resolve(this.handle[Symbol.asyncDispose]()).catch(() => undefined);
    this.emitClose();
    this.cancellation.dispose();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private async start(): Promise<void> {
    try {
      const handle = await this.sessions.connect(this.connectionId, {
        kind: 'terminal',
        scopeId: this.sessionId,
        cancellation: this.cancellation.token,
      });
      if (this.disposed) {
        await handle[Symbol.asyncDispose]();
        return;
      }
      this.handle = handle;
      handle.onDidClose((reason) => {
        if (!this.disposed && !this.closeEmitted) this.status(`Connection closed (${reason}).`);
        this.emitClose();
        void this[Symbol.asyncDispose]();
      });
      const shell = await handle.openShell({
        columns: this.dimensions.columns,
        rows: this.dimensions.rows,
        terminal: 'xterm-256color',
      });
      if (this.disposed) {
        await shell[Symbol.asyncDispose]();
        return;
      }
      this.shell = shell;
      this.opened = true;
      const output = new StringDecoder('utf8');
      const errors = new StringDecoder('utf8');
      this.decoders = { output, errors, flushed: false };
      shell.stream.on('data', (chunk: Buffer | string) => this.forward(output, chunk));
      shell.stream.stderr.on('data', (chunk: Buffer | string) => this.forward(errors, chunk));
      shell.stream.once('eof', () => this.remoteClosed('Remote shell ended.'));
      shell.stream.once('close', () => this.remoteClosed('Remote shell closed.'));
      shell.stream.once('error', () => this.remoteClosed('Remote shell failed.'));
      for (const input of this.queuedInput.splice(0)) shell.stream.write(input);
      this.queuedInputBytes = 0;
      this.status('Connected.');
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : 'Unable to open SSH terminal.';
      this.status(message);
      this.emitClose();
      void this[Symbol.asyncDispose]();
    }
  }

  private forward(decoder: StringDecoder, chunk: Buffer | string): void {
    if (this.disposed) return;
    this.writeEmitter.fire(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  }
  private remoteClosed(message: string): void {
    this.flushDecoders();
    if (!this.disposed && !this.closeEmitted) this.status(message);
    this.emitClose();
    void this[Symbol.asyncDispose]();
  }
  private status(message: string): void {
    this.writeEmitter.fire(`\r\n[EasySSH] ${message}\r\n`);
  }
  private flushDecoders(): void {
    if (!this.decoders || this.decoders.flushed || this.disposed) return;
    this.decoders.flushed = true;
    const remaining = `${this.decoders.output.end()}${this.decoders.errors.end()}`;
    if (remaining) this.writeEmitter.fire(remaining);
  }
  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closeEmitter.fire(this.opened ? 0 : 1);
  }
}

export class SshTerminalRegistry {
  private readonly sessions = new Map<string, SshTerminalSession>();
  private readonly terminals = new Map<vscode.Terminal, string>();
  private readonly closeSubscription: vscode.Disposable;

  constructor(
    private readonly vscodeApi: typeof vscode,
    private readonly manager: SshSessionManager,
    private readonly logger: EasySshLogger,
  ) {
    this.closeSubscription = vscodeApi.window.onDidCloseTerminal((terminal) => {
      const id = this.terminals.get(terminal);
      if (id) void this.disposeSession(id);
    });
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  open(connectionId: string, name: string): vscode.Terminal {
    const session = new SshTerminalSession(connectionId, this.manager, this.vscodeApi, this.logger);
    const terminal = this.vscodeApi.window.createTerminal({ name: `SSH: ${name}`, pty: session });
    this.sessions.set(session.sessionId, session);
    this.terminals.set(terminal, session.sessionId);
    session.onDidClose(() => {
      this.sessions.delete(session.sessionId);
      this.terminals.delete(terminal);
    });
    this.logger.debug('SSH terminal registered', {
      operation: 'terminal.open',
      activeSessions: this.sessions.size,
      activeConnections: this.manager.activeConnectionCount,
    });
    terminal.show();
    return terminal;
  }

  async dispose(): Promise<void> {
    this.closeSubscription.dispose();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.terminals.clear();
    await Promise.allSettled(sessions.map((session) => session[Symbol.asyncDispose]()));
  }

  private async disposeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const [terminal, sessionId] of this.terminals)
      if (sessionId === id) this.terminals.delete(terminal);
    await session[Symbol.asyncDispose]();
    this.logger.debug('SSH terminal closed', {
      operation: 'terminal.close',
      activeSessions: this.sessions.size,
      activeConnections: this.manager.activeConnectionCount,
    });
  }
}
