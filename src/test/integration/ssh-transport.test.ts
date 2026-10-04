import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectSocket, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EasySshConfiguration } from '../../configuration/ConfigurationService';
import type { CredentialStore, StateChange, StateRepository } from '../../connections/ports';
import {
  defaultAgentAccessPolicy,
  emptyPersistedState,
  type Authentication,
  type PersistedStateV1,
  type RemoteConnection,
} from '../../connections/types';
import { DefaultCredentialResolver } from '../../ssh/CredentialResolver';
import {
  HostKeyVerifier,
  type HostKeyDetails,
  type HostTrustPrompt,
} from '../../ssh/HostKeyVerifier';
import { SshClientFactory } from '../../ssh/SshClientFactory';
import { DefaultSshSessionManager } from '../../ssh/SshSessionManager';
import { TestConnectionService } from '../../ssh/TestConnectionService';
import { AtomicSftpWriter } from '../../sftp/AtomicSftpWriter';
import { RemoteResourceCache } from '../../sftp/RemoteResourceCache';
import { SessionSftpClientFactory } from '../../sftp/SftpClientFactory';
import { DefaultSftpConnectionPool } from '../../sftp/SftpConnectionPool';
import { DefaultSftpUriCodec, type SftpUriComponents } from '../../sftp/SftpUriCodec';
import { Ssh2SftpClient } from '../../sftp/Ssh2SftpClient';
import type { SftpClient } from '../../sftp/ports';
import type * as vscode from 'vscode';

const enabled = process.env.EASYSSH_RUN_DOCKER === '1';
const docker = describe.runIf(enabled).sequential;
const password = 'runtime-password-sentinel';
const keyPassphrase = 'runtime-key-passphrase-sentinel';
const settings: EasySshConfiguration = {
  connectTimeoutMs: 4_000,
  keepAliveIntervalMs: 500,
  keepAliveCountMax: 2,
  sftpIdleTimeoutMs: 10_000,
  maxInlineFileSizeMiB: 20,
  maxBufferedTransferMiB: 64,
  logLevel: 'debug',
};

docker('Docker SSH transport', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'easyssh-docker-'));
  const plainKey = join(temporary, 'id_ed25519');
  const encryptedKey = join(temporary, 'id_ed25519_encrypted');
  const agentSocket = join(temporary, 'agent.sock');
  const authorized = join(temporary, 'authorized_keys');
  const image = `easyssh-manager-test:${process.pid}`;
  const state = new MemoryState();
  const credentials = new MemoryCredentials();
  const trust = new TrustPrompt();
  let container = '';
  let agent: ChildProcess | undefined;
  let manager: DefaultSshSessionManager;
  let passwordProfile: RemoteConnection;
  let plainKeyProfile: RemoteConnection;
  let encryptedKeyProfile: RemoteConnection;
  let agentProfile: RemoteConnection;

  beforeAll(async () => {
    run('docker', ['info', '--format', '{{.ServerVersion}}']);
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', plainKey]);
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', keyPassphrase, '-f', encryptedKey]);
    run('docker', ['build', '-q', '-t', image, resolve('test/fixtures/openssh')]);
    container = run('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::2222', image]).trim();
    const published = run('docker', ['port', container, '2222/tcp']).trim();
    fixturePort = Number(published.slice(published.lastIndexOf(':') + 1));
    run('docker', ['exec', container, 'sh', '-c', `echo easyssh-test:${password} | chpasswd`]);
    const publicKey = Buffer.concat([
      readFileSync(`${plainKey}.pub`),
      readFileSync(`${encryptedKey}.pub`),
    ]);
    writeFileSync(authorized, publicKey);
    run('docker', ['cp', authorized, `${container}:/tmp/authorized_keys`]);
    run('docker', [
      'exec',
      container,
      'sh',
      '-c',
      'install -d -m 700 -o easyssh-test -g easyssh-test /home/easyssh-test/.ssh && install -m 600 -o easyssh-test -g easyssh-test /tmp/authorized_keys /home/easyssh-test/.ssh/authorized_keys',
    ]);
    await waitForPort(fixturePort);
    await delay(500);

    passwordProfile = profile('password', { type: 'password', hasStoredPassword: true });
    plainKeyProfile = profile('plain-key', {
      type: 'privateKey',
      privateKeyPath: plainKey,
      hasStoredPassphrase: false,
    });
    encryptedKeyProfile = profile('encrypted-key', {
      type: 'privateKey',
      privateKeyPath: encryptedKey,
      hasStoredPassphrase: true,
    });
    agentProfile = profile('agent', { type: 'agent' });
    state.value.connections.push(
      passwordProfile,
      plainKeyProfile,
      encryptedKeyProfile,
      agentProfile,
    );
    credentials.passwords.set(passwordProfile.id, password);
    credentials.passphrases.set(encryptedKeyProfile.id, keyPassphrase);
    createSftpFixture(container);
    manager = makeManager(state, credentials, trust, { SSH_AUTH_SOCK: agentSocket });
  }, 120_000);

  afterAll(async () => {
    await manager?.disposeAll();
    if (agent) agent.kill('SIGTERM');
    if (container) tryRun('docker', ['rm', '-f', container]);
    tryRun('docker', ['image', 'rm', '-f', image]);
    rmSync(temporary, { recursive: true, force: true });
  });

  it('accepts a password, rejects a wrong password, and completes real SFTP path validation', async () => {
    const tester = new TestConnectionService(manager, {
      resolve: async () => passwordProfile,
    });
    const result = await tester.testSaved(passwordProfile.id, 'password-valid');
    expect(result.stages.at(-1)).toBe('Default remote path is accessible');
    expect(manager.activeConnectionCount).toBe(0);

    credentials.passwords.set(passwordProfile.id, 'wrong-runtime-password');
    await expect(
      manager.connect(passwordProfile.id, purpose('password-wrong')),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION',
    });
    credentials.passwords.set(passwordProfile.id, password);
  });

  it('authenticates with unencrypted and encrypted Ed25519 keys and rejects wrong or missing passphrases', async () => {
    await connectAndClose(manager, plainKeyProfile.id, 'plain-key-valid');
    await connectAndClose(manager, encryptedKeyProfile.id, 'encrypted-key-valid');

    credentials.passphrases.set(encryptedKeyProfile.id, 'wrong-runtime-passphrase');
    await expect(
      manager.connect(encryptedKeyProfile.id, purpose('encrypted-key-wrong')),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    credentials.passphrases.delete(encryptedKeyProfile.id);
    const noPrompt = makeManager(state, credentials, trust, { SSH_AUTH_SOCK: agentSocket });
    await expect(
      noPrompt.connect(encryptedKeyProfile.id, purpose('encrypted-key-missing')),
    ).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' });
    await noPrompt.disposeAll();
    credentials.passphrases.set(encryptedKeyProfile.id, keyPassphrase);
  });

  it('authenticates through a test agent socket and fails clearly without an agent', async () => {
    agent = spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: 'ignore' });
    await waitForFileSocket(agentSocket);
    run('ssh-add', [plainKey], { SSH_AUTH_SOCK: agentSocket });
    await connectAndClose(manager, agentProfile.id, 'agent-valid');

    const withoutAgent = makeManager(state, credentials, trust, {});
    await expect(
      withoutAgent.connect(agentProfile.id, purpose('agent-missing')),
    ).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    });
  });

  it('performs real SFTP stat, link, listing, range-read, and CRUD operations', async () => {
    const first = await openSftpClient(manager, passwordProfile.id, 'sftp-domain-first');
    const second = await openSftpClient(manager, passwordProfile.id, 'sftp-domain-second');
    const root = '/home/easyssh-test/sftp-fixture';
    try {
      await expect(first.client.lstat(`${root}/text.txt`)).resolves.toMatchObject({
        kind: 'file',
        size: 14,
        mtimeMs: 1_700_000_000_000,
      });
      await expect(first.client.lstat(`${root}/link-to-text`)).resolves.toMatchObject({
        kind: 'symbolicLink',
      });
      await expect(first.client.stat(`${root}/link-to-text`)).resolves.toMatchObject({
        kind: 'file',
      });
      await expect(first.client.lstat(`${root}/broken-link`)).resolves.toMatchObject({
        kind: 'symbolicLink',
      });
      await expect(first.client.stat(`${root}/broken-link`)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(first.client.readlink(`${root}/link-to-text`)).resolves.toBe('text.txt');
      await expect(first.client.realpath(`${root}/link-to-text`)).resolves.toBe(`${root}/text.txt`);
      const names = (await first.client.readDirectory(root)).map(({ name }) => name);
      expect(names).toEqual(
        expect.arrayContaining([
          'text.txt',
          'directory',
          'link-to-text',
          'broken-link',
          'unicodé-世界.txt',
          'binary.bin',
          'large.bin',
        ]),
      );
      await expect(
        first.client.readFile(`${root}/text.txt`, { offset: 6, length: 7 }),
      ).resolves.toEqual(Buffer.from('fixture'));
      await expect(first.client.readFile(`${root}/denied.txt`)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });

      await first.client.mkdir(`${root}/created-directory`);
      await first.client.writeFile(`${root}/created.txt`, Buffer.from('created'), {
        create: true,
        overwrite: false,
      });
      await expect(second.client.readFile(`${root}/created.txt`)).resolves.toEqual(
        Buffer.from('created'),
      );
      await first.client.writeFile(`${root}/created.txt`, Buffer.from('overwritten'), {
        create: false,
        overwrite: true,
      });
      await first.client.rename(`${root}/created.txt`, `${root}/renamed.txt`, false);
      await expect(second.client.readFile(`${root}/renamed.txt`)).resolves.toEqual(
        Buffer.from('overwritten'),
      );
      await first.client.unlink(`${root}/renamed.txt`);
      await first.client.rmdir(`${root}/created-directory`);
      await expect(second.client.lstat(`${root}/renamed.txt`)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('reuses one real pooled subsystem, expires it idle, and reconnects only on a new acquire', async () => {
    const configuration = new PoolConfiguration(150);
    const pool = new DefaultSftpConnectionPool(
      new SessionSftpClientFactory(manager, () => settings.connectTimeoutMs),
      configuration,
    );
    const root = '/home/easyssh-test/sftp-fixture';
    try {
      const [first, second] = await Promise.all([
        pool.acquire(passwordProfile.id),
        pool.acquire(passwordProfile.id),
      ]);
      expect(manager.activeConnectionCount).toBe(1);
      await Promise.all([
        first.client.readFile(`${root}/text.txt`),
        second.client.readFile(`${root}/unicodé-世界.txt`),
      ]);
      await first[Symbol.asyncDispose]();
      expect(manager.activeConnectionCount).toBe(1);
      await second[Symbol.asyncDispose]();
      await waitUntil(() => manager.activeConnectionCount === 0, 2_000);

      const reconnected = await pool.acquire(passwordProfile.id);
      expect(manager.activeConnectionCount).toBe(1);
      await pool.invalidate(passwordProfile.id, 'integration forced invalidation');
      expect(manager.activeConnectionCount).toBe(0);
      const next = await pool.acquire(passwordProfile.id);
      expect(manager.activeConnectionCount).toBe(1);
      await next[Symbol.asyncDispose]();
      await reconnected[Symbol.asyncDispose]();
    } finally {
      await pool.disposeAll();
    }
    expect(manager.activeConnectionCount).toBe(0);
  });

  it('performs atomic conflict-aware saves and preserves the prior file on mid-upload disconnect', async () => {
    const root = '/home/easyssh-test/sftp-fixture';
    const target = `${root}/atomic.txt`;
    const uriCodec = integrationUriCodec(passwordProfile.id);
    const uri = uriCodec.create(passwordProfile.id, target);
    const cache = new RemoteResourceCache(uriCodec);
    let overwrite = false;
    const writer = new AtomicSftpWriter(
      uriCodec,
      cache,
      {
        confirmOverwrite: async () => overwrite,
        confirmNonAtomicOverwrite: async () => false,
      },
      { debug: () => undefined },
      () => randomUUID(),
    );
    const first = await openSftpClient(manager, passwordProfile.id, 'atomic-first');
    const external = await openSftpClient(manager, passwordProfile.id, 'atomic-external');
    try {
      await first.client.writeFile(target, Buffer.from('original'), {
        create: true,
        overwrite: true,
      });
      const original = await first.client.stat(target);
      cache.rememberVersion(uri, { mtimeMs: original.mtimeMs, size: original.size });
      await delay(1_100);
      await external.client.writeFile(target, Buffer.from('external'), {
        create: false,
        overwrite: true,
      });
      await expect(
        writer.write(uri, first.client, Buffer.from('editor'), {
          create: false,
          overwrite: true,
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      await expect(external.client.readFile(target)).resolves.toEqual(Buffer.from('external'));

      overwrite = true;
      await writer.write(uri, first.client, Buffer.from('editor'), {
        create: false,
        overwrite: true,
      });
      await expect(external.client.readFile(target)).resolves.toEqual(Buffer.from('editor'));
    } finally {
      await Promise.all([first.close(), external.close()]);
    }

    const interruptedHandle = await manager.connect(
      passwordProfile.id,
      purpose('atomic-interrupted'),
    );
    const subsystem = await interruptedHandle.openSftp();
    const interrupted = new Ssh2SftpClient(subsystem.sftp, settings.connectTimeoutMs);
    const large = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const interruptedWrite = writer.write(uri, interrupted, large, {
      create: false,
      overwrite: true,
    });
    await delay(5);
    subsystem.sftp.emit('close');
    await interruptedHandle[Symbol.asyncDispose]();
    await expect(interruptedWrite).rejects.toMatchObject({ code: 'CONNECTION_LOST' });

    const verifier = await openSftpClient(manager, passwordProfile.id, 'atomic-verifier');
    try {
      await expect(verifier.client.readFile(target)).resolves.toEqual(Buffer.from('editor'));
    } finally {
      await verifier.close();
    }
  });

  it('reuses matching trust, blocks host-key rotation, and permits explicit replacement', async () => {
    state.value.hostKeys = [];
    trust.firstUse.mockClear();
    trust.replacement.mockClear();
    trust.replace = false;
    await connectAndClose(manager, passwordProfile.id, 'trust-first');
    expect(trust.firstUse).toHaveBeenCalledOnce();
    await connectAndClose(manager, passwordProfile.id, 'trust-match');
    expect(trust.firstUse).toHaveBeenCalledOnce();
    run('docker', ['rm', '-f', container]);
    container = run('docker', [
      'run',
      '-d',
      '--rm',
      '-p',
      `127.0.0.1:${fixturePort}:2222`,
      image,
    ]).trim();
    run('docker', ['exec', container, 'sh', '-c', `echo easyssh-test:${password} | chpasswd`]);
    run('docker', ['cp', authorized, `${container}:/tmp/authorized_keys`]);
    run('docker', [
      'exec',
      container,
      'sh',
      '-c',
      'install -d -m 700 -o easyssh-test -g easyssh-test /home/easyssh-test/.ssh && install -m 600 -o easyssh-test -g easyssh-test /tmp/authorized_keys /home/easyssh-test/.ssh/authorized_keys',
    ]);
    await waitForPort(fixturePort);
    await delay(500);
    await expect(
      manager.connect(passwordProfile.id, purpose('trust-mismatch')),
    ).rejects.toMatchObject({
      code: 'HOST_KEY_MISMATCH',
    });
    trust.replace = true;
    await connectAndClose(manager, passwordProfile.id, 'trust-replace');
    expect(trust.replacement).toHaveBeenCalled();
  });

  it('runs an interactive PTY with ANSI, Unicode, resize, and independent sessions', async () => {
    const first = await manager.connect(passwordProfile.id, purpose('terminal-one'));
    const second = await manager.connect(passwordProfile.id, purpose('terminal-two'));
    await first.openShell({ columns: 90, rows: 30, terminal: 'xterm-256color' });
    const secondShell = await second.openShell({
      columns: 120,
      rows: 40,
      terminal: 'xterm-256color',
    });
    await first[Symbol.asyncDispose]();
    const output = collectUntil(secondShell.stream, 'EASYSSH_DONE');
    secondShell.stream.write(
      "printf '\\033[31mANSI-🙂\\033[0m\\n'; stty size; echo EASYSSH_DONE\n",
    );
    const text = await output;
    expect(text).toContain('\u001b[31mANSI-🙂\u001b[0m');
    expect(text).toMatch(/40\s+120/);
    expect(manager.activeConnectionCount).toBe(1);
    await second[Symbol.asyncDispose]();
    expect(manager.activeConnectionCount).toBe(0);
  });

  it('maps a delayed handshake timeout and a forced server disconnect once', async () => {
    const stalled = await stalledServer();
    const delayed = { ...passwordProfile, id: id('delayed'), port: addressPort(stalled.server) };
    state.value.connections.push(delayed);
    credentials.passwords.set(delayed.id, password);
    await expect(manager.connect(delayed.id, purpose('delayed'))).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    stalled.closeAll();
    await new Promise<void>((resolve) => stalled.server.close(() => resolve()));

    const live = await manager.connect(passwordProfile.id, purpose('disconnect'));
    const closed = new Promise<SshCloseReasonForTest>((resolve) => live.onDidClose(resolve));
    run('docker', ['kill', container]);
    container = '';
    await expect(
      withTimeout(closed, 5_000, 'Timed out waiting for forced disconnect.'),
    ).resolves.toMatch(/remote-close|remote-end|error/);
    expect(manager.activeConnectionCount).toBe(0);
  });
});

type SshCloseReasonForTest = 'remote-end' | 'remote-close' | 'error' | 'disposed';

class MemoryState implements StateRepository {
  value = emptyPersistedState();
  readonly onDidChange = (listener: (change: StateChange) => unknown) => {
    void listener;
    return { dispose: () => undefined };
  };
  async load(): Promise<Readonly<PersistedStateV1>> {
    return structuredClone(this.value);
  }
  async update(mutator: (draft: PersistedStateV1) => void): Promise<void> {
    const draft = structuredClone(this.value);
    mutator(draft);
    this.value = draft;
  }
}

class MemoryCredentials implements CredentialStore {
  readonly passwords = new Map<string, string>();
  readonly passphrases = new Map<string, string>();
  async getPassword(id: string): Promise<string | undefined> {
    return this.passwords.get(id);
  }
  async setPassword(id: string, value: string): Promise<void> {
    this.passwords.set(id, value);
  }
  async getKeyPassphrase(id: string): Promise<string | undefined> {
    return this.passphrases.get(id);
  }
  async setKeyPassphrase(id: string, value: string): Promise<void> {
    this.passphrases.set(id, value);
  }
  async clearPassword(id: string): Promise<void> {
    this.passwords.delete(id);
  }
  async clearKeyPassphrase(id: string): Promise<void> {
    this.passphrases.delete(id);
  }
  async clearAll(id: string): Promise<void> {
    this.passwords.delete(id);
    this.passphrases.delete(id);
  }
  async copySelected(): Promise<[]> {
    return [];
  }
}

class TrustPrompt implements HostTrustPrompt {
  replace = false;
  readonly firstUse = vi.fn(async (details: HostKeyDetails) => {
    void details;
    return true;
  });
  readonly replacement = vi.fn(
    async (expected: PersistedStateV1['hostKeys'][number], received: HostKeyDetails) => {
      void expected;
      void received;
      return this.replace;
    },
  );
  confirmFirstUse(details: HostKeyDetails): Promise<boolean> {
    return this.firstUse(details);
  }
  confirmReplacement(
    expected: PersistedStateV1['hostKeys'][number],
    received: HostKeyDetails,
  ): Promise<boolean> {
    return this.replacement(expected, received);
  }
}

function makeManager(
  state: MemoryState,
  credentials: MemoryCredentials,
  trust: TrustPrompt,
  environment: Readonly<Record<string, string | undefined>>,
): DefaultSshSessionManager {
  const resolver = {
    resolve: async (connectionId: string) =>
      state.value.connections.find((item) => item.id === connectionId)!,
  };
  const credentialResolver = new DefaultCredentialResolver(
    credentials,
    { showInputBox: async () => undefined },
    environment,
  );
  const factory = new SshClientFactory(new HostKeyVerifier(state, trust), () => settings);
  return new DefaultSshSessionManager(resolver, credentialResolver, factory);
}

function profile(name: string, authentication: Authentication): RemoteConnection {
  return {
    id: id(name),
    name,
    folderId: null,
    order: 0,
    host: '127.0.0.1',
    port: fixturePort,
    username: 'easyssh-test',
    defaultRemotePath: '/home/easyssh-test',
    authentication,
    agentAccess: defaultAgentAccessPolicy(),
    options: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

let fixturePort = 0;

function id(seed: string): string {
  const hex = Buffer.from(seed).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function purpose(scopeId: string) {
  return { kind: 'terminal' as const, scopeId };
}

async function connectAndClose(
  manager: DefaultSshSessionManager,
  connectionId: string,
  scopeId: string,
): Promise<void> {
  const handle = await manager.connect(connectionId, purpose(scopeId));
  await handle[Symbol.asyncDispose]();
}

function run(command: string, args: string[], environment?: Record<string, string>): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: environment ? { ...process.env, ...environment } : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createSftpFixture(container: string): void {
  run('docker', [
    'exec',
    container,
    'sh',
    '-c',
    [
      'root=/home/easyssh-test/sftp-fixture',
      'mkdir -p "$root/directory"',
      'printf \'hello fixture\\n\' > "$root/text.txt"',
      'printf \'unicode content\\n\' > "$root/unicodé-世界.txt"',
      'printf \'\\000\\001\\002binary\' > "$root/binary.bin"',
      'printf \'denied\' > "$root/denied.txt"',
      'printf \'atomic seed\' > "$root/atomic.txt"',
      'truncate -s 22020096 "$root/large.bin"',
      'ln -sf text.txt "$root/link-to-text"',
      'ln -sf missing.txt "$root/broken-link"',
      'touch -d @1700000000 "$root/text.txt"',
      'chown -R easyssh-test:easyssh-test "$root"',
      'chmod 000 "$root/denied.txt"',
    ].join(' && '),
  ]);
}

async function openSftpClient(
  manager: DefaultSshSessionManager,
  connectionId: string,
  scopeId: string,
): Promise<{ client: SftpClient; close(): Promise<void> }> {
  const handle = await manager.connect(connectionId, { kind: 'sftp', scopeId });
  try {
    const subsystem = await handle.openSftp();
    const client = new Ssh2SftpClient(subsystem.sftp, settings.connectTimeoutMs);
    return {
      client,
      close: async () => {
        await client.close();
        await handle[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await handle[Symbol.asyncDispose]();
    throw error;
  }
}

class PoolConfiguration {
  private readonly listeners = new Set<(value: { sftpIdleTimeoutMs: number }) => unknown>();
  constructor(private readonly idleTimeoutMs: number) {}
  readonly onDidChange = (listener: (value: { sftpIdleTimeoutMs: number }) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  getSnapshot(): Readonly<{ sftpIdleTimeoutMs: number }> {
    return { sftpIdleTimeoutMs: this.idleTimeoutMs };
  }
}

function integrationUriCodec(connectionId: string): DefaultSftpUriCodec {
  return new DefaultSftpUriCodec(
    {
      from: (components: SftpUriComponents) =>
        ({
          scheme: components.scheme,
          authority: components.authority ?? '',
          path: components.path ?? '',
          query: components.query ?? '',
          fragment: components.fragment ?? '',
          toString: () =>
            `${components.scheme}://${components.authority ?? ''}${components.path ?? ''}`,
        }) as unknown as vscode.Uri,
    },
    (candidate) => candidate === connectionId,
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration condition.');
    await delay(20);
  }
}

function tryRun(command: string, args: string[]): void {
  try {
    run(command, args);
  } catch {
    // Best-effort fixture cleanup.
  }
}

async function waitForPort(target: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connectSocket(target, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error('Docker SSH fixture did not become ready.');
}

async function waitForFileSocket(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) return;
    await delay(100);
  }
  throw new Error('Test ssh-agent did not become ready.');
}

function collectUntil(
  stream: { on(event: 'data', listener: (chunk: Buffer | string) => unknown): unknown },
  marker: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for shell output.')),
      5_000,
    );
    stream.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
  });
}

async function stalledServer(): Promise<{
  server: Server;
  closeAll(): void;
}> {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(() => undefined);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    closeAll: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing stalled server address.');
  return address.port;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout<T>(value: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    void value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
