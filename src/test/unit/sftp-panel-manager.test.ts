import { describe, expect, it, vi } from 'vitest';

import { SftpPanelManager } from '../../views/sftp/SftpPanel';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function connection(name = 'Server') {
  return {
    id: CONNECTION_ID,
    name,
    defaultRemotePath: '/',
  };
}

function panel() {
  let disposed: (() => void) | undefined;
  let receive: ((value: unknown) => Promise<void>) | undefined;
  const value = {
    title: '',
    webview: {
      html: '',
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: (uri: { path: string }) => `vscode-webview-resource:${uri.path}`,
      postMessage: vi.fn(async (message: unknown) => {
        void message;
        return true;
      }),
      onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
        receive = listener;
        return { dispose: () => undefined };
      },
    },
    onDidDispose: (listener: () => void) => {
      disposed = listener;
      return { dispose: () => undefined };
    },
    reveal: vi.fn(),
    dispose: vi.fn(() => disposed?.()),
  };
  return { value, receive: () => receive, dispose: () => disposed?.() };
}

function harness(found = connection()) {
  const created: ReturnType<typeof panel>[] = [];
  let serializer:
    | { deserializeWebviewPanel: (panel: unknown, state: unknown) => Promise<void> }
    | undefined;
  const api = {
    ViewColumn: { Active: 1 },
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ path: `/${parts.join('/')}` }) },
    window: {
      createWebviewPanel: vi.fn(() => {
        const next = panel();
        created.push(next);
        return next.value;
      }),
      registerWebviewPanelSerializer: vi.fn((_viewType, next) => {
        serializer = next;
        return { dispose: () => undefined };
      }),
      showErrorMessage: vi.fn(),
    },
  };
  const browser = {
    list: vi.fn(async (_id: string, path: string) => ({ path, entries: [] })),
    resolveExplicitLink: vi.fn(async (_id: string, path: string) => path),
  };
  const remoteKind = { value: 'directory' as 'file' | 'directory' };
  const pool = {
    acquire: vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      client: { lstat: vi.fn(async () => ({ kind: remoteKind.value })) },
      touch: () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    })),
  };
  const uploads = {
    onDidCommit: () => ({ dispose: () => undefined }),
    uploadWorkspaceItems: vi.fn(),
    chooseAndUpload: vi.fn(),
  };
  const manager = new SftpPanelManager({
    vscodeApi: api as never,
    extensionUri: {} as never,
    browser: browser as never,
    mutations: {} as never,
    downloads: {} as never,
    remoteFileOpener: {} as never,
    codec: {} as never,
    pool: pool as never,
    uploads: uploads as never,
    createWorkspacePane: () =>
      ({
        initialize: () => ({ generation: 0, state: 'noWorkspace', roots: [] }),
        onDidChange: () => ({ dispose: () => undefined }),
        dispose: () => undefined,
        readChildren: vi.fn(),
        freshAuthorizedSources: vi.fn(async () => [{ path: '/source' }]),
      }) as never,
    resolveConnection: vi.fn(async () => found as never),
  });
  return {
    manager,
    api,
    browser,
    created,
    uploads,
    remoteKind,
    serializer: () => serializer,
  };
}

describe('SFTP panel manager lifecycle', () => {
  it('creates only one panel per host-resolved connection and updates its title', async () => {
    const { manager, api, created } = harness();
    await manager.open(CONNECTION_ID);
    await manager.open(CONNECTION_ID);
    expect(api.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(created[0]?.value.reveal).toHaveBeenCalledOnce();
    expect(created[0]?.value.title).toBe('SFTP: Server');
    manager.updateConnections([connection('Renamed') as never]);
    expect(created[0]?.value.title).toBe('SFTP: Renamed');
    manager.updateConnections([]);
    expect(created[0]?.value.dispose).toHaveBeenCalledOnce();
  });

  it('drops deleted saved connections during restoration without retaining a panel', async () => {
    const { manager, api, serializer } = harness(null as never);
    manager.registerRestoration();
    const restored = panel();
    await serializer()?.deserializeWebviewPanel(restored.value, {
      version: 1,
      connectionId: CONNECTION_ID,
      currentPath: '/',
      historyBack: [],
      historyForward: [],
      sort: { key: 'name', direction: 'asc' },
    });
    expect(restored.value.dispose).toHaveBeenCalledOnce();
    expect(api.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('no longer exists'),
    );
  });

  it('settles stale list requests without allowing them to replace the latest directory', async () => {
    const { manager, browser, created } = harness();
    const completions = new Map<string, (value: { path: string; entries: never[] }) => void>();
    browser.list.mockImplementation(
      (_connectionId: string, path: string) =>
        new Promise((resolve) =>
          completions.set(path, resolve as (value: { path: string; entries: never[] }) => void),
        ),
    );
    await manager.open(CONNECTION_ID);
    const receive = created[0]?.receive();
    if (!receive) throw new Error('Panel did not register its message listener.');
    const first = receive({ requestId: 'first', type: 'navigate', path: '/first' });
    const second = receive({ requestId: 'second', type: 'navigate', path: '/second' });
    completions.get('/second')?.({ path: '/second', entries: [] });
    await second;
    completions.get('/first')?.({ path: '/first', entries: [] });
    completions.get('/')?.({ path: '/', entries: [] });
    await first;
    const renderedPaths = created[0]?.value.webview.postMessage.mock.calls
      .map(([message]) => message as { type: string; value: { path: string } })
      .filter((message) => message.type === 'render')
      .map((message) => message.value.path);
    expect(renderedPaths?.at(-1)).toBe('/second');
  });

  it('rechecks a dropped remote target and rejects it if it is not a directory', async () => {
    const { manager, created, uploads, remoteKind } = harness();
    remoteKind.value = 'file';
    await manager.open(CONNECTION_ID);
    const receive = created[0]?.receive();
    if (!receive) throw new Error('Panel did not register its message listener.');
    await receive({
      requestId: 'drop',
      type: 'workspaceDrop',
      targetPath: '/remote-file',
      payload: { type: 'workspace-items', uris: ['file:///workspace/source'] },
    });
    expect(uploads.uploadWorkspaceItems).not.toHaveBeenCalled();
    expect(created[0]?.value.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response',
        requestId: 'drop',
        ok: false,
        error: expect.objectContaining({
          message: 'Choose a remote directory as the upload target.',
        }),
      }),
    );
  });
});
