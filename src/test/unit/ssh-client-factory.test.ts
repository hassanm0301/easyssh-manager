import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { EasySshConfiguration } from '../../configuration/ConfigurationService';
import { defaultAgentAccessPolicy, type RemoteConnection } from '../../connections/types';
import { SshClientFactory } from '../../ssh/SshClientFactory';
import type { CancellationTokenLike, CredentialLease } from '../../ssh/ports';

class FakeClient extends EventEmitter {
  readonly end = vi.fn(() => this);
  readonly destroy = vi.fn(() => this);
  config?: import('ssh2').ConnectConfig;
  connect(config: import('ssh2').ConnectConfig): this {
    this.config = config;
    return this;
  }
}

class Cancellation implements CancellationTokenLike {
  isCancellationRequested = false;
  private readonly listeners = new Set<() => unknown>();
  readonly onCancellationRequested = (listener: () => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of [...this.listeners]) listener();
  }
}

const configuration: EasySshConfiguration = {
  connectTimeoutMs: 1_000,
  keepAliveIntervalMs: 1_000,
  keepAliveCountMax: 3,
  sftpIdleTimeoutMs: 10_000,
  maxInlineFileSizeMiB: 20,
  maxBufferedTransferMiB: 64,
  logLevel: 'debug',
};

const connection: RemoteConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'factory-test',
  folderId: null,
  order: 0,
  host: 'example.test',
  port: 22,
  username: 'tester',
  defaultRemotePath: '/',
  authentication: { type: 'password', hasStoredPassword: true },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
  createdAt: 1,
  updatedAt: 1,
};

function fixture(): {
  client: FakeClient;
  lease: CredentialLease;
  disposeLease: ReturnType<typeof vi.fn>;
  factory: SshClientFactory;
} {
  const client = new FakeClient();
  const disposeLease = vi.fn(async () => undefined);
  const lease: CredentialLease = {
    password: 'sentinel',
    [Symbol.asyncDispose]: disposeLease,
  };
  const factory = new SshClientFactory(
    { verify: vi.fn(async () => undefined) } as never,
    () => configuration,
    () => client as never,
    () => 'handle-1',
  );
  return { client, lease, disposeLease, factory };
}

describe('SSH client lifecycle', () => {
  it('uses ssh2 asynchronous host verification without returning an accepting promise', async () => {
    const { client, lease, factory } = fixture();
    const attempt = factory.connect(connection, lease);
    const verifier = client.config?.hostVerifier as (
      key: Buffer,
      callback: (accepted: boolean) => void,
    ) => unknown;
    const accepted = vi.fn();
    const returned = verifier(Buffer.from('host-key'), accepted);
    expect(returned).toBeUndefined();
    await Promise.resolve();
    expect(accepted).toHaveBeenCalledWith(true);
    client.emit(
      'error',
      Object.assign(new Error('stop test connection'), { code: 'ECONNREFUSED' }),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'NETWORK' });
    client.emit('close');
  });

  it('rejects once, removes initial listeners, and releases the lease on failure', async () => {
    const { client, lease, disposeLease, factory } = fixture();
    const attempt = factory.connect(connection, lease);
    client.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    client.emit('close');
    await expect(attempt).rejects.toMatchObject({ code: 'NETWORK' });
    expect(disposeLease).toHaveBeenCalledOnce();
    client.emit('close');
    for (const event of ['ready', 'error', 'close', 'end', 'timeout'])
      expect(client.listenerCount(event)).toBe(0);
  });

  it('cancels an in-flight connection exactly once and ignores late readiness', async () => {
    const { client, lease, disposeLease, factory } = fixture();
    const cancellation = new Cancellation();
    const attempt = factory.connect(connection, lease, cancellation);
    cancellation.cancel();
    client.emit('ready');
    await expect(attempt).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
    client.emit('close');
  });

  it('transfers ownership after ready and disposes client and credentials idempotently', async () => {
    const { client, lease, disposeLease, factory } = fixture();
    const attempt = factory.connect(connection, lease);
    client.emit('ready');
    const handle = await attempt;
    expect(client.config).not.toHaveProperty('password');
    expect(JSON.stringify(handle)).not.toContain('sentinel');
    await handle[Symbol.asyncDispose]();
    await handle[Symbol.asyncDispose]();
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
    client.emit('close');
    for (const event of ['error', 'close', 'end']) expect(client.listenerCount(event)).toBe(0);
  });

  it('releases credentials if client initialization fails', async () => {
    const disposeLease = vi.fn(async () => undefined);
    const factory = new SshClientFactory(
      { verify: vi.fn() } as never,
      () => configuration,
      () => {
        throw new Error('client initialization failed');
      },
    );
    await expect(
      factory.connect(connection, {
        password: 'sentinel',
        [Symbol.asyncDispose]: disposeLease,
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(disposeLease).toHaveBeenCalledOnce();
  });
});
