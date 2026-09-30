import { randomUUID } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';

import { EasySshError } from '../common/errors';
import type { EasySshConfiguration } from '../configuration/ConfigurationService';
import type { RemoteConnection } from '../connections/types';
import { openExec, openSftp, openShell } from './adapters';
import type { HostKeyVerifier } from './HostKeyVerifier';
import type {
  CancellationTokenLike,
  CredentialLease,
  Event,
  ExecHandle,
  ExecOptions,
  PtyOptions,
  SftpSubsystemHandle,
  SshCloseReason,
  SshConnectionHandle,
  SshShellHandle,
} from './ports';

export class SshClientFactory {
  constructor(
    private readonly hostKeys: HostKeyVerifier,
    private readonly getConfiguration: () => Readonly<EasySshConfiguration>,
    private readonly createClient: () => Client = () => new Client(),
    private readonly uuid: () => string = randomUUID,
  ) {}

  async connect(
    connection: RemoteConnection,
    lease: CredentialLease,
    cancellation?: CancellationTokenLike,
  ): Promise<SshConnectionHandle> {
    if (cancellation?.isCancellationRequested) {
      await lease[Symbol.asyncDispose]();
      throw new EasySshError('CANCELLED', 'Connection cancelled.');
    }
    let client: Client;
    let settings: Readonly<EasySshConfiguration>;
    try {
      client = this.createClient();
      settings = this.getConfiguration();
    } catch (error) {
      await lease[Symbol.asyncDispose]();
      throw mapSshError(error, connection);
    }
    const readyTimeout = connection.options.readyTimeoutMs ?? settings.connectTimeoutMs;
    return new Promise<SshConnectionHandle>((resolve, reject) => {
      let trustFailure: EasySshError | undefined;
      let settled = false;
      const timeout = setTimeout(
        () => finish(new EasySshError('TIMEOUT', `Connection to ${connection.name} timed out.`)),
        readyTimeout + 250,
      );
      const cancellationSubscription = cancellation?.onCancellationRequested(() => {
        finish(new EasySshError('CANCELLED', 'Connection cancelled.'));
      });
      const cleanupInitial = (): void => {
        clearTimeout(timeout);
        cancellationSubscription?.dispose();
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
        client.removeListener('end', onEnd);
        client.removeListener('timeout', onTimeout);
      };
      const finish = (error?: EasySshError): void => {
        if (settled) return;
        settled = true;
        cleanupInitial();
        if (error) {
          safelyCloseClient(client);
          void lease[Symbol.asyncDispose]();
          reject(error);
          return;
        }
        resolve(
          new ManagedSshConnectionHandle(
            this.uuid(),
            connection,
            client,
            lease,
            readyTimeout,
            cancellation,
          ),
        );
      };
      const onReady = (): void => {
        scrubClientCredentials(client);
        finish();
      };
      const onError = (error: Error & { code?: string; level?: string }): void =>
        finish(trustFailure ?? mapSshError(error, connection));
      const onClose = (): void =>
        finish(
          trustFailure ??
            new EasySshError('CONNECTION_LOST', `Connection to ${connection.name} closed.`),
        );
      const onEnd = (): void =>
        finish(
          trustFailure ??
            new EasySshError('CONNECTION_LOST', `Connection to ${connection.name} ended.`),
        );
      const onTimeout = (): void =>
        finish(new EasySshError('TIMEOUT', `Connection to ${connection.name} timed out.`));
      client.once('ready', onReady);
      client.once('error', onError);
      client.once('close', onClose);
      client.once('end', onEnd);
      client.once('timeout', onTimeout);
      try {
        client.connect(
          buildConnectConfig(connection, lease, settings, (key: Buffer, verify) => {
            void this.hostKeys.verify(connection.host, connection.port, key).then(
              () => safelyVerifyHost(verify, true),
              (error: unknown) => {
                trustFailure =
                  error instanceof EasySshError
                    ? error
                    : new EasySshError(
                        'HOST_KEY_REJECTED',
                        `Unable to verify the host key for ${connection.name}.`,
                      );
                safelyVerifyHost(verify, false);
              },
            );
          }),
        );
      } catch (error) {
        finish(mapSshError(error, connection));
      }
    });
  }
}

/** A host-trust decision can complete after timeout/cancellation destroyed ssh2. */
function safelyVerifyHost(verify: (valid: boolean) => void, valid: boolean): void {
  try {
    verify(valid);
  } catch {
    // The connection already settled, so a late verifier callback is intentionally ignored.
  }
}

export function buildConnectConfig(
  connection: RemoteConnection,
  lease: CredentialLease,
  settings: Readonly<EasySshConfiguration>,
  hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => void,
): ConnectConfig {
  const base: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    readyTimeout: connection.options.readyTimeoutMs ?? settings.connectTimeoutMs,
    keepaliveInterval: connection.options.keepAliveIntervalMs ?? settings.keepAliveIntervalMs,
    keepaliveCountMax: connection.options.keepAliveCountMax ?? settings.keepAliveCountMax,
    tryKeyboard: false,
    hostVerifier,
  };
  if (connection.authentication.type === 'password') {
    if (!lease.password) throw new EasySshError('MISSING_CREDENTIAL', 'A password is required.');
    return { ...base, password: lease.password, authHandler: ['password'] };
  }
  if (connection.authentication.type === 'agent') {
    if (!lease.agentSocket)
      throw new EasySshError('MISSING_CREDENTIAL', 'An SSH agent socket is required.');
    return { ...base, agent: lease.agentSocket, authHandler: ['agent'] };
  }
  if (!lease.privateKey) throw new EasySshError('MISSING_CREDENTIAL', 'A private key is required.');
  const key = Buffer.from(
    lease.privateKey.buffer,
    lease.privateKey.byteOffset,
    lease.privateKey.byteLength,
  );
  return {
    ...base,
    privateKey: key,
    ...(lease.passphrase === undefined ? {} : { passphrase: lease.passphrase }),
    authHandler: ['publickey'],
  };
}

class ManagedSshConnectionHandle implements SshConnectionHandle {
  private readonly closeEmitter = new SimpleEmitter<SshCloseReason>();
  private readonly children: { [Symbol.asyncDispose](): PromiseLike<void> }[] = [];
  private disposed = false;
  private closeEmitted = false;
  private readonly cancellationSubscription: { dispose(): void } | undefined;
  private readonly cancellation: CancellationTokenLike | undefined;
  #lease: CredentialLease | undefined;
  readonly onDidClose: Event<SshCloseReason> = this.closeEmitter.event;

  constructor(
    readonly id: string,
    private readonly connection: RemoteConnection,
    readonly client: Client,
    lease: CredentialLease,
    private readonly channelTimeoutMs: number,
    cancellation?: CancellationTokenLike,
  ) {
    this.#lease = lease;
    this.cancellation = cancellation;
    this.client.once('error', this.onError);
    this.client.once('end', this.onEnd);
    this.client.once('close', this.onClose);
    this.cancellationSubscription = cancellation?.onCancellationRequested(() => {
      this.emitClose('disposed');
      void this[Symbol.asyncDispose]();
    });
  }

  get connectionId(): string {
    return this.connection.id;
  }

  async openShell(options: PtyOptions): Promise<SshShellHandle> {
    this.assertOpen();
    const stream = await openShell(this.client, options, {
      timeoutMs: this.channelTimeoutMs,
      ...(this.cancellation === undefined ? {} : { cancellation: this.cancellation }),
      disposeLateValue: disposeChannel,
    });
    return this.track(new ChannelHandle(stream));
  }

  async openSftp(): Promise<SftpSubsystemHandle> {
    this.assertOpen();
    const sftp = await openSftp(this.client, {
      timeoutMs: this.channelTimeoutMs,
      ...(this.cancellation === undefined ? {} : { cancellation: this.cancellation }),
      disposeLateValue: disposeSftp,
    });
    return this.track(new SftpHandle(sftp));
  }

  async exec(options: ExecOptions): Promise<ExecHandle> {
    this.assertOpen();
    const stream = await openExec(this.client, options, {
      timeoutMs: this.channelTimeoutMs,
      ...(this.cancellation === undefined ? {} : { cancellation: this.cancellation }),
      disposeLateValue: disposeChannel,
    });
    return this.track(new ChannelHandle(stream));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancellationSubscription?.dispose();
    this.client.removeListener('error', this.onError);
    this.client.removeListener('end', this.onEnd);
    this.client.removeListener('close', this.onClose);
    for (const child of this.children.splice(0).reverse())
      await Promise.resolve(child[Symbol.asyncDispose]()).catch(() => undefined);
    safelyCloseClient(this.client);
    const lease = this.#lease;
    this.#lease = undefined;
    if (lease) await lease[Symbol.asyncDispose]();
    this.emitClose('disposed');
    this.closeEmitter.dispose();
  }

  private readonly onError = (): void => {
    this.emitClose('error');
    void this[Symbol.asyncDispose]();
  };
  private readonly onEnd = (): void => {
    this.emitClose('remote-end');
    void this[Symbol.asyncDispose]();
  };
  private readonly onClose = (): void => {
    this.emitClose('remote-close');
    void this[Symbol.asyncDispose]();
  };

  private track<T extends { [Symbol.asyncDispose](): PromiseLike<void> }>(value: T): T {
    this.children.push(value);
    return value;
  }
  private assertOpen(): void {
    if (this.disposed)
      throw new EasySshError('CONNECTION_LOST', `Connection to ${this.connection.name} is closed.`);
  }
  private emitClose(reason: SshCloseReason): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.closeEmitter.fire(reason);
  }
}

class ChannelHandle implements SshShellHandle, ExecHandle {
  private disposed = false;
  constructor(readonly stream: import('ssh2').ClientChannel) {}
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    disposeChannel(this.stream);
  }
}

class SftpHandle implements SftpSubsystemHandle {
  private disposed = false;
  constructor(readonly sftp: import('ssh2').SFTPWrapper) {}
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    disposeSftp(this.sftp);
  }
}

class SimpleEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly event: Event<T> = (listener) => {
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

export function mapSshError(error: unknown, connection: RemoteConnection): EasySshError {
  if (error instanceof EasySshError) return error;
  const value = error as { code?: string; level?: string; message?: string };
  if (value.code === 'ENOTFOUND' || value.code === 'EAI_AGAIN')
    return new EasySshError('NETWORK', `Unable to resolve ${connection.host}.`);
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(value.code ?? ''))
    return new EasySshError('NETWORK', `Unable to reach ${connection.name} at ${connection.host}.`);
  if (value.code === 'ETIMEDOUT' || /timed out/i.test(value.message ?? ''))
    return new EasySshError('TIMEOUT', `Connection to ${connection.name} timed out.`);
  if (value.level === 'client-authentication' || /authentication/i.test(value.message ?? ''))
    return new EasySshError(
      'AUTHENTICATION',
      `Authentication was rejected for ${connection.name}. Check the configured credential.`,
    );
  return new EasySshError('CONNECTION_LOST', `Unable to connect to ${connection.name}.`);
}

/** ssh2 may emit a final protocol error after destroy; keep it handled until close. */
function safelyCloseClient(client: Client): void {
  const swallowLateError = (): void => undefined;
  const cleanup = (): void => {
    client.removeListener('error', swallowLateError);
  };
  client.on('error', swallowLateError);
  client.once('close', cleanup);
  try {
    client.end();
    client.destroy();
  } catch {
    cleanup();
    client.removeListener('close', cleanup);
  }
}

function scrubClientCredentials(client: Client): void {
  const config = (client as unknown as { config?: Record<string, unknown> }).config;
  if (!config) return;
  for (const key of ['password', 'privateKey', 'passphrase', 'agent'])
    Reflect.deleteProperty(config, key);
}

function disposeChannel(stream: import('ssh2').ClientChannel): void {
  try {
    stream.end();
    stream.close();
    stream.destroy();
  } catch {
    // The transport may already have closed while an open callback was pending.
  }
}

function disposeSftp(sftp: import('ssh2').SFTPWrapper): void {
  try {
    sftp.end();
  } catch {
    // The transport may already have closed while an open callback was pending.
  }
}
