import * as vscode from 'vscode';

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
import { ConnectionEditor } from '../views/connections/ConnectionEditor';
import { ImportPreview, type ImportSelection } from '../views/connections/ImportPreview';
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
    this.connections = new ConnectionService(
      this.state,
      new VsCodeCredentialStore(context.secrets),
      undefined,
      undefined,
      new VsCodeCredentialCleanupQueue(context.globalState),
    );
    this.editor = this.disposables.add(new ConnectionEditor(vscodeApi, this.connections));
    this.importPreview = this.disposables.add(new ImportPreview(vscodeApi));
    this.treeProvider = this.disposables.add(
      new ConnectionsTreeProvider(this.state, (id, folderId, beforeId) =>
        this.connections.moveItem(id, folderId, beforeId),
      ),
    );
    const treeView = this.disposables.add(
      vscodeApi.window.createTreeView('easysshManager.connections', {
        treeDataProvider: this.treeProvider,
        dragAndDropController: this.treeProvider,
        showCollapseAll: true,
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
    this.disposables.add(this.state.onDidChange((change) => this.treeProvider.refresh(change)));
    this.commands.register({
      id: 'easysshManager.refreshConnections',
      execute: async () => {
        this.treeProvider.refresh();
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
    for (const id of [
      'easysshManager.openSsh',
      'easysshManager.testConnection',
      'easysshManager.openSftp',
    ] as const) {
      this.commands.register({
        id,
        execute: async () => {
          void this.vscodeApi.window.showInformationMessage(
            'This action is available after the SSH/SFTP transport milestone.',
          );
        },
      });
    }
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

function normalizedHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}
