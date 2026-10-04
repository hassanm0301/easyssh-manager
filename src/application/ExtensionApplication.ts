import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import { CommandRegistry } from '../commands/CommandRegistry';
import { DisposableStore } from '../common/disposables';
import { EasySshError } from '../common/errors';
import { createVsCodeLogger, type EasySshLogger } from '../common/logger';
import { ConnectionService } from '../connections/ConnectionService';
import {
  VsCodeCredentialCleanupQueue,
  VsCodeCredentialStore,
} from '../connections/CredentialStore';
import { OpenSshImporter } from '../connections/OpenSshImporter';
import { VsCodeStateRepository } from '../connections/StateRepository';
import { VsCodeConfigurationService } from '../configuration/ConfigurationService';
import { StateConnectionResolver } from '../ssh/ConnectionResolver';
import { DefaultCredentialResolver } from '../ssh/CredentialResolver';
import { HostKeyVerifier } from '../ssh/HostKeyVerifier';
import { SshClientFactory } from '../ssh/SshClientFactory';
import { DefaultSshSessionManager } from '../ssh/SshSessionManager';
import { SshTerminalRegistry } from '../ssh/SshTerminalSession';
import { TestConnectionService } from '../ssh/TestConnectionService';
import { VsCodeHostTrustPrompt } from '../ssh/VsCodeHostTrustPrompt';
import { AtomicSftpWriter, type RemoteConflictReason } from '../sftp/AtomicSftpWriter';
import { DownloadService } from '../sftp/DownloadService';
import { RemoteMutationService } from '../sftp/RemoteMutationService';
import { RemoteFileOpenService } from '../sftp/RemoteFileOpenService';
import { RemoteResourceCache } from '../sftp/RemoteResourceCache';
import { RemoteSftpFileSystemProvider } from '../sftp/RemoteSftpFileSystemProvider';
import { SftpBrowserService } from '../sftp/SftpBrowserService';
import { SessionSftpClientFactory } from '../sftp/SftpClientFactory';
import { DefaultSftpConnectionPool } from '../sftp/SftpConnectionPool';
import { DefaultSftpUriCodec } from '../sftp/SftpUriCodec';
import { WorkspacePaneService, WorkspaceUploadService } from '../sftp/WorkspaceUploadService';
import { ConnectionEditor } from '../views/connections/ConnectionEditor';
import { ImportPreview, type ImportSelection } from '../views/connections/ImportPreview';
import { SftpPanelManager } from '../views/sftp/SftpPanel';
import {
  ConnectionNode,
  ConnectionsTreeProvider,
  FolderNode,
} from '../views/connections/ConnectionsTreeProvider';

/** The single extension composition root. Subsystems own their own behavior. */
export class ExtensionApplication implements vscode.Disposable {
  private readonly disposables = new DisposableStore();
  private readonly configuration: VsCodeConfigurationService;
  private readonly logger: EasySshLogger;
  private readonly commands: CommandRegistry;
  private readonly treeProvider: ConnectionsTreeProvider;
  private readonly state: VsCodeStateRepository;
  private readonly connections: ConnectionService;
  private readonly editor: ConnectionEditor;
  private readonly importPreview: ImportPreview;
  private readonly sshSessions: DefaultSshSessionManager;
  private readonly sftpPool: DefaultSftpConnectionPool;
  private readonly sftpUriCodec: DefaultSftpUriCodec;
  private readonly sftpCache: RemoteResourceCache;
  private readonly sftpProvider: RemoteSftpFileSystemProvider;
  private readonly remoteFileOpener: RemoteFileOpenService;
  private readonly sftpPanels: SftpPanelManager;
  private readonly workspaceUploads: WorkspaceUploadService;
  private readonly knownConnectionIds = new Set<string>();
  private readonly terminals: SshTerminalRegistry;
  private readonly connectionTester: TestConnectionService;

  constructor(
    private readonly vscodeApi: typeof vscode,
    context: vscode.ExtensionContext,
  ) {
    this.configuration = this.disposables.add(new VsCodeConfigurationService(vscodeApi));
    this.logger = this.disposables.add(
      createVsCodeLogger(vscodeApi, () => this.configuration.getSnapshot().logLevel),
    );
    this.state = this.disposables.add(
      new VsCodeStateRepository(context.globalState, {
        error: (message) => vscodeApi.window.showErrorMessage(message),
      }),
    );
    const credentialStore = new VsCodeCredentialStore(context.secrets);
    this.connections = new ConnectionService(
      this.state,
      credentialStore,
      undefined,
      undefined,
      new VsCodeCredentialCleanupQueue(context.globalState),
    );
    const connectionResolver = new StateConnectionResolver(this.state);
    const credentialResolver = new DefaultCredentialResolver(credentialStore, vscodeApi.window);
    const hostKeys = new HostKeyVerifier(this.state, new VsCodeHostTrustPrompt(vscodeApi));
    const clients = new SshClientFactory(hostKeys, () => this.configuration.getSnapshot());
    this.sshSessions = this.disposables.add(
      new DefaultSshSessionManager(connectionResolver, credentialResolver, clients),
    );
    this.sftpPool = this.disposables.add(
      new DefaultSftpConnectionPool(
        new SessionSftpClientFactory(
          this.sshSessions,
          () => this.configuration.getSnapshot().connectTimeoutMs,
        ),
        this.configuration,
      ),
    );
    this.sftpUriCodec = new DefaultSftpUriCodec(vscodeApi.Uri, (connectionId) =>
      this.knownConnectionIds.has(connectionId),
    );
    this.sftpCache = new RemoteResourceCache(this.sftpUriCodec);
    const sftpWriter = new AtomicSftpWriter(
      this.sftpUriCodec,
      this.sftpCache,
      {
        confirmOverwrite: async (uri, reason) =>
          (await vscodeApi.window.showWarningMessage(
            overwritePrompt(uri.path, reason),
            { modal: true },
            'Overwrite Remote',
          )) === 'Overwrite Remote',
        confirmNonAtomicOverwrite: async (uri) =>
          (await vscodeApi.window.showWarningMessage(
            `The server cannot atomically replace '${uri.path}'. Continue with a non-atomic replacement?`,
            { modal: true },
            'Continue Non-Atomically',
          )) === 'Continue Non-Atomically',
      },
      this.logger,
    );
    this.sftpProvider = this.disposables.add(
      new RemoteSftpFileSystemProvider(
        vscodeApi,
        this.sftpUriCodec,
        this.sftpPool,
        this.sftpCache,
        sftpWriter,
      ),
    );
    this.remoteFileOpener = new RemoteFileOpenService(
      vscodeApi,
      this.sftpUriCodec,
      this.sftpPool,
      () => this.configuration.getSnapshot().maxInlineFileSizeMiB,
    );
    const sftpBrowser = new SftpBrowserService(this.sftpPool, this.sftpCache);
    const remoteMutations = new RemoteMutationService(
      vscodeApi,
      this.sftpUriCodec,
      this.sftpPool,
      this.sftpCache,
      this.sftpProvider,
    );
    const downloads = new DownloadService(vscodeApi, this.sftpPool, {
      maxBufferedTransferMiB: () => this.configuration.getSnapshot().maxBufferedTransferMiB,
    });
    this.workspaceUploads = this.disposables.add(
      new WorkspaceUploadService(
        vscodeApi,
        this.sftpPool,
        this.sftpCache,
        this.sftpUriCodec,
        this.sftpProvider,
        { maxBufferedTransferMiB: () => this.configuration.getSnapshot().maxBufferedTransferMiB },
      ),
    );
    this.sftpPanels = this.disposables.add(
      new SftpPanelManager({
        vscodeApi,
        extensionUri: context.extensionUri,
        browser: sftpBrowser,
        mutations: remoteMutations,
        downloads,
        remoteFileOpener: this.remoteFileOpener,
        codec: this.sftpUriCodec,
        pool: this.sftpPool,
        uploads: this.workspaceUploads,
        createWorkspacePane: () => new WorkspacePaneService(vscodeApi),
        resolveConnection: async (connectionId) =>
          (await this.state.load()).connections.find(
            (connection) => connection.id === connectionId,
          ),
      }),
    );
    this.terminals = this.disposables.add(
      new SshTerminalRegistry(vscodeApi, this.sshSessions, this.logger),
    );
    this.connectionTester = new TestConnectionService(this.sshSessions, connectionResolver);
    this.editor = this.disposables.add(
      new ConnectionEditor(
        vscodeApi,
        context.extensionUri,
        this.connections,
        this.connectionTester,
      ),
    );
    this.importPreview = this.disposables.add(new ImportPreview(vscodeApi, context.extensionUri));
    this.treeProvider = this.disposables.add(
      new ConnectionsTreeProvider(this.state, (id, folderId, beforeId) =>
        this.connections.moveItem(id, folderId, beforeId),
      ),
    );
    const treeView = this.disposables.add(
      vscodeApi.window.createTreeView('easysshManager.connections', {
        treeDataProvider: this.treeProvider,
        dragAndDropController: this.treeProvider,
        showCollapseAll: false,
      }),
    );
    this.disposables.add(
      treeView.onDidExpandElement(({ element }) => {
        if (element instanceof FolderNode) this.setFolderExpanded(element.folder.id, true);
      }),
    );
    this.disposables.add(
      treeView.onDidCollapseElement(({ element }) => {
        if (element instanceof FolderNode) this.setFolderExpanded(element.folder.id, false);
      }),
    );
    this.commands = this.disposables.add(
      new CommandRegistry(
        {
          registerCommand: (id, callback) => vscodeApi.commands.registerCommand(id, callback),
          showErrorMessage: (message) => vscodeApi.window.showErrorMessage(message),
          showInformationMessage: (message) => vscodeApi.window.showInformationMessage(message),
        },
        this.logger,
      ),
    );
  }

  async activate(): Promise<void> {
    this.replaceKnownConnections((await this.state.load()).connections.map(({ id }) => id));
    this.sftpPanels.registerRestoration();
    this.disposables.add(
      this.state.onDidChange((change) => {
        const previousIds = new Set(change.previous.connections.map(({ id }) => id));
        const currentIds = change.current.connections.map(({ id }) => id);
        this.replaceKnownConnections(currentIds);
        for (const connectionId of previousIds) {
          if (!this.knownConnectionIds.has(connectionId)) {
            this.sftpCache.invalidateConnection(connectionId);
            void this.sftpPool.invalidate(connectionId, 'connection removed');
          }
        }
        this.sftpPanels.updateConnections(change.current.connections);
        this.treeProvider.refresh(change);
      }),
    );
    this.disposables.add(
      this.vscodeApi.workspace.registerFileSystemProvider('remote-sftp', this.sftpProvider, {
        isCaseSensitive: true,
        isReadonly: false,
      }),
    );
    this.commands.register({
      id: 'easysshManager.refreshConnections',
      execute: async () => {
        this.treeProvider.refresh();
      },
    });
    this.commands.register({
      id: 'easysshManager.collapseAllConnections',
      execute: async () => {
        await this.state.update((draft) => {
          draft.uiPreferences.expandedFolderIds = [];
        });
        this.treeProvider.refresh();
      },
    });
    this.commands.register({
      id: 'easysshManager.openSettings',
      execute: async () => {
        await this.vscodeApi.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:hassanm0301.easyssh-manager',
        );
      },
    });
    this.commands.register({
      id: 'easysshManager.addFolder',
      execute: async (item?: unknown) => {
        const parentId = item instanceof FolderNode ? item.folder.id : null;
        const name = await this.vscodeApi.window.showInputBox({
          prompt: 'Folder name',
          validateInput: (value) => (value.trim() ? undefined : 'Folder name is required.'),
        });
        if (name !== undefined) await this.connections.addFolder(name, parentId);
      },
    });
    this.commands.register({
      id: 'easysshManager.addConnection',
      execute: async (item?: unknown) => {
        const state = await this.state.load();
        this.editor.open(
          undefined,
          state.folders,
          item instanceof FolderNode ? item.folder.id : null,
        );
      },
    });
    this.commands.register({
      id: 'easysshManager.editConnection',
      execute: async (id: unknown) => {
        const connectionId = selectedId(id, ConnectionNode);
        const state = await this.state.load();
        const connection = state.connections.find((candidate) => candidate.id === connectionId);
        if (!connection) throw new Error('Connection was not found.');
        this.editor.open(connection, state.folders);
      },
    });
    this.commands.register({
      id: 'easysshManager.duplicateConnection',
      execute: async (item: unknown) => {
        const sourceId = selectedId(item, ConnectionNode);
        const sourceState = await this.state.load();
        const original = sourceState.connections.find((connection) => connection.id === sourceId);
        if (!original) throw new Error('Connection was not found.');
        const duplicate = await this.connections.duplicateConnection(sourceId);
        const credentialName =
          original.authentication.type === 'password' && original.authentication.hasStoredPassword
            ? 'stored password'
            : original.authentication.type === 'privateKey' &&
                original.authentication.hasStoredPassphrase
              ? 'stored key passphrase'
              : undefined;
        if (!credentialName) return;
        const choice = await this.vscodeApi.window.showInformationMessage(
          `Copy the ${credentialName} to the duplicate?`,
          `Copy ${credentialName}`,
          'Keep metadata only',
        );
        if (choice === `Copy ${credentialName}`) {
          // The service intentionally creates metadata first. Credential copying is explicit consent.
          if (original.authentication.type === 'password') {
            await this.connections.copyCredentials(sourceId, duplicate.id, ['password']);
          } else if (original.authentication.type === 'privateKey') {
            await this.connections.copyCredentials(sourceId, duplicate.id, ['keyPassphrase']);
          }
        }
      },
    });
    this.commands.register({
      id: 'easysshManager.deleteConnection',
      execute: async (id: unknown) => {
        const connectionId = selectedId(id, ConnectionNode);
        const choice = await this.vscodeApi.window.showWarningMessage(
          'Delete this connection and its stored credentials?',
          { modal: true },
          'Delete',
        );
        if (choice === 'Delete') await this.connections.deleteConnection(connectionId);
      },
    });
    this.commands.register({
      id: 'easysshManager.renameFolder',
      execute: async (item: unknown) => {
        const folderId = selectedId(item, FolderNode);
        const folder = (await this.state.load()).folders.find(
          (candidate) => candidate.id === folderId,
        );
        if (!folder) throw new Error('Folder was not found.');
        const name = await this.vscodeApi.window.showInputBox({
          prompt: 'Folder name',
          value: folder.name,
        });
        if (name !== undefined) await this.connections.renameFolder(folderId, name);
      },
    });
    this.commands.register({
      id: 'easysshManager.deleteFolder',
      execute: async (item: unknown) => {
        const folderId = selectedId(item, FolderNode);
        const state = await this.state.load();
        const nonEmpty =
          state.folders.some((folder) => folder.parentId === folderId) ||
          state.connections.some((connection) => connection.folderId === folderId);
        const descendantFolderIds = collectFolderIds(state.folders, folderId);
        const descendantConnectionCount = state.connections.filter(
          (connection) =>
            connection.folderId !== null && descendantFolderIds.has(connection.folderId),
        ).length;
        const descendantFolderCount = descendantFolderIds.size - 1;
        const deleteLabel = `Delete ${descendantFolderCount} folders and ${descendantConnectionCount} connections`;
        const choice = nonEmpty
          ? await this.vscodeApi.window.showWarningMessage(
              `Folder contains ${descendantFolderCount} nested folders and ${descendantConnectionCount} connections.`,
              { modal: true },
              'Move children to parent',
              deleteLabel,
            )
          : await this.vscodeApi.window.showWarningMessage(
              'Delete this folder?',
              { modal: true },
              'Delete',
            );
        if (choice === 'Move children to parent')
          await this.connections.deleteFolder(folderId, 'moveChildren');
        if (choice === deleteLabel || choice === 'Delete')
          await this.connections.deleteFolder(folderId, 'recursive');
      },
    });
    this.commands.register({
      id: 'easysshManager.moveItem',
      execute: async (item: unknown) => {
        const id = selectedId(item);
        const folders = (await this.state.load()).folders;
        const destination = await this.vscodeApi.window.showQuickPick(
          [
            { label: 'Root', id: null },
            ...folders.map((folder) => ({
              label: folder.name,
              description: folder.id,
              id: folder.id,
            })),
          ],
          { placeHolder: 'Move item to folder' },
        );
        if (destination) await this.connections.moveItem(id, destination.id);
      },
    });
    this.commands.register({
      id: 'easysshManager.importSshConfig',
      execute: async () => {
        const importer = new OpenSshImporter();
        const sourceChoice = await this.vscodeApi.window.showQuickPick(
          [
            { label: 'Default ~/.ssh/config', value: 'default' as const },
            { label: 'Choose another config file…', value: 'choose' as const },
          ],
          { placeHolder: 'Select an OpenSSH configuration source' },
        );
        if (!sourceChoice) return;
        let sourcePath: string | undefined;
        if (sourceChoice.value === 'choose') {
          const picker = await this.vscodeApi.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Preview OpenSSH config',
            filters: { 'SSH config': ['config', 'sshconfig', '*'] },
          });
          if (!picker?.[0]) return;
          sourcePath = picker[0].fsPath;
        }
        const candidates = await importer.discover(sourcePath);
        if (candidates.length === 0) {
          void this.vscodeApi.window.showInformationMessage(
            'No concrete OpenSSH host aliases were found.',
          );
          return;
        }
        const folders = (await this.state.load()).folders;
        this.importPreview.open(candidates, folders, async (selections) => {
          for (const selection of selections) {
            const candidate = candidates.find((item) => item.candidateId === selection.candidateId);
            if (!candidate) continue;
            await this.importCandidate(candidate, selection);
          }
        });
      },
    });
    this.commands.register({
      id: 'easysshManager.openSsh',
      execute: async (item: unknown) => {
        const connectionId = selectedId(item, ConnectionNode);
        const connection = (await this.state.load()).connections.find(
          (candidate) => candidate.id === connectionId,
        );
        if (!connection) throw new EasySshError('NOT_FOUND', 'Connection was not found.');
        this.terminals.open(connection.id, connection.name);
      },
    });
    this.commands.register({
      id: 'easysshManager.testConnection',
      execute: async (item: unknown) => {
        const connectionId = selectedId(item, ConnectionNode);
        const result = await this.connectionTester.testSaved(connectionId, randomUUID());
        void this.vscodeApi.window.showInformationMessage(
          `Connection test succeeded: ${result.stages.join(' · ')} · ${result.durationMs} ms`,
        );
      },
    });
    this.commands.register({
      id: 'easysshManager.openSftp',
      execute: async (item: unknown) => {
        await this.sftpPanels.open(selectedId(item, ConnectionNode));
      },
    });
    this.commands.register({
      id: 'easysshManager.uploadFiles',
      execute: async () => {
        const summary = await this.sftpPanels.uploadFromCommand('files');
        void this.vscodeApi.window.showInformationMessage(uploadSummaryMessage(summary));
      },
    });
    this.commands.register({
      id: 'easysshManager.uploadFolder',
      execute: async () => {
        const summary = await this.sftpPanels.uploadFromCommand('folder');
        void this.vscodeApi.window.showInformationMessage(uploadSummaryMessage(summary));
      },
    });
    this.commands.register({
      id: 'easysshManager.openRemoteFile',
      execute: async (value: unknown) => {
        if (value === undefined) {
          await this.openRemoteFileForDevelopment();
          return;
        }
        const uri =
          value instanceof this.vscodeApi.Uri
            ? value
            : typeof value === 'string'
              ? this.vscodeApi.Uri.parse(value, true)
              : undefined;
        if (!uri) throw new EasySshError('VALIDATION', 'A remote SFTP URI is required.');
        await this.remoteFileOpener.open(uri);
      },
    });
    this.commands.register({
      id: 'easysshManager.openRemoteFileForDevelopment',
      execute: async (connectionId?: unknown, remotePath?: unknown) => {
        await this.openRemoteFileForDevelopment(
          typeof connectionId === 'string' ? connectionId : undefined,
          typeof remotePath === 'string' ? remotePath : undefined,
        );
      },
    });
    await this.connections.retryCredentialCleanup();
    await this.connections.reconcileCredentialHints();
    this.logger.info('EasySSH Manager activated', { operation: 'activation' });
  }

  async dispose(): Promise<void> {
    await this.disposables.dispose();
  }

  private setFolderExpanded(id: string, expanded: boolean): void {
    void this.state
      .update((draft) => {
        const ids = new Set(draft.uiPreferences.expandedFolderIds);
        if (expanded) ids.add(id);
        else ids.delete(id);
        draft.uiPreferences.expandedFolderIds = [...ids].filter((folderId) =>
          draft.folders.some((folder) => folder.id === folderId),
        );
      })
      .catch(() => undefined);
  }

  private replaceKnownConnections(connectionIds: readonly string[]): void {
    this.knownConnectionIds.clear();
    for (const connectionId of connectionIds) this.knownConnectionIds.add(connectionId);
  }

  private async openRemoteFileForDevelopment(
    requestedConnectionId?: string,
    requestedPath?: string,
  ): Promise<void> {
    const state = await this.state.load();
    let connection = state.connections.find(({ id }) => id === requestedConnectionId);
    if (!connection) {
      const picked = await this.vscodeApi.window.showQuickPick(
        state.connections.map((candidate) => ({
          label: candidate.name,
          description: `${candidate.username}@${candidate.host}:${candidate.port}`,
          connection: candidate,
        })),
        { placeHolder: 'Select an SFTP connection' },
      );
      connection = picked?.connection;
    }
    if (!connection) {
      if (state.connections.length === 0) {
        void this.vscodeApi.window.showInformationMessage('Add an SSH connection first.');
      }
      return;
    }
    const remotePath =
      requestedPath ??
      (await this.vscodeApi.window.showInputBox({
        prompt: 'Absolute remote file path',
        value: connection.defaultRemotePath,
        validateInput: (value) =>
          value.startsWith('/') ? undefined : 'Enter an absolute POSIX path.',
      }));
    if (remotePath === undefined) return;
    await this.remoteFileOpener.open(this.sftpUriCodec.create(connection.id, remotePath));
  }

  private async importCandidate(
    candidate: import('../connections/OpenSshImporter').SshImportCandidate,
    selection: ImportSelection,
  ): Promise<void> {
    const state = await this.state.load();
    const matching = state.connections.find(
      (connection) =>
        (connection.importedFromSshConfig?.sourcePath === candidate.sourcePath &&
          connection.importedFromSshConfig.hostPattern === candidate.hostPattern) ||
        (normalizedHost(connection.host) ===
          normalizedHost(candidate.host ?? candidate.hostPattern) &&
          connection.port === candidate.port &&
          connection.username === (candidate.username ?? '')),
    );
    if (matching) {
      const choice = await this.vscodeApi.window.showWarningMessage(
        `A connection already matches ${candidate.name}.`,
        'Import as New',
        'Replace Metadata',
        'Skip',
        'Cancel',
      );
      if (choice === 'Skip') return;
      if (choice === 'Cancel' || choice === undefined)
        throw new EasySshError('CANCELLED', 'OpenSSH import cancelled.');
      if (choice === 'Replace Metadata') {
        await this.connections.editConnection(matching.id, {
          ...importInput(candidate, selection),
          authentication: matching.authentication,
        });
        return;
      }
    }
    await this.connections.addConnection(importInput(candidate, selection));
  }
}

function selectedId(item: unknown, expected?: typeof ConnectionNode | typeof FolderNode): string {
  if (typeof item === 'string') return item;
  if (expected && !(item instanceof expected))
    throw new Error('Select an item from the Connections view.');
  if (item instanceof ConnectionNode) return item.connection.id;
  if (item instanceof FolderNode) return item.folder.id;
  throw new Error('Select an item from the Connections view.');
}

function importInput(
  candidate: import('../connections/OpenSshImporter').SshImportCandidate,
  selection: ImportSelection,
): import('../connections/ConnectionService').ConnectionInput {
  return {
    name: selection.name,
    folderId: selection.folderId,
    host: candidate.host ?? candidate.hostPattern,
    port: candidate.port,
    username: candidate.username ?? '',
    defaultRemotePath: '/',
    authentication:
      selection.authentication === 'privateKey' && selection.selectedIdentityFile
        ? {
            type: 'privateKey',
            privateKeyPath: selection.selectedIdentityFile,
            hasStoredPassphrase: false,
          }
        : selection.authentication === 'password'
          ? { type: 'password', hasStoredPassword: false }
          : { type: 'agent' },
    importedFromSshConfig: { sourcePath: candidate.sourcePath, hostPattern: candidate.hostPattern },
  };
}

function collectFolderIds(
  folders: readonly import('../connections/types').ConnectionFolder[],
  rootId: string,
): Set<string> {
  const found = new Set([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const folder of folders) {
      if (folder.parentId === parentId && !found.has(folder.id)) {
        found.add(folder.id);
        pending.push(folder.id);
      }
    }
  }
  return found;
}

function uploadSummaryMessage(
  summary: import('../sftp/WorkspaceUploadService').TransferSummary,
): string {
  return `Upload complete: ${summary.uploaded} files uploaded, ${summary.createdDirectories} directories created, ${summary.skipped.length + summary.skippedLinks.length} skipped, ${summary.failed.length} failed${summary.cancelled ? ', cancelled' : ''}.`;
}

function normalizedHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function overwritePrompt(path: string, reason: RemoteConflictReason): string {
  const detail =
    reason === 'changed'
      ? 'changed since it was opened'
      : reason === 'deleted'
        ? 'was deleted after it was opened'
        : 'was created by another process';
  return `The remote file '${path}' ${detail}. Overwrite the remote version?`;
}
