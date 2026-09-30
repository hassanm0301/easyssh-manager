import type * as ssh2 from 'ssh2';

import type { ConnectionId, RemoteConnection } from '../connections/types';

export interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: (listener: () => unknown) => { dispose(): void };
}

export interface CredentialLease extends AsyncDisposable {
  readonly password?: string;
  readonly privateKey?: Uint8Array;
  readonly passphrase?: string;
  readonly agentSocket?: string;
}

export interface ConnectionResolver {
  resolve(connectionId: string): Promise<Readonly<RemoteConnection>>;
}

export interface CredentialScope {
  kind: 'terminal' | 'sftp';
  scopeId: string;
}

export interface TransientCredentials {
  /** null explicitly suppresses a stored value for an unsaved editor candidate. */
  password?: string | null;
  passphrase?: string | null;
}

export interface CredentialResolver {
  acquire(
    connection: RemoteConnection,
    scope: CredentialScope,
    transient?: Readonly<TransientCredentials>,
  ): Promise<CredentialLease>;
}

export interface PtyOptions {
  columns: number;
  rows: number;
  terminal?: string;
}

export interface ExecOptions {
  command: string;
}

export interface SshShellHandle extends AsyncDisposable {
  readonly stream: ssh2.ClientChannel;
}

export interface SftpSubsystemHandle extends AsyncDisposable {
  readonly sftp: ssh2.SFTPWrapper;
}

export interface ExecHandle extends AsyncDisposable {
  readonly stream: ssh2.ClientChannel;
}

export type SshCloseReason = 'remote-end' | 'remote-close' | 'error' | 'disposed';
export type Event<T> = (listener: (event: T) => unknown) => { dispose(): void };

export interface SshConnectionHandle extends AsyncDisposable {
  readonly id: string;
  readonly connectionId: string;
  readonly client: ssh2.Client;
  readonly onDidClose: Event<SshCloseReason>;
  openShell(options: PtyOptions): Promise<SshShellHandle>;
  openSftp(): Promise<SftpSubsystemHandle>;
  exec(options: ExecOptions): Promise<ExecHandle>;
}

export interface ConnectionPurpose {
  kind: 'terminal' | 'sftp' | 'test';
  scopeId: string;
  cancellation?: CancellationTokenLike;
  transientCredentials?: Readonly<TransientCredentials>;
}

export interface SshSessionManager extends AsyncDisposable {
  connect(connectionId: ConnectionId, purpose: ConnectionPurpose): Promise<SshConnectionHandle>;
  connectCandidate(
    connection: RemoteConnection,
    purpose: ConnectionPurpose,
  ): Promise<SshConnectionHandle>;
  disposeConnection(handleId: string): Promise<void>;
  disposeAll(): Promise<void>;
  readonly activeConnectionCount: number;
}

export interface SshTerminalSessionLike extends AsyncDisposable {
  readonly sessionId: string;
  readonly connectionId: string;
}
