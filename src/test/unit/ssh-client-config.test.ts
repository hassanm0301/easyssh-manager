import { describe, expect, it, vi } from 'vitest';

import type { EasySshConfiguration } from '../../configuration/ConfigurationService';
import { defaultAgentAccessPolicy, type RemoteConnection } from '../../connections/types';
import { buildConnectConfig } from '../../ssh/SshClientFactory';
import { callbackOnce } from '../../ssh/adapters';
import type { CredentialLease } from '../../ssh/ports';

const settings: EasySshConfiguration = {
  connectTimeoutMs: 15_000,
  keepAliveIntervalMs: 12_000,
  keepAliveCountMax: 4,
  sftpIdleTimeoutMs: 180_000,
  maxInlineFileSizeMiB: 20,
  maxBufferedTransferMiB: 64,
  logLevel: 'info',
};

const connection = (authentication: RemoteConnection['authentication']): RemoteConnection => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'test',
  folderId: null,
  order: 0,
  host: 'example.test',
  port: 22,
  username: 'tester',
  defaultRemotePath: '/',
  authentication,
  agentAccess: defaultAgentAccessPolicy(),
  options: { readyTimeoutMs: 5_000, keepAliveIntervalMs: 2_000, keepAliveCountMax: 2 },
  createdAt: 1,
  updatedAt: 1,
});

const lease = (values: Partial<CredentialLease>): CredentialLease => ({
  ...values,
  [Symbol.asyncDispose]: async () => undefined,
});

describe('ssh2 connection configuration', () => {
  it('supplies exactly one selected authentication mode with no fallback', () => {
    const verify = vi.fn();
    const password = buildConnectConfig(
      connection({ type: 'password', hasStoredPassword: false }),
      lease({ password: 'sentinel-password' }),
      settings,
      verify,
    );
    expect(password).toMatchObject({
      password: 'sentinel-password',
      authHandler: ['password'],
      tryKeyboard: false,
      readyTimeout: 5_000,
      keepaliveInterval: 2_000,
      keepaliveCountMax: 2,
    });
    expect(password).not.toHaveProperty('privateKey');
    expect(password).not.toHaveProperty('agent');

    const keyBytes = Buffer.from('key');
    const key = buildConnectConfig(
      connection({ type: 'privateKey', privateKeyPath: '/key', hasStoredPassphrase: false }),
      lease({ privateKey: keyBytes, passphrase: 'sentinel-phrase' }),
      settings,
      verify,
    );
    expect(key).toMatchObject({ authHandler: ['publickey'], passphrase: 'sentinel-phrase' });
    expect(key).not.toHaveProperty('password');
    expect(key).not.toHaveProperty('agent');

    const agent = buildConnectConfig(
      connection({ type: 'agent' }),
      lease({ agentSocket: '/tmp/test-agent.sock' }),
      settings,
      verify,
    );
    expect(agent).toMatchObject({ authHandler: ['agent'], agent: '/tmp/test-agent.sock' });
    expect(agent).not.toHaveProperty('password');
    expect(agent).not.toHaveProperty('privateKey');
  });

  it('settles callback adapters exactly once', async () => {
    const result = callbackOnce<string>((done) => {
      done(undefined, 'first');
      done(new Error('late failure'), 'second');
    });
    await expect(result).resolves.toBe('first');
  });

  it('times out or cancels channel adapters, cleans subscriptions, and disposes late values', async () => {
    let lateCallback!: (error: Error | undefined, value: { close(): void }) => void;
    const late = { close: vi.fn() };
    const disposeLateValue = vi.fn((value: { close(): void }) => value.close());
    const timedOut = callbackOnce<{ close(): void }>(
      (done) => {
        lateCallback = done;
      },
      { timeoutMs: 5, disposeLateValue },
    );
    await expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
    lateCallback(undefined, late);
    expect(disposeLateValue).toHaveBeenCalledWith(late);
    expect(late.close).toHaveBeenCalledOnce();

    let cancel!: () => unknown;
    const disposeSubscription = vi.fn();
    const cancelled = callbackOnce<string>(() => undefined, {
      timeoutMs: 1_000,
      cancellation: {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          cancel = listener;
          return { dispose: disposeSubscription };
        },
      },
      disposeLateValue: vi.fn(),
    });
    cancel();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(disposeSubscription).toHaveBeenCalledOnce();
  });
});
