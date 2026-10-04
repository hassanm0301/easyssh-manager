import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { connect as connectSocket } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import type { EasySshConfiguration } from '../../../configuration/ConfigurationService';
import type { CredentialStore, StateChange, StateRepository } from '../../../connections/ports';
import {
  defaultAgentAccessPolicy,
  emptyPersistedState,
  type PersistedStateV1,
  type RemoteConnection,
} from '../../../connections/types';
import { DefaultCredentialResolver } from '../../../ssh/CredentialResolver';
import {
  HostKeyVerifier,
  type HostKeyDetails,
  type HostTrustPrompt,
} from '../../../ssh/HostKeyVerifier';
import { SshClientFactory } from '../../../ssh/SshClientFactory';
import { DefaultSshSessionManager } from '../../../ssh/SshSessionManager';
import { AtomicSftpWriter, type AtomicWritePrompt } from '../../../sftp/AtomicSftpWriter';
import { DownloadService } from '../../../sftp/DownloadService';
import { RemoteMutationService } from '../../../sftp/RemoteMutationService';
import { RemoteResourceCache } from '../../../sftp/RemoteResourceCache';
import { RemoteSftpFileSystemProvider } from '../../../sftp/RemoteSftpFileSystemProvider';
import { SessionSftpClientFactory } from '../../../sftp/SftpClientFactory';
import { SftpBrowserService } from '../../../sftp/SftpBrowserService';
import { DefaultSftpConnectionPool } from '../../../sftp/SftpConnectionPool';
import { normalizeRemotePath } from '../../../sftp/SftpUriCodec';
import type { ParsedSftpUri, SftpClient, SftpUriCodec } from '../../../sftp/ports';
import { WorkspaceUploadService } from '../../../sftp/WorkspaceUploadService';

const scheme = 'remote-sftp-acceptance';
const password = 'extension-host-acceptance-password';
const remoteRoot = '/home/easyssh-test/editor-acceptance';
const configuration: EasySshConfiguration = {
  connectTimeoutMs: 4_000,
  keepAliveIntervalMs: 500,
  keepAliveCountMax: 2,
  sftpIdleTimeoutMs: 10_000,
  maxInlineFileSizeMiB: 20,
  maxBufferedTransferMiB: 64,
  logLevel: 'debug',
};

suite('SFTP normal-editor acceptance', () => {
  const image = `easyssh-manager-editor-acceptance:${process.pid}`;
  let state: MemoryState;
  let credentials: MemoryCredentials;
  let conflictPrompt: ConflictPrompt;
  let codec: AcceptanceUriCodec;
  let container = '';
  let port = 0;
  let first: RemoteConnection;
  let second: RemoteConnection;
  let manager: DefaultSshSessionManager;
  let pool: DefaultSftpConnectionPool;
  let cache: RemoteResourceCache;
  let provider: RemoteSftpFileSystemProvider;
  let registration: vscode.Disposable;
  let external: SftpClient;

  suiteSetup(async function () {
    this.timeout(120_000);
    state = new MemoryState();
    credentials = new MemoryCredentials();
    conflictPrompt = new ConflictPrompt();
    codec = new AcceptanceUriCodec();
    const extension = vscode.extensions.getExtension('hassanm0301.easyssh-manager');
    assert.ok(extension, 'extension should be discoverable');
    runDocker(['info', '--format', '{{.ServerVersion}}']);
    runDocker([
      'build',
      '-q',
      '-t',
      image,
      resolve(extension.extensionPath, 'test/fixtures/openssh'),
    ]);
    container = runDocker(['run', '-d', '--rm', '-p', '127.0.0.1::2222', image]).trim();
    const published = runDocker(['port', container, '2222/tcp']).trim();
    port = Number(published.slice(published.lastIndexOf(':') + 1));
    runDocker(['exec', container, 'sh', '-c', `echo easyssh-test:${password} | chpasswd`]);
    runDocker([
      'exec',
      container,
      'sh',
      '-c',
      [
        `root=${remoteRoot}`,
        'mkdir -p "$root"',
        'printf \'const initial = true;\\n\' > "$root/document.ts"',
        'printf \'second initial\\n\' > "$root/second.txt"',
        'printf \'permission initial\\n\' > "$root/permission.txt"',
        'chown -R easyssh-test:easyssh-test "$root"',
        'chmod 755 "$root"',
      ].join(' && '),
    ]);
    await waitForPort(port);
    // The container port can accept TCP briefly before sshd is ready to authenticate.
    await delay(1_000);

    first = profile('editor-first', port);
    second = profile('editor-second', port);
    state.value.connections.push(first, second);
    credentials.passwords.set(first.id, password);
    credentials.passwords.set(second.id, password);

    const credentialResolver = new DefaultCredentialResolver(credentials, {
      showInputBox: async () => undefined,
    });
    const clientFactory = new SshClientFactory(
      new HostKeyVerifier(state, new AcceptingTrustPrompt()),
      () => configuration,
    );
    manager = new DefaultSshSessionManager(
      {
        resolve: async (id) => {
          const connection = state.value.connections.find((candidate) => candidate.id === id);
          if (!connection) throw new Error(`Unknown acceptance connection '${id}'.`);
          return connection;
        },
      },
      credentialResolver,
      clientFactory,
    );
    const sftpFactory = new SessionSftpClientFactory(manager, () => configuration.connectTimeoutMs);
    pool = new DefaultSftpConnectionPool(sftpFactory, new PoolConfiguration());
    cache = new RemoteResourceCache(codec);
    const writer = new AtomicSftpWriter(codec, cache, conflictPrompt, {
      debug: () => undefined,
    });
    provider = new RemoteSftpFileSystemProvider(vscode, codec, pool, cache, writer);
    registration = vscode.workspace.registerFileSystemProvider(scheme, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    });
    external = await sftpFactory.open(first.id);
  });

  suiteTeardown(async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    registration?.dispose();
    await external?.close();
    await pool?.disposeAll();
    await manager?.disposeAll();
    assert.equal(
      manager?.activeConnectionCount,
      0,
      'acceptance cleanup should close every session',
    );
    if (container) tryDocker(['rm', '-f', container]);
    tryDocker(['image', 'rm', '-f', image]);
  });

  test('opens, edits, Ctrl+S saves, and preserves dirty state on conflicts and permission errors', async function () {
    this.timeout(60_000);
    const uri = codec.create(first.id, `${remoteRoot}/document.ts`);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);

    assert.equal(
      document.languageId,
      'typescript',
      'normal editor should select TypeScript tooling',
    );
    assert.equal(document.getText(), 'const initial = true;\n');
    assert.equal(document.isDirty, false);

    await replaceAll(editor, 'const savedThroughVsCode = true;\n');
    assert.equal(document.isDirty, true, 'editor should become dirty after a normal edit');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitUntil(() => !document.isDirty, 5_000);
    assert.equal(
      Buffer.from(await external.readFile(`${remoteRoot}/document.ts`)).toString(),
      'const savedThroughVsCode = true;\n',
      'Ctrl+S command should commit editor bytes through the provider',
    );

    await replaceAll(editor, 'const editorConflict = true;\n');
    await delay(1_100);
    await external.writeFile(
      `${remoteRoot}/document.ts`,
      Buffer.from('const externalChangeHasDifferentSize = true;\n'),
      { create: false, overwrite: true },
    );
    conflictPrompt.overwrite = false;
    assert.equal(await document.save(), false, 'Cancel Save should report an unsuccessful save');
    assert.equal(document.isDirty, true, 'a cancelled conflict must keep the editor dirty');
    assert.equal(
      Buffer.from(await external.readFile(`${remoteRoot}/document.ts`)).toString(),
      'const externalChangeHasDifferentSize = true;\n',
      'Cancel Save should preserve the external content',
    );
    assert.deepEqual(conflictPrompt.reasons, ['changed']);

    conflictPrompt.overwrite = true;
    assert.equal(await document.save(), true, 'Overwrite Remote should commit the editor content');
    assert.equal(document.isDirty, false);
    assert.equal(
      Buffer.from(await external.readFile(`${remoteRoot}/document.ts`)).toString(),
      'const editorConflict = true;\n',
    );

    const permissionUri = codec.create(first.id, `${remoteRoot}/permission.txt`);
    const permissionDocument = await vscode.workspace.openTextDocument(permissionUri);
    const permissionEditor = await vscode.window.showTextDocument(
      permissionDocument,
      vscode.ViewColumn.Beside,
    );
    await replaceAll(permissionEditor, 'must remain dirty\n');
    runDocker(['exec', container, 'chmod', '555', remoteRoot]);
    try {
      assert.equal(await permissionDocument.save(), false, 'permission failure should fail save');
      assert.equal(permissionDocument.isDirty, true, 'permission failure must retain dirty state');
      assert.equal(
        Buffer.from(await external.readFile(`${remoteRoot}/permission.txt`)).toString(),
        'permission initial\n',
      );
    } finally {
      runDocker(['exec', container, 'chmod', '755', remoteRoot]);
    }
    assert.equal(
      await permissionDocument.save(),
      true,
      'save should recover after permission repair',
    );

    const secondUri = codec.create(second.id, `${remoteRoot}/second.txt`);
    const secondDocument = await vscode.workspace.openTextDocument(secondUri);
    const secondEditor = await vscode.window.showTextDocument(
      secondDocument,
      vscode.ViewColumn.Beside,
    );
    await Promise.all([
      replaceAll(editor, 'const concurrentFirst = true;\n'),
      replaceAll(secondEditor, 'concurrent second\n'),
    ]);
    assert.deepEqual(await Promise.all([document.save(), secondDocument.save()]), [true, true]);
    assert.equal(
      Buffer.from(await external.readFile(`${remoteRoot}/document.ts`)).toString(),
      'const concurrentFirst = true;\n',
    );
    assert.equal(
      Buffer.from(await external.readFile(`${remoteRoot}/second.txt`)).toString(),
      'concurrent second\n',
    );
  });

  test('lists, refreshes, mutates, and downloads through the Milestone 5 host services', async function () {
    this.timeout(60_000);
    const root = `${remoteRoot}/browser-acceptance`;
    await external.mkdir(root);
    await external.writeFile(`${root}/external.txt`, Buffer.from('initial'), {
      create: true,
      overwrite: false,
    });
    const browser = new SftpBrowserService(pool, cache);
    const firstListing = await browser.list(first.id, root, {
      force: true,
      sort: 'name',
      direction: 'asc',
    });
    assert.deepEqual(
      firstListing.entries.map((entry) => entry.name),
      ['external.txt'],
    );
    await external.writeFile(`${root}/outside-change.txt`, Buffer.from('changed'), {
      create: true,
      overwrite: false,
    });
    const refreshed = await browser.list(first.id, root, {
      force: true,
      sort: 'name',
      direction: 'asc',
    });
    assert.ok(refreshed.entries.some((entry) => entry.name === 'outside-change.txt'));

    const mutations = new RemoteMutationService(
      {
        workspace: vscode.workspace,
        window: {
          tabGroups: vscode.window.tabGroups,
          showWarningMessage: async (...args: unknown[]) =>
            args.includes('Delete Recursively') ? 'Delete Recursively' : 'Delete',
          withProgress: async (
            _options: unknown,
            task: (progress: unknown, token: unknown) => unknown,
          ) => task({ report: () => undefined }, { isCancellationRequested: false }),
        },
        ProgressLocation: vscode.ProgressLocation,
      } as never,
      codec,
      pool,
      cache,
      provider,
    );
    await mutations.createDirectory(first.id, root, 'nested');
    await mutations.createFile(first.id, `${root}/nested`, 'created.txt');
    await mutations.rename(first.id, `${root}/nested/created.txt`, 'renamed.txt');
    assert.equal(
      Buffer.from(await external.readFile(`${root}/nested/renamed.txt`)).byteLength,
      0,
      'new files must be atomically created with zero bytes',
    );
    runDocker(['exec', container, 'sh', '-c', `ln -s renamed.txt '${root}/nested/link'`]);

    const destination = await mkdtemp(join(tmpdir(), 'easyssh-browser-download-'));
    try {
      const downloads = new DownloadService(
        {
          Uri: vscode.Uri,
          FileType: vscode.FileType,
          ProgressLocation: vscode.ProgressLocation,
          workspace: vscode.workspace,
          window: {
            showOpenDialog: async () => [vscode.Uri.file(destination)],
            showWarningMessage: async () => 'Overwrite',
            showInformationMessage: async () => undefined,
            withProgress: async (
              _options: unknown,
              task: (progress: unknown, token: unknown) => unknown,
            ) => task({ report: () => undefined }, { isCancellationRequested: false }),
          },
        } as never,
        pool,
        { maxBufferedTransferMiB: () => configuration.maxBufferedTransferMiB },
      );
      const downloaded = await downloads.chooseAndDownload(first.id, [`${root}/nested`]);
      assert.equal(downloaded.completed, 2, 'the directory and regular file should complete');
      assert.deepEqual(downloaded.skipped, [
        { path: 'nested/link', reason: 'Symbolic links are not downloaded.' },
      ]);
      assert.equal(await readFile(join(destination, 'nested', 'renamed.txt'), 'utf8'), '');
    } finally {
      await rm(destination, { recursive: true, force: true });
    }

    const deleted = await mutations.delete(first.id, `${root}/nested`);
    assert.equal(deleted.failed.length, 0);
    assert.ok(deleted.deleted >= 3, 'recursive delete must unlink the link and file before rmdir');
    await assert.rejects(() => external.lstat(`${root}/nested`));
  });

  test('uploads local workspace files and empty folders through the Milestone 6 host service', async function () {
    this.timeout(60_000);
    const localRoot = await mkdtemp(join(tmpdir(), 'easyssh-workspace-upload-'));
    const remote = `${remoteRoot}/upload-acceptance`;
    try {
      await mkdir(join(localRoot, 'project', 'empty'), { recursive: true });
      await mkdir(join(localRoot, 'project', 'nested'), { recursive: true });
      await writeFile(join(localRoot, 'project', 'nested', 'hello-世界.txt'), 'workspace upload\n');
      await external.mkdir(remote);
      const warnings: string[] = [];
      const uploads = new WorkspaceUploadService(
        {
          FileType: vscode.FileType,
          ProgressLocation: vscode.ProgressLocation,
          Uri: vscode.Uri,
          workspace: vscode.workspace,
          window: {
            showOpenDialog: async () => undefined,
            showWarningMessage: async (message: string) => {
              warnings.push(message);
              return 'Skip';
            },
            withProgress: async (
              _options: unknown,
              task: (progress: { report(): void }, token: vscode.CancellationToken) => unknown,
            ) =>
              task({ report: () => undefined }, {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => undefined }),
              } as vscode.CancellationToken),
          },
        } as never,
        pool,
        cache,
        codec,
        provider,
        { maxBufferedTransferMiB: () => configuration.maxBufferedTransferMiB },
      );
      const neverCancelled = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      };
      const firstUpload = await uploads.uploadWorkspaceItems({
        connectionId: first.id,
        sourceUris: [vscode.Uri.file(join(localRoot, 'project'))],
        targetRemotePath: remote,
        cancellation: neverCancelled,
      });
      assert.equal(firstUpload.uploaded, 1);
      assert.equal(firstUpload.createdDirectories, 3);
      assert.equal(firstUpload.failed.length, 0);
      assert.equal(
        Buffer.from(await external.readFile(`${remote}/project/nested/hello-世界.txt`)).toString(),
        'workspace upload\n',
      );
      await external.lstat(`${remote}/project/empty`);

      const repeated = await uploads.uploadWorkspaceItems({
        connectionId: first.id,
        sourceUris: [vscode.Uri.file(join(localRoot, 'project'))],
        targetRemotePath: remote,
        cancellation: neverCancelled,
      });
      assert.ok(
        repeated.skipped.length > 0,
        'Skip conflict policy should preserve existing target files',
      );
      assert.ok(warnings.length > 0, 'directory/file conflicts should remain host-side prompts');
      await uploads.dispose();
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  });
});

class AcceptanceUriCodec implements SftpUriCodec {
  create(connectionId: string, remotePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme,
      authority: connectionId,
      path: normalizeRemotePath(remotePath),
    });
  }

  parse(uri: vscode.Uri): ParsedSftpUri {
    if (uri.scheme !== scheme || uri.query || uri.fragment || !uri.authority)
      throw new Error(`Invalid acceptance URI '${uri.toString()}'.`);
    return { connectionId: uri.authority, remotePath: normalizeRemotePath(uri.path) };
  }
}

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
  async getPassword(id: string): Promise<string | undefined> {
    return this.passwords.get(id);
  }
  async setPassword(id: string, value: string): Promise<void> {
    this.passwords.set(id, value);
  }
  async getKeyPassphrase(): Promise<string | undefined> {
    return undefined;
  }
  async setKeyPassphrase(): Promise<void> {}
  async clearPassword(id: string): Promise<void> {
    this.passwords.delete(id);
  }
  async clearKeyPassphrase(): Promise<void> {}
  async clearAll(id: string): Promise<void> {
    this.passwords.delete(id);
  }
  async copySelected(): Promise<[]> {
    return [];
  }
}

class AcceptingTrustPrompt implements HostTrustPrompt {
  async confirmFirstUse(details: HostKeyDetails): Promise<boolean> {
    void details;
    return true;
  }
  async confirmReplacement(
    expected: PersistedStateV1['hostKeys'][number],
    received: HostKeyDetails,
  ): Promise<boolean> {
    void expected;
    void received;
    return true;
  }
}

class ConflictPrompt implements AtomicWritePrompt {
  overwrite = false;
  readonly reasons: string[] = [];
  async confirmOverwrite(_uri: vscode.Uri, reason: string): Promise<boolean> {
    this.reasons.push(reason);
    return this.overwrite;
  }
  async confirmNonAtomicOverwrite(): Promise<boolean> {
    return this.overwrite;
  }
}

class PoolConfiguration {
  readonly onDidChange = (listener: (value: { sftpIdleTimeoutMs: number }) => unknown) => {
    void listener;
    return { dispose: () => undefined };
  };
  getSnapshot(): Readonly<{ sftpIdleTimeoutMs: number }> {
    return { sftpIdleTimeoutMs: configuration.sftpIdleTimeoutMs };
  }
}

function profile(name: string, fixturePort: number): RemoteConnection {
  const now = Date.now();
  return {
    id: randomUUID(),
    name,
    folderId: null,
    order: 0,
    host: '127.0.0.1',
    port: fixturePort,
    username: 'easyssh-test',
    defaultRemotePath: remoteRoot,
    authentication: { type: 'password', hasStoredPassword: true },
    agentAccess: defaultAgentAccessPolicy(),
    options: {},
    createdAt: now,
    updatedAt: now,
  };
}

async function replaceAll(editor: vscode.TextEditor, content: string): Promise<void> {
  const document = editor.document;
  const range = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length),
  );
  assert.equal(await editor.edit((builder) => builder.replace(range, content)), true);
}

function runDocker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryDocker(args: string[]): void {
  try {
    runDocker(args);
  } catch {
    // Best-effort fixture cleanup.
  }
}

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const connected = await new Promise<boolean>((done) => {
      const socket = connectSocket(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', () => done(false));
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error('Docker SSH fixture did not become ready.');
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for editor state.');
    await delay(20);
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((done) => setTimeout(done, milliseconds));
