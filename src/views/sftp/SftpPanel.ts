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
import type { CancellationTokenLike } from '../../ssh/ports';
import {
  MAX_HISTORY_ENTRIES,
  SFTP_PANEL_STATE_VERSION,
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
  readonly breadcrumbs: readonly { readonly name: string; readonly path: string }[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
  readonly sort: SftpPanelState['sort'];
  readonly connection: { readonly state: PanelConnectionState; readonly text: string };
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
      return;
    }
    const panel = this.dependencies.vscodeApi.window.createWebviewPanel(
      'easysshManager.sftpBrowser',
      `SFTP: ${connection.name}`,
      this.dependencies.vscodeApi.ViewColumn.Active,
      webviewOptions(this.dependencies.vscodeApi, this.dependencies.extensionUri),
    );
    this.attach(panel, connection);
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

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connection: Readonly<RemoteConnection>,
    private readonly dependencies: SftpPanelDependencies,
    restored: SftpPanelState | undefined,
    private readonly onDispose: () => void,
  ) {
    this.state = restored ?? {
      version: SFTP_PANEL_STATE_VERSION,
      connectionId: connection.id,
      currentPath: normalizedDefaultPath(connection.defaultRemotePath),
      historyBack: [],
      historyForward: [],
      sort: { key: 'name', direction: 'asc' },
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
    );
  }

  start(): void {
    void this.load(this.state.currentPath, true, false).catch(() => undefined);
  }

  reveal(): void {
    this.panel.reveal(this.dependencies.vscodeApi.ViewColumn.Active, false);
  }

  updateTitle(name: string): void {
    this.panel.title = `SFTP: ${name}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const controller of this.pendingControllers) controller.cancel();
    this.pendingControllers.clear();
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
      case 'list':
        if (this.connectionState === 'disconnected' || this.connectionState === 'error') {
          await this.dependencies.pool.invalidate(this.connection.id, 'user requested reconnect');
        }
        return this.load(request.path, request.force, false);
      case 'navigate':
        return this.load(request.path, false, true);
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
      this.render();
      return this.viewModel();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return { stale: true };
      const safe = sanitizeSftpError(error);
      this.connectionState =
        safe.code === 'CONNECTION_LOST' || safe.code === 'NETWORK' ? 'disconnected' : 'error';
      this.connectionText =
        this.connectionState === 'disconnected'
          ? 'Disconnected — reconnect to continue'
          : safe.message;
      this.render();
      throw error;
    } finally {
      this.pendingControllers.delete(cancellation);
      this.pending = Math.max(0, this.pending - 1);
    }
  }

  private async withClient<T>(
    operation: (client: import('../../sftp/ports').SftpClient) => Promise<T>,
  ): Promise<T> {
    const lease = await this.dependencies.pool.acquire(this.connection.id);
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
      breadcrumbs: breadcrumbs(this.state.currentPath),
      canGoBack: this.state.historyBack.length > 0,
      canGoForward: this.state.historyForward.length > 0,
      canGoUp: this.state.currentPath !== '/',
      sort: this.state.sort,
      connection: { state: this.connectionState, text: this.connectionText },
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
}

function webviewOptions(
  api: typeof vscode,
  extensionUri: vscode.Uri,
): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: false,
    localResourceRoots: [api.Uri.joinPath(extensionUri, 'dist', 'webview')],
  };
}

export function sftpPanelHtml(
  webview: vscode.Webview,
  api: typeof vscode,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const script = webview.asWebviewUri(
    api.Uri.joinPath(extensionUri, 'dist', 'webview', 'sftp-browser.js'),
  );
  const style = webview.asWebviewUri(
    api.Uri.joinPath(extensionUri, 'dist', 'webview', 'sftp-browser-style.css'),
  );
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${style}"></head><body>
<main id="sftp-browser" aria-label="Remote SFTP browser"><section class="toolbar" aria-label="SFTP browser toolbar">
<button type="button" id="back" title="Back">Back</button><button type="button" id="forward" title="Forward">Forward</button><button type="button" id="up" title="Up one folder">Up</button><button type="button" id="refresh" title="Refresh remote directory">Refresh</button><button type="button" id="new-file">New File</button><button type="button" id="new-folder">New Folder</button><button type="button" id="download">Download</button><button type="button" id="more" aria-haspopup="menu" aria-expanded="false">More actions</button>
</section><nav id="breadcrumbs" aria-label="Remote path"></nav><p id="status" role="status" aria-live="polite"><span aria-hidden="true">○</span> Connecting</p>
<div id="empty-actions" class="toolbar"><button type="button" id="upload-files">Upload Files</button><button type="button" id="upload-folder">Upload Folder</button></div>
<section id="list" role="listbox" aria-label="Remote directory entries" tabindex="0"><div class="headers" role="presentation"><button type="button" data-sort="name">Name</button><button type="button" data-sort="size">Size</button><button type="button" data-sort="mtime">Modified</button></div><div id="rows"></div><p id="empty" hidden>No remote items in this directory.</p><p id="error" hidden></p></section>
<div id="menu" role="menu" hidden><button type="button" role="menuitem" data-menu="copy">Copy Path</button><button type="button" role="menuitem" data-menu="rename">Rename</button><button type="button" role="menuitem" data-menu="delete">Delete</button></div></main>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}

function appendHistory(history: readonly string[], path: string): readonly string[] {
  if (history.at(-1) === path) return history;
  return [...history, path].slice(-MAX_HISTORY_ENTRIES);
}

function breadcrumbs(path: string): readonly { readonly name: string; readonly path: string }[] {
  const result: { name: string; path: string }[] = [{ name: '/', path: '/' }];
  const segments = path.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = `${current}/${segment}`;
    result.push({ name: segment, path: current });
  }
  return result;
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
