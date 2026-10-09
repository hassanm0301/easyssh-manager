import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CredentialStore } from '../../connections/ports';
import { defaultAgentAccessPolicy, type RemoteConnection } from '../../connections/types';
import { DefaultCredentialResolver, expandPrivateKeyPath } from '../../ssh/CredentialResolver';

class Store implements CredentialStore {
  password: string | undefined;
  passphrase: string | undefined;
  async getPassword(): Promise<string | undefined> {
    return this.password;
  }
  async setPassword(_id: string, value: string): Promise<void> {
    this.password = value;
  }
  async getKeyPassphrase(): Promise<string | undefined> {
    return this.passphrase;
  }
  async setKeyPassphrase(_id: string, value: string): Promise<void> {
    this.passphrase = value;
  }
  async clearPassword(): Promise<void> {
    this.password = undefined;
  }
  async clearKeyPassphrase(): Promise<void> {
    this.passphrase = undefined;
  }
  async clearAll(): Promise<void> {
    this.password = undefined;
    this.passphrase = undefined;
  }
  async copySelected(): Promise<[]> {
    return [];
  }
}

const profile = (authentication: RemoteConnection['authentication']): RemoteConnection => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'credential-test',
  folderId: null,
  order: 0,
  host: 'example.test',
  port: 22,
  username: 'tester',
  defaultRemotePath: '/',
  authentication,
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
  createdAt: 1,
  updatedAt: 1,
});

const scope = { kind: 'terminal' as const, scopeId: 'scope-1' };
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'easyssh-credentials-'));
  directories.push(path);
  return path;
}

describe('credential resolver', () => {
  it('uses transient then stored passwords and prompts only when missing', async () => {
    const store = new Store();
    store.password = 'stored-sentinel';
    const showInputBox = vi.fn(async () => 'prompted-sentinel');
    const resolver = new DefaultCredentialResolver(store, { showInputBox }, {});
    const connection = profile({ type: 'password', hasStoredPassword: true });

    const transient = await resolver.acquire(connection, scope, { password: 'transient-sentinel' });
    expect(transient.password).toBe('transient-sentinel');
    expect(JSON.stringify(transient)).not.toContain('transient-sentinel');
    const stored = await resolver.acquire(connection, scope);
    expect(stored.password).toBe('stored-sentinel');
    expect(showInputBox).not.toHaveBeenCalled();

    const clearedCandidate = await resolver.acquire(connection, scope, { password: null });
    expect(clearedCandidate.password).toBe('prompted-sentinel');
    expect(clearedCandidate.password).not.toBe('stored-sentinel');

    store.password = undefined;
    const prompted = await resolver.acquire(connection, scope);
    expect(prompted.password).toBe('prompted-sentinel');
    expect(showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ password: true, ignoreFocusOut: true }),
    );
  });

  it('requires a non-empty configured agent socket without password fallback', async () => {
    const resolver = new DefaultCredentialResolver(
      new Store(),
      { showInputBox: vi.fn(async () => 'must-not-be-used') },
      {},
      'linux',
    );
    await expect(resolver.acquire(profile({ type: 'agent' }), scope)).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    });
    const active = new DefaultCredentialResolver(
      new Store(),
      { showInputBox: vi.fn() },
      { SSH_AUTH_SOCK: '/tmp/agent.sock' },
      'linux',
    );
    await expect(active.acquire(profile({ type: 'agent' }), scope)).resolves.toMatchObject({
      agentSocket: '/tmp/agent.sock',
    });
  });

  it('selects Windows OpenSSH named pipes and rejects incompatible agent endpoints', async () => {
    const resolver = new DefaultCredentialResolver(
      new Store(),
      { showInputBox: vi.fn() },
      {},
      'win32',
    );
    await expect(resolver.acquire(profile({ type: 'agent' }), scope)).resolves.toMatchObject({
      agentSocket: String.raw`\\.\pipe\openssh-ssh-agent`,
    });

    for (const endpoint of [
      String.raw`\\.\pipe\custom-agent`,
      '//./pipe/custom-agent',
      String.raw`\\.\pipe\nested\agent`,
    ]) {
      const configured = new DefaultCredentialResolver(
        new Store(),
        { showInputBox: vi.fn() },
        { SSH_AUTH_SOCK: endpoint },
        'win32',
      );
      await expect(configured.acquire(profile({ type: 'agent' }), scope)).resolves.toMatchObject({
        agentSocket: endpoint,
      });
    }

    const incompatible = new DefaultCredentialResolver(
      new Store(),
      { showInputBox: vi.fn() },
      { SSH_AUTH_SOCK: '/tmp/agent.sock' },
      'win32',
    );
    await expect(incompatible.acquire(profile({ type: 'agent' }), scope)).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
      message: expect.stringContaining('Windows SSH-agent pipe'),
    });
  });

  it('reads a valid key only while acquiring and zeroes key bytes on disposal', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'id_rsa');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await writeFile(path, privateKey, { mode: 0o600 });
    const resolver = new DefaultCredentialResolver(new Store(), { showInputBox: vi.fn() }, {});
    const acquired = await resolver.acquire(
      profile({ type: 'privateKey', privateKeyPath: path, hasStoredPassphrase: false }),
      scope,
    );
    expect(acquired.privateKey?.byteLength).toBeGreaterThan(100);
    const bytes = acquired.privateKey!;
    await acquired[Symbol.asyncDispose]();
    await acquired[Symbol.asyncDispose]();
    expect([...bytes].every((byte) => byte === 0)).toBe(true);
    expect(acquired.privateKey).toBeUndefined();
  });

  it('prompts for encrypted keys and safely rejects wrong passphrases', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'encrypted.pem');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'correct-sentinel',
      },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await writeFile(path, privateKey, { mode: 0o600 });
    const store = new Store();
    const showInputBox = vi.fn(async () => 'correct-sentinel');
    const resolver = new DefaultCredentialResolver(store, { showInputBox }, {});
    const connection = profile({
      type: 'privateKey',
      privateKeyPath: path,
      hasStoredPassphrase: false,
    });
    await expect(resolver.acquire(connection, scope)).resolves.toMatchObject({
      passphrase: 'correct-sentinel',
    });

    store.passphrase = 'wrong-sentinel';
    await expect(resolver.acquire(connection, scope)).rejects.toMatchObject({
      code: 'INVALID_KEY',
    });
    try {
      await resolver.acquire(connection, scope);
    } catch (error) {
      expect(String(error)).not.toContain('wrong-sentinel');
      expect(String(error)).not.toContain('correct-sentinel');
    }
  });

  it('rejects directories, read failures, and keys over 1 MiB', async () => {
    const directory = await temporaryDirectory();
    const nested = join(directory, 'directory-key');
    await mkdir(nested);
    const oversized = join(directory, 'oversized-key');
    await writeFile(oversized, 'x');
    await truncate(oversized, 1024 * 1024 + 1);
    const resolver = new DefaultCredentialResolver(new Store(), { showInputBox: vi.fn() }, {});
    for (const path of [nested, oversized, join(directory, 'deleted-key')]) {
      await expect(
        resolver.acquire(
          profile({ type: 'privateKey', privateKeyPath: path, hasStoredPassphrase: false }),
          scope,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    }
  });

  it('expands and normalizes local paths', () => {
    expect(expandPrivateKeyPath('~')).not.toContain('~');
    expect(basename(expandPrivateKeyPath('./a/../key'))).toBe('key');
    expect(
      expandPrivateKeyPath('~\\Documents\\résumé key', {
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Tester',
      }),
    ).toBe('C:\\Users\\Tester\\Documents\\résumé key');
    expect(expandPrivateKeyPath('D:/keys/é clé', { platform: 'win32' })).toBe('D:\\keys\\é clé');
    expect(expandPrivateKeyPath('\\\\server\\share\\my key', { platform: 'win32' })).toBe(
      '\\\\server\\share\\my key',
    );
  });
});
