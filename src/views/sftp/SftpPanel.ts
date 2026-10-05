import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError } from '../../common/errors';
import type { RemoteConnection } from '../../connections/types';
import { DownloadService } from '../../sftp/DownloadService';
import { RemoteMutationService } from '../../sftp/RemoteMutationService';
import { RemoteFileOpenService } from '../../sftp/RemoteFileOpenService';
import { SftpBrowserService } from '../../sftp/SftpBrowserService';
import { normalizeRemotePath } from '../../sftp/SftpUriCodec';
import type { SftpConnectionPool, SftpUriCodec } from '../../sftp/ports';
import {
  type TransferSummary,
  type WorkspaceEntryView,
  WorkspacePaneService,
  WorkspaceUploadService,
  type WorkspacePathSuggestion,
} from '../../sftp/WorkspaceUploadService';
import type { CancellationTokenLike } from '../../ssh/ports';
import { webviewAssetUri, webviewPanelOptions, webviewStylesheets } from '../shared/WebviewAssets';
import {
  MAX_HISTORY_ENTRIES,
  SFTP_PANEL_STATE_VERSION,
  defaultSftpLayoutState,
  type RemoteEntryView,
  type SftpPanelState,
  type SftpRequest,
  type SftpResponse,
  sanitizeSftpError,
  validateSftpPanelState,
  validateSftpRequest,
} from '../../sftp/browser/contracts';

export type PanelConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface PanelViewModel {
  readonly path: string;
  readonly entries: readonly RemoteEntryView[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
  readonly sort: SftpPanelState['sort'];
  readonly connection: { readonly state: PanelConnectionState; readonly text: string };
  readonly workspace: WorkspaceBrowserView;
  readonly layout: SftpPanelState['layout'];
}

type WorkspaceLocation = 'workspace' | string;

interface WorkspaceBrowserView {
  readonly generation: number;
  readonly state: 'ready' | 'untrusted' | 'noWorkspace' | 'error';
  readonly message?: string;
  readonly path: string;
  readonly location: WorkspaceLocation;
  readonly entries: readonly WorkspaceEntryView[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
  readonly sort: SftpPanelState['sort'];
  readonly loading: boolean;
}

interface WorkspaceBrowserState {
  location: WorkspaceLocation;
  entries: readonly WorkspaceEntryView[];
  historyBack: WorkspaceLocation[];
  historyForward: WorkspaceLocation[];
  sort: SftpPanelState['sort'];
  generation: number;
  state: WorkspaceBrowserView['state'];
  message?: string;
}

interface SftpPanelDependencies {
  readonly vscodeApi: typeof vscode;
  readonly extensionUri: vscode.Uri;
  readonly browser: SftpBrowserService;
  readonly mutations: RemoteMutationService;
  readonly downloads: DownloadService;
  readonly remoteFileOpener: RemoteFileOpenService;
  readonly codec: SftpUriCodec;
  readonly pool: SftpConnectionPool;
  readonly uploads: WorkspaceUploadService;
  readonly createWorkspacePane: () => WorkspacePaneService;
}

interface SftpPanelManagerDependencies extends SftpPanelDependencies {
  readonly resolveConnection: (
    connectionId: string,
  ) => Promise<Readonly<RemoteConnection> | undefined>;
}

/** Owns one restorable SFTP browser editor per connection UUID. */
export class SftpPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, SftpPanel>();
  private serializer: vscode.Disposable | undefined;
  private activeConnectionId: string | undefined;

  constructor(private readonly dependencies: SftpPanelManagerDependencies) {}

  registerRestoration(): void {
    if (this.serializer) return;
    this.serializer = this.dependencies.vscodeApi.window.registerWebviewPanelSerializer(
      'easysshManager.sftpBrowser',
      {
        deserializeWebviewPanel: async (panel, state: unknown) => {
          let restored: SftpPanelState;
          try {
            restored = validateSftpPanelState(state);
          } catch {
            panel.dispose();
            void this.dependencies.vscodeApi.window.showErrorMessage(
              'EasySSH Manager: The saved SFTP browser state was invalid and was discarded.',
            );
            return;
          }
          const connection = await this.dependencies.resolveConnection(restored.connectionId);
          if (!connection) {
            panel.dispose();
            void this.dependencies.vscodeApi.window.showErrorMessage(
              'EasySSH Manager: The connection for this restored SFTP browser no longer exists.',
            );
            return;
          }
          const existing = this.panels.get(connection.id);
          if (existing) {
            existing.reveal();
            panel.dispose();
            return;
          }
          this.attach(panel, connection, restored);
        },
      },
    );
  }

  async open(connectionId: string): Promise<void> {
    const connection = await this.dependencies.resolveConnection(connectionId);
    if (!connection) throw new EasySshError('NOT_FOUND', 'Connection was not found.');
    const existing = this.panels.get(connection.id);
    if (existing) {
      existing.reveal();
      this.activeConnectionId = connection.id;
      return;
    }
    const panel = this.dependencies.vscodeApi.window.createWebviewPanel(
      'easysshManager.sftpBrowser',
      `SFTP: ${connection.name}`,
      this.dependencies.vscodeApi.ViewColumn.Active,
      webviewPanelOptions(this.dependencies.vscodeApi, this.dependencies.extensionUri),
    );
    this.attach(panel, connection);
    this.activeConnectionId = connection.id;
  }

  async uploadFromCommand(kind: 'files' | 'folder'): Promise<TransferSummary> {
    const panel = this.activeConnectionId ? this.panels.get(this.activeConnectionId) : undefined;
    if (!panel) {
      throw new EasySshError(
        'NOT_FOUND',
        'Open an SFTP browser before choosing workspace items to upload.',
      );
    }
    return panel.uploadFromCommand(kind);
  }

  updateConnections(connections: readonly RemoteConnection[]): void {
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    for (const [connectionId, panel] of this.panels) {
      const connection = byId.get(connectionId);
      if (!connection) {
        panel.dispose();
        continue;
      }
      panel.updateTitle(connection.name);
    }
  }

  dispose(): void {
    this.serializer?.dispose();
    this.serializer = undefined;
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  private attach(
    panel: vscode.WebviewPanel,
    connection: Readonly<RemoteConnection>,
    restored?: SftpPanelState,
  ): void {
    const instance = new SftpPanel(panel, connection, this.dependencies, restored, () => {
      this.panels.delete(connection.id);
      if (this.activeConnectionId === connection.id) this.activeConnectionId = undefined;
    });
    this.panels.set(connection.id, instance);
    instance.start();
  }
}

class SftpPanel implements vscode.Disposable {
  private disposed = false;
  private generation = 0;
  private pending = 0;
  private readonly pendingControllers = new Set<PanelCancellation>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private state: SftpPanelState;
  private connectionState: PanelConnectionState = 'connecting';
  private connectionText = 'Connecting';
  private entries: readonly RemoteEntryView[] = [];
  private readonly workspace: WorkspacePaneService;
  private workspaceState: WorkspaceBrowserState;
  private workspaceLoadGeneration = 0;
  private workspacePending = 0;
  private readonly uploadControllers = new Set<PanelCancellation>();
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connection: Readonly<RemoteConnection>,
    private readonly dependencies: SftpPanelDependencies,
    restored: SftpPanelState | undefined,
    private readonly onDispose: () => void,
  ) {
    this.workspace = dependencies.createWorkspacePane();
    const workspace = this.workspace.initialize();
    this.workspaceState = {
      location: 'workspace',
      entries: sortWorkspaceEntries(
        workspace.roots.map((root) => ({
          name: root.name,
          uri: root.uri,
          path: root.path,
          kind: 'directory' as const,
        })),
        { key: 'name', direction: 'asc' },
      ),
      historyBack: [],
      historyForward: [],
      sort: { key: 'name', direction: 'asc' },
      generation: workspace.generation,
      state: workspace.state,
      ...(workspace.message ? { message: workspace.message } : {}),
    };
    this.state = restored ?? {
      version: SFTP_PANEL_STATE_VERSION,
      connectionId: connection.id,
      currentPath: normalizedDefaultPath(connection.defaultRemotePath),
      historyBack: [],
      historyForward: [],
      sort: { key: 'name', direction: 'asc' },
      layout: defaultSftpLayoutState(),
    };
    this.panel.title = `SFTP: ${connection.name}`;
    const nonce = randomBytes(18).toString('base64');
    this.panel.webview.html = sftpPanelHtml(
      this.panel.webview,
      this.dependencies.vscodeApi,
      this.dependencies.extensionUri,
      nonce,
    );
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      this.workspace.onDidChange((reason) => {
        if (reason !== 'filesystem') {
          for (const controller of this.uploadControllers) controller.cancel();
          this.resetWorkspace();
        } else {
          void this.loadWorkspace(this.workspaceState.location, false, false).catch(
            () => undefined,
          );
        }
        this.render();
      }),
      this.dependencies.uploads.onDidCommit((event) => this.scheduleCommitRefresh(event)),
    );
  }

  start(): void {
    void this.load(this.state.currentPath, true, false).catch(() => undefined);
  }

  reveal(): void {
    this.panel.reveal(this.dependencies.vscodeApi.ViewColumn.Active, false);
  }

  uploadFromCommand(kind: 'files' | 'folder'): Promise<TransferSummary> {
    return this.uploadPicker(this.state.currentPath, kind);
  }

  updateTitle(name: string): void {
    this.panel.title = `SFTP: ${name}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const controller of this.pendingControllers) controller.cancel();
    for (const controller of this.uploadControllers) controller.cancel();
    this.pendingControllers.clear();
    this.uploadControllers.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.workspace.dispose();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.onDispose();
    this.panel.dispose();
  }

  private async receive(message: unknown): Promise<void> {
    const requestId = requestIdOf(message);
    try {
      const request = validateSftpRequest(message);
      const value = await this.dispatch(request);
      await this.respond({ requestId: request.requestId, ok: true, value });
    } catch (error) {
      await this.respond({ requestId, ok: false, error: sanitizeSftpError(error) });
    }
  }

  private async dispatch(request: SftpRequest): Promise<unknown> {
    switch (request.type) {
      case 'ready':
        this.persistState();
        this.render();
        return undefined;
      case 'list':
        if (this.connectionState === 'disconnected' || this.connectionState === 'error') {
          await this.dependencies.pool.invalidate(this.connection.id, 'user requested reconnect');
        }
        return this.load(request.path, request.force, false);
      case 'navigate':
        return this.load(request.path, false, true);
      case 'navigateInput':
        return this.load(resolveRemoteInput(request.value, this.state.currentPath), false, true);
      case 'remoteExpand': {
        const generation = this.generation;
        const cancellation = new PanelCancellation();
        this.pendingControllers.add(cancellation);
        try {
          const listing = await this.dependencies.browser.list(this.connection.id, request.path, {
            force: request.force,
            sort: this.state.sort.key,
            direction: this.state.sort.direction,
            cancellation,
          });
          if (this.disposed || generation !== this.generation) return { stale: true };
          await this.panel.webview.postMessage({
            type: 'remoteChildren',
            path: request.path,
            entries: listing.entries,
          });
        } catch (error) {
          if (this.disposed || generation !== this.generation) return { stale: true };
          await this.panel.webview.postMessage({
            type: 'remoteError',
            path: request.path,
            error: sanitizeSftpError(error).message,
          });
          throw error;
        } finally {
          this.pendingControllers.delete(cancellation);
        }
        return undefined;
      }
      case 'remoteSuggest': {
        const generation = this.generation;
        const cancellation = new PanelCancellation();
        this.pendingControllers.add(cancellation);
        const suggestions = await this.remoteSuggestions(request.value, cancellation).finally(() =>
          this.pendingControllers.delete(cancellation),
        );
        if (this.disposed || generation !== this.generation) return { stale: true };
        await this.panel.webview.postMessage({
          type: 'pathSuggestions',
          pane: 'remote',
          requestId: request.requestId,
          suggestions,
        });
        return undefined;
      }
      case 'back': {
        const path = this.state.historyBack.at(-1);
        if (!path) return this.viewModel();
        return this.load(path, false, 'back');
      }
      case 'forward': {
        const path = this.state.historyForward.at(-1);
        if (!path) return this.viewModel();
        return this.load(path, false, 'forward');
      }
      case 'up': {
        const path = posix.dirname(this.state.currentPath);
        return this.load(path, false, path !== this.state.currentPath);
      }
      case 'setSort':
        this.state = { ...this.state, sort: { key: request.key, direction: request.direction } };
        return this.load(this.state.currentPath, false, false);
      case 'setLayout':
        this.state = { ...this.state, layout: request.layout };
        this.persistState();
        return undefined;
      case 'cancel':
        for (const controller of this.pendingControllers) controller.cancel();
        return undefined;
      case 'open': {
        const target = await this.dependencies.browser.resolveExplicitLink(
          this.connection.id,
          request.path,
        );
        const stat = await this.withClient((client) => client.stat(target));
        if (stat.kind === 'directory') return this.load(target, false, true);
        await this.dependencies.remoteFileOpener.open(
          this.dependencies.codec.create(this.connection.id, target),
        );
        return undefined;
      }
      case 'createFile': {
        const uri = await this.dependencies.mutations.createFile(
          this.connection.id,
          request.parentPath,
          request.name,
        );
        await this.load(request.parentPath, true, false);
        await this.dependencies.remoteFileOpener.open(uri);
        return undefined;
      }
      case 'createDirectory':
        await this.dependencies.mutations.createDirectory(
          this.connection.id,
          request.parentPath,
          request.name,
        );
        return this.load(request.parentPath, true, false);
      case 'rename': {
        const target = await this.dependencies.mutations.rename(
          this.connection.id,
          request.path,
          request.newName,
        );
        return this.load(posix.dirname(target.path), true, false);
      }
      case 'delete':
        await this.dependencies.mutations.delete(this.connection.id, request.path);
        return this.load(posix.dirname(request.path), true, false);
      case 'copyPath':
        await this.dependencies.vscodeApi.env.clipboard.writeText(request.path);
        return undefined;
      case 'download':
        return this.dependencies.downloads.chooseAndDownload(this.connection.id, request.paths);
      case 'workspaceRefresh':
        return this.loadWorkspace(this.workspaceState.location, true, false);
      case 'workspaceExpand': {
        const generation = this.workspaceState.generation;
        try {
          const entries = sortWorkspaceEntries(
            await this.workspace.readChildren(request.uri),
            this.workspaceState.sort,
          );
          if (generation !== this.workspaceState.generation) return { stale: true };
          await this.panel.webview.postMessage({
            type: 'workspaceChildren',
            uri: request.uri,
            entries,
            generation,
          });
        } catch (error) {
          if (generation !== this.workspaceState.generation) return { stale: true };
          await this.panel.webview.postMessage({
            type: 'workspaceError',
            uri: request.uri,
            error: sanitizeSftpError(error).message,
          });
          throw error;
        }
        return undefined;
      }
      case 'workspaceNavigate': {
        let target: WorkspaceLocation;
        if (request.input && request.target.trim().toLocaleLowerCase() === 'workspace') {
          target = 'workspace';
        } else if (request.input) {
          if (this.workspaceState.location === 'workspace' && !request.target.includes('/')) {
            const matches = this.workspace
              .view()
              .roots.filter(
                (root) =>
                  root.name.toLocaleLowerCase() === request.target.trim().toLocaleLowerCase(),
              );
            if (matches.length !== 1) {
              throw new EasySshError(
                'VALIDATION',
                matches.length > 1
                  ? 'That workspace name is ambiguous. Choose a path suggestion.'
                  : 'Choose an existing workspace root or enter an absolute path.',
              );
            }
            target = matches[0]!.uri;
          } else {
            target = await this.workspace.resolveTypedDirectory(
              request.target,
              this.workspaceState.location === 'workspace'
                ? undefined
                : this.workspaceState.location,
            );
          }
        } else {
          this.workspace.authorizeIssued(request.target);
          target = request.target;
        }
        return this.loadWorkspace(target, false, true);
      }
      case 'workspaceBack': {
        const target = this.workspaceState.historyBack.at(-1);
        return target ? this.loadWorkspace(target, false, 'back') : this.workspaceView();
      }
      case 'workspaceForward': {
        const target = this.workspaceState.historyForward.at(-1);
        return target ? this.loadWorkspace(target, false, 'forward') : this.workspaceView();
      }
      case 'workspaceUp': {
        if (this.workspaceState.location === 'workspace') return this.workspaceView();
        const parent = await this.workspace.parent(this.workspaceState.location);
        return parent ? this.loadWorkspace(parent, false, true) : this.workspaceView();
      }
      case 'workspaceSetSort':
        this.workspaceState.sort = { key: request.key, direction: request.direction };
        return this.loadWorkspace(this.workspaceState.location, false, false);
      case 'workspaceOpen': {
        const uri = this.workspace.authorizeIssued(request.uri);
        const stat = await this.dependencies.vscodeApi.workspace.fs.stat(uri);
        if ((stat.type & this.dependencies.vscodeApi.FileType.Directory) !== 0) {
          return this.loadWorkspace(request.uri, false, true);
        }
        await this.dependencies.vscodeApi.commands.executeCommand('vscode.open', uri, {
          viewColumn: this.dependencies.vscodeApi.ViewColumn.Beside,
          preview: true,
        });
        return undefined;
      }
      case 'workspaceCopyPath': {
        const uri = this.workspace.authorizeIssued(request.uri);
        await this.dependencies.vscodeApi.env.clipboard.writeText(
          uri.scheme === 'file' ? uri.fsPath : uri.toString(),
        );
        return undefined;
      }
      case 'workspaceSuggest': {
        const generation = this.workspaceState.generation;
        const suggestions = await this.workspaceSuggestions(request.value);
        if (generation !== this.workspaceState.generation) return { stale: true };
        await this.panel.webview.postMessage({
          type: 'pathSuggestions',
          pane: 'workspace',
          requestId: request.requestId,
          suggestions,
        });
        return undefined;
      }
      case 'workspaceDrop': {
        const sources = await this.workspace.freshAuthorizedSources(request.payload);
        return this.upload(sources, request.targetPath);
      }
      case 'uploadFiles':
        return this.uploadPicker(request.targetPath, 'files');
      case 'uploadFolder':
        return this.uploadPicker(request.targetPath, 'folder');
    }
  }

  private async load(
    path: string,
    force: boolean,
    navigation: boolean | 'back' | 'forward',
  ): Promise<PanelViewModel | { readonly stale: true }> {
    const generation = ++this.generation;
    const cancellation = new PanelCancellation();
    this.pendingControllers.add(cancellation);
    this.pending += 1;
    this.connectionState = 'connecting';
    this.connectionText = 'Connecting';
    this.render();
    try {
      const listing = await this.dependencies.browser.list(this.connection.id, path, {
        force,
        sort: this.state.sort.key,
        direction: this.state.sort.direction,
        cancellation,
      });
      if (this.disposed || generation !== this.generation) return { stale: true };
      if (navigation === true && listing.path !== this.state.currentPath) {
        this.state = {
          ...this.state,
          currentPath: listing.path,
          historyBack: appendHistory(this.state.historyBack, this.state.currentPath),
          historyForward: [],
        };
      } else if (navigation === 'back') {
        const previous = this.state.historyBack.slice(0, -1);
        this.state = {
          ...this.state,
          currentPath: listing.path,
          historyBack: previous,
          historyForward: appendHistory(this.state.historyForward, this.state.currentPath),
        };
      } else if (navigation === 'forward') {
        const previous = this.state.historyForward.slice(0, -1);
        this.state = {
          ...this.state,
          currentPath: listing.path,
          historyBack: appendHistory(this.state.historyBack, this.state.currentPath),
          historyForward: previous,
        };
      } else if (path === this.state.currentPath) {
        // A list response for the active location only refreshes the view.
      }
      this.entries = listing.entries;
      this.connectionState = 'connected';
      this.connectionText = 'Connected';
      this.persistState();
      return this.viewModel();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return { stale: true };
      const safe = sanitizeSftpError(error);
      this.connectionState =
        safe.code === 'CONNECTION_LOST' || safe.code === 'NETWORK' ? 'disconnected' : 'connected';
      this.connectionText =
        this.connectionState === 'disconnected'
          ? 'Disconnected — reconnect to continue'
          : 'Connected';
      throw error;
    } finally {
      this.pendingControllers.delete(cancellation);
      this.pending = Math.max(0, this.pending - 1);
      if (!this.disposed && generation === this.generation) this.render();
    }
  }

  private async loadWorkspace(
    location: WorkspaceLocation,
    _force: boolean,
    navigation: boolean | 'back' | 'forward',
  ): Promise<WorkspaceBrowserView | { readonly stale: true }> {
    const generation = ++this.workspaceLoadGeneration;
    this.workspacePending += 1;
    this.render();
    try {
      let entries: readonly WorkspaceEntryView[];
      let state: WorkspaceBrowserView['state'] = 'ready';
      let message: string | undefined;
      if (location === 'workspace') {
        const root = this.workspace.view();
        state = root.state;
        message = root.message;
        entries = root.roots.map((entry) => ({
          name: entry.name,
          uri: entry.uri,
          path: entry.path,
          kind: 'directory' as const,
        }));
        this.workspaceState.generation = root.generation;
      } else {
        entries = await this.workspace.readChildren(location);
      }
      if (this.disposed || generation !== this.workspaceLoadGeneration) return { stale: true };
      const previous = this.workspaceState.location;
      if (navigation === true && location !== previous) {
        this.workspaceState.historyBack = appendWorkspaceHistory(
          this.workspaceState.historyBack,
          previous,
        );
        this.workspaceState.historyForward = [];
      } else if (navigation === 'back') {
        this.workspaceState.historyBack = this.workspaceState.historyBack.slice(0, -1);
        this.workspaceState.historyForward = appendWorkspaceHistory(
          this.workspaceState.historyForward,
          previous,
        );
      } else if (navigation === 'forward') {
        this.workspaceState.historyForward = this.workspaceState.historyForward.slice(0, -1);
        this.workspaceState.historyBack = appendWorkspaceHistory(
          this.workspaceState.historyBack,
          previous,
        );
      }
      this.workspaceState.location = location;
      this.workspaceState.entries = sortWorkspaceEntries(entries, this.workspaceState.sort);
      this.workspaceState.state = state;
      if (message === undefined) delete this.workspaceState.message;
      else this.workspaceState.message = message;
      return this.workspaceView();
    } catch (error) {
      if (this.disposed || generation !== this.workspaceLoadGeneration) return { stale: true };
      this.workspaceState.message = sanitizeSftpError(error).message;
      throw error;
    } finally {
      this.workspacePending = Math.max(0, this.workspacePending - 1);
      if (!this.disposed && generation === this.workspaceLoadGeneration) this.render();
    }
  }

  private resetWorkspace(): void {
    this.workspaceLoadGeneration += 1;
    const root = this.workspace.initialize();
    this.workspaceState = {
      location: 'workspace',
      entries: sortWorkspaceEntries(
        root.roots.map((entry) => ({
          name: entry.name,
          uri: entry.uri,
          path: entry.path,
          kind: 'directory' as const,
        })),
        this.workspaceState.sort,
      ),
      historyBack: [],
      historyForward: [],
      sort: this.workspaceState.sort,
      generation: root.generation,
      state: root.state,
      ...(root.message ? { message: root.message } : {}),
    };
  }

  private workspaceView(): WorkspaceBrowserView {
    let path = 'Workspace';
    let canGoUp = false;
    if (this.workspaceState.location !== 'workspace') {
      path = this.workspace.displayPath(this.workspaceState.location);
      const uri = this.workspace.authorizeIssued(this.workspaceState.location);
      canGoUp = posix.dirname(uri.path) !== uri.path;
    }
    return {
      generation: this.workspaceState.generation,
      state: this.workspaceState.state,
      ...(this.workspaceState.message ? { message: this.workspaceState.message } : {}),
      path,
      location: this.workspaceState.location,
      entries: this.workspaceState.entries,
      canGoBack: this.workspaceState.historyBack.length > 0,
      canGoForward: this.workspaceState.historyForward.length > 0,
      canGoUp,
      sort: this.workspaceState.sort,
      loading: this.workspacePending > 0,
    };
  }

  private async workspaceSuggestions(value: string): Promise<readonly WorkspacePathSuggestion[]> {
    if (this.workspaceState.state !== 'ready') return [];
    if (this.workspaceState.location !== 'workspace') {
      return this.workspace.suggestDirectories(value, this.workspaceState.location);
    }
    const query = value.trim();
    if (query.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(query)) {
      return this.workspace.suggestDirectories(query);
    }
    const roots = this.workspace.view().roots;
    return roots
      .filter((root) => root.name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()))
      .slice(0, 50)
      .map((root) => ({
        label: root.name,
        value: this.workspace.displayPath(root.uri),
        description: this.workspace.displayPath(root.uri),
        uri: root.uri,
      }));
  }

  private async remoteSuggestions(
    value: string,
    cancellation: CancellationTokenLike,
  ): Promise<readonly { label: string; value: string; description: string }[]> {
    const input = value.trim();
    const absolute = input.startsWith('/') ? input : posix.join(this.state.currentPath, input);
    const parent = input.endsWith('/') ? absolute : posix.dirname(absolute);
    const prefix = input.endsWith('/') ? '' : posix.basename(input);
    try {
      const listing = await this.dependencies.browser.list(this.connection.id, parent, {
        force: false,
        sort: 'name',
        direction: 'asc',
        cancellation,
      });
      return listing.entries
        .filter(
          (entry) =>
            entry.kind === 'directory' &&
            entry.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()),
        )
        .slice(0, 50)
        .map((entry) => ({ label: entry.name, value: entry.path, description: entry.path }));
    } catch {
      return [];
    }
  }

  private async withClient<T>(
    operation: (client: import('../../sftp/ports').SftpClient) => Promise<T>,
  ): Promise<T> {
    const lease = await this.dependencies.pool.acquire(
      this.connection.id,
      undefined,
      'interactive',
    );
    try {
      return await operation(lease.client);
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }

  private viewModel(): PanelViewModel {
    return {
      path: this.state.currentPath,
      entries: this.entries,
      canGoBack: this.state.historyBack.length > 0,
      canGoForward: this.state.historyForward.length > 0,
      canGoUp: this.state.currentPath !== '/',
      sort: this.state.sort,
      connection: { state: this.connectionState, text: this.connectionText },
      workspace: this.workspaceView(),
      layout: this.state.layout,
    };
  }

  private render(): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: 'render',
      value: this.viewModel(),
      pending: this.pending,
    });
  }

  private persistState(): void {
    void Promise.resolve(
      this.panel.webview.postMessage({ type: 'persist', value: this.state }),
    ).catch(() => undefined);
  }

  private async respond(response: SftpResponse<unknown>): Promise<void> {
    if (!this.disposed) await this.panel.webview.postMessage({ type: 'response', ...response });
  }

  private async upload(
    sources: readonly vscode.Uri[],
    dropTarget: string,
  ): Promise<TransferSummary> {
    const targetRemotePath = await this.resolveUploadTarget(dropTarget);
    const cancellation = new PanelCancellation();
    this.uploadControllers.add(cancellation);
    try {
      return await this.dependencies.uploads.uploadWorkspaceItems({
        connectionId: this.connection.id,
        sourceUris: sources,
        targetRemotePath,
        cancellation,
      });
    } finally {
      this.uploadControllers.delete(cancellation);
    }
  }

  private async uploadPicker(
    dropTarget: string,
    kind: 'files' | 'folder',
  ): Promise<TransferSummary> {
    const targetRemotePath = await this.resolveUploadTarget(dropTarget);
    const cancellation = new PanelCancellation();
    this.uploadControllers.add(cancellation);
    try {
      // The picker result is kept inside the host and does not mint webview URI grants.
      return await this.dependencies.uploads.chooseAndUpload(
        this.connection.id,
        targetRemotePath,
        kind,
        cancellation,
      );
    } finally {
      this.uploadControllers.delete(cancellation);
    }
  }

  private async resolveUploadTarget(requestedPath: string): Promise<string> {
    const path = normalizeRemotePath(requestedPath);
    const stat = await this.withClient((client) => client.lstat(path));
    if (stat.kind !== 'directory') {
      throw new EasySshError('NOT_DIRECTORY', 'Choose a remote directory as the upload target.');
    }
    return path;
  }

  private scheduleCommitRefresh(event: {
    readonly connectionId: string;
    readonly path: string;
  }): void {
    if (event.connectionId !== this.connection.id || this.disposed) return;
    const current = this.state.currentPath;
    if (posix.dirname(event.path) !== current && event.path !== current) return;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (!this.disposed)
        void this.load(this.state.currentPath, true, false).catch(() => undefined);
    }, 100);
  }
}

export function sftpPanelHtml(
  webview: vscode.Webview,
  api: typeof vscode,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const script = webviewAssetUri(webview, api, extensionUri, 'sftp-browser.js');
  const styles = webviewStylesheets(webview, api, extensionUri, 'sftp-browser-style.css');
  const headers = (pane: 'workspace' | 'remote'): string => {
    const sortAttribute = pane === 'workspace' ? 'data-workspace-sort' : 'data-sort';
    return `<div class="headers" role="row">
      <div class="column-header" role="columnheader" data-column="name"><button type="button" ${sortAttribute}="name"><span>Name</span><span class="codicon sort-icon" aria-hidden="true"></span></button><span class="column-resizer" role="separator" tabindex="0" aria-label="Resize Name column" aria-orientation="vertical" data-resize-column="name" data-pane="${pane}"></span></div>
      <div class="column-header" role="columnheader" data-column="type"><span class="column-label">Type</span><span class="column-resizer" role="separator" tabindex="0" aria-label="Resize Type column" aria-orientation="vertical" data-resize-column="type" data-pane="${pane}"></span></div>
      <div class="column-header" role="columnheader" data-column="size"><button type="button" ${sortAttribute}="size"><span>Size</span><span class="codicon sort-icon" aria-hidden="true"></span></button><span class="column-resizer" role="separator" tabindex="0" aria-label="Resize Size column" aria-orientation="vertical" data-resize-column="size" data-pane="${pane}"></span></div>
      <div class="column-header" role="columnheader" data-column="mtime"><button type="button" ${sortAttribute}="mtime"><span>Modified</span><span class="codicon sort-icon" aria-hidden="true"></span></button><span class="column-resizer" role="separator" tabindex="0" aria-label="Resize Modified column" aria-orientation="vertical" data-resize-column="mtime" data-pane="${pane}"></span></div>
      <div class="column-header" role="columnheader" data-column="path"><span class="column-label">Path</span><span class="column-resizer" role="separator" tabindex="0" aria-label="Resize Path column" aria-orientation="vertical" data-resize-column="path" data-pane="${pane}"></span></div>
    </div>`;
  };
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
${styles}<title>SFTP browser</title></head><body>
<main id="sftp-browser" aria-label="Remote SFTP browser">
  <header class="browser-header">
    <div><div class="eyebrow"><span class="codicon codicon-remote" aria-hidden="true"></span>Secure file transfer</div><h1>Workspace and remote files</h1></div>
    <div class="connection-status"><p id="status" role="status" aria-live="polite"><span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span><span>Connecting</span></p><span id="loading" class="loading-label" hidden><span class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span> Loading</span></div>
  </header>
  <div class="browser-layout">
    <section id="workspace-pane" class="pane surface-card" aria-labelledby="workspace-heading">
      <div class="pane-header"><h2 id="workspace-heading"><span class="codicon codicon-files" aria-hidden="true"></span>Workspace</h2><span class="pane-hint">Drag items to a remote folder</span></div>
      <div class="pane-toolbar" aria-label="Workspace navigation">
        <button type="button" id="workspace-back" class="icon-button" title="Back" aria-label="Workspace back"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
        <button type="button" id="workspace-forward" class="icon-button" title="Forward" aria-label="Workspace forward"><span class="codicon codicon-arrow-right" aria-hidden="true"></span></button>
        <button type="button" id="workspace-up" class="icon-button" title="Up one folder" aria-label="Workspace up one folder"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
        <button type="button" id="workspace-refresh" class="icon-button" title="Refresh workspace" aria-label="Refresh workspace"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>
        <button type="button" class="icon-button columns-button" data-columns-button="workspace" title="Choose visible columns" aria-label="Choose visible columns" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-table" aria-hidden="true"></span></button>
        <div class="path-combobox"><input id="workspace-path" role="combobox" aria-label="Workspace path" aria-autocomplete="list" aria-controls="workspace-suggestions" aria-expanded="false" autocomplete="off"><div id="workspace-suggestions" class="path-suggestions" role="listbox" hidden></div></div>
      </div>
      <p id="workspace-state" class="pane-state" role="status" aria-live="polite"></p>
      <section id="workspace-list" class="file-list" role="treegrid" aria-label="Workspace files" tabindex="0">
        ${headers('workspace')}
        <div id="workspace-rows"></div>
        <div id="workspace-empty" class="empty-state" hidden><span class="codicon codicon-folder" aria-hidden="true"></span><strong>This folder is empty</strong></div>
      </section>
    </section>
    <div id="pane-resizer" class="pane-resizer" role="separator" tabindex="0" aria-label="Resize workspace and remote panes" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="40"></div>
    <section id="remote-pane" class="pane surface-card" aria-labelledby="remote-heading">
      <div class="pane-header"><h2 id="remote-heading"><span class="codicon codicon-remote-explorer" aria-hidden="true"></span>Remote</h2></div>
      <section class="pane-toolbar remote-toolbar" aria-label="SFTP browser toolbar">
        <div class="toolbar-group navigation-group" aria-label="Navigation">
          <button type="button" id="back" class="icon-button" title="Back" aria-label="Back"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
          <button type="button" id="forward" class="icon-button" title="Forward" aria-label="Forward"><span class="codicon codicon-arrow-right" aria-hidden="true"></span></button>
          <button type="button" id="up" class="icon-button" title="Up one folder" aria-label="Up one folder"><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button>
          <button type="button" id="refresh" class="icon-button" title="Refresh remote directory" aria-label="Refresh remote directory"><span class="codicon codicon-refresh" aria-hidden="true"></span></button>
          <button type="button" class="icon-button columns-button" data-columns-button="remote" title="Choose visible columns" aria-label="Choose visible columns" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-table" aria-hidden="true"></span></button>
        </div>
        <div class="path-combobox"><input id="remote-path" role="combobox" aria-label="Remote path" aria-autocomplete="list" aria-controls="remote-suggestions" aria-expanded="false" autocomplete="off"><div id="remote-suggestions" class="path-suggestions" role="listbox" hidden></div></div>
        <div class="toolbar-group">
          <button type="button" id="new-file" class="secondary"><span class="codicon codicon-new-file" aria-hidden="true"></span>New File</button>
          <button type="button" id="new-folder" class="secondary"><span class="codicon codicon-new-folder" aria-hidden="true"></span>New Folder</button>
        </div>
        <div class="toolbar-group transfer-group">
          <button type="button" id="upload-files"><span class="codicon codicon-cloud-upload" aria-hidden="true"></span>Upload Files</button>
          <button type="button" id="upload-folder"><span class="codicon codicon-folder-opened" aria-hidden="true"></span>Upload Folder</button>
          <button type="button" id="download" class="secondary"><span class="codicon codicon-cloud-download" aria-hidden="true"></span>Download</button>
          <button type="button" id="more" class="icon-button" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded="false"><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>
        </div>
      </section>
      <section id="list" class="file-list" role="treegrid" aria-label="Remote directory entries" tabindex="0">
        ${headers('remote')}
        <div id="rows" class="drop-current-directory"></div>
        <div id="empty" class="empty-state" hidden><span class="codicon codicon-folder" aria-hidden="true"></span><strong>This folder is empty</strong><span>Create a file or upload something from your workspace.</span></div>
        <div id="error" class="empty-state error-state" role="alert" hidden><span class="codicon codicon-error" aria-hidden="true"></span><strong>Remote files are unavailable</strong><span id="error-message"></span></div>
      </section>
    </section>
  </div>
  <div id="columns-menu" class="columns-menu" role="menu" aria-label="Visible columns" hidden>
    <label><input type="checkbox" data-column-toggle="name" checked disabled><span>Name</span></label>
    <label><input type="checkbox" data-column-toggle="type"><span>Type</span></label>
    <label><input type="checkbox" data-column-toggle="size"><span>Size</span></label>
    <label><input type="checkbox" data-column-toggle="mtime"><span>Modified</span></label>
    <label><input type="checkbox" data-column-toggle="path"><span>Path</span></label>
  </div>
  <div id="menu" role="menu" hidden><button type="button" role="menuitem" data-menu="copy" class="ghost"><span class="codicon codicon-copy" aria-hidden="true"></span>Copy Path</button><button type="button" role="menuitem" data-menu="rename" class="ghost"><span class="codicon codicon-edit" aria-hidden="true"></span>Rename</button><button type="button" role="menuitem" data-menu="delete" class="ghost danger"><span class="codicon codicon-trash" aria-hidden="true"></span><span class="menu-label">Delete</span></button></div>
</main>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function appendHistory(history: readonly string[], path: string): readonly string[] {
  if (history.at(-1) === path) return history;
  return [...history, path].slice(-MAX_HISTORY_ENTRIES);
}

function appendWorkspaceHistory(
  history: readonly WorkspaceLocation[],
  location: WorkspaceLocation,
): WorkspaceLocation[] {
  if (history.at(-1) === location) return [...history];
  return [...history, location].slice(-MAX_HISTORY_ENTRIES);
}

function resolveRemoteInput(value: string, currentPath: string): string {
  const trimmed = value.trim();
  return normalizeRemotePath(trimmed.startsWith('/') ? trimmed : posix.join(currentPath, trimmed));
}

function sortWorkspaceEntries(
  entries: readonly WorkspaceEntryView[],
  sort: SftpPanelState['sort'],
): readonly WorkspaceEntryView[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const group = workspaceKindGroup(left.entry) - workspaceKindGroup(right.entry);
      if (group !== 0) return group;
      let compared = 0;
      if (sort.key === 'name') {
        compared = left.entry.name.localeCompare(right.entry.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      } else if (sort.key === 'size') {
        compared = (left.entry.size ?? -1) - (right.entry.size ?? -1);
      } else {
        compared = (left.entry.mtimeMs ?? -1) - (right.entry.mtimeMs ?? -1);
      }
      if (compared !== 0) return compared * direction;
      const name = left.entry.name.localeCompare(right.entry.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      return name !== 0 ? name : left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function workspaceKindGroup(entry: WorkspaceEntryView): number {
  if (entry.kind === 'directory') return 0;
  if (entry.kind === 'file') return 1;
  if (entry.kind === 'symbolicLink') return 2;
  return 3;
}

function normalizedDefaultPath(path: string): string {
  try {
    return normalizeRemotePath(path);
  } catch {
    return '/';
  }
}

function requestIdOf(value: unknown): string {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as { requestId?: unknown }).requestId === 'string'
    ? (value as { requestId: string }).requestId.slice(0, 80)
    : 'invalid';
}

class PanelCancellation implements CancellationTokenLike {
  private cancelled = false;
  private readonly listeners = new Set<() => unknown>();

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  readonly onCancellationRequested = (listener: () => unknown): { dispose(): void } => {
    if (this.cancelled) {
      listener();
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}
