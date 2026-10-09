import { describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';

vi.mock('vscode', () => ({ ViewColumn: { One: 1 } }));

import {
  ConnectionEditor,
  editorHtml,
  validateEditorInput,
  validateEditorMessage,
} from '../../views/connections/ConnectionEditor';
import { importPreviewHtml, validateImportMessage } from '../../views/connections/ImportPreview';
import { defaultAgentAccessPolicy } from '../../connections/types';

const baseInput = {
  name: 'server',
  folderId: null,
  host: '2001:db8::1',
  port: 22,
  username: 'user',
  defaultRemotePath: '/',
  authentication: { type: 'agent' },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
};

describe('connection editor runtime validation', () => {
  it('accepts IPv6-shaped form data and rejects mass-assignment fields', () => {
    expect(validateEditorInput(baseInput)).toMatchObject({ host: '2001:db8::1', port: 22 });
    expect(() => validateEditorInput({ ...baseInput, createdAt: 0 })).toThrow(
      'Unsupported connection form field',
    );
  });

  it('validates per-profile keepalive retry overrides', () => {
    expect(
      validateEditorInput({ ...baseInput, options: { keepAliveCountMax: 2 } }).options,
    ).toEqual({ keepAliveCountMax: 2 });
    expect(() => validateEditorInput({ ...baseInput, options: { keepAliveCountMax: 0 } })).toThrow(
      'Keepalive retry count must be between 1 and 20',
    );
  });

  it('requires exact correlated operations and non-empty replacement secrets', () => {
    expect(() =>
      validateEditorMessage({
        requestId: '1',
        type: 'save',
        value: baseInput,
        password: { action: 'keep', value: 'smuggled' },
        passphrase: { action: 'keep' },
      }),
    ).toThrow('Invalid credential operation');
    expect(() => validateEditorMessage({ requestId: '1', type: 'test', privileged: true })).toThrow(
      'Invalid editor operation',
    );
  });

  it('renders a nonce-only CSP without serializing secret values', () => {
    const api = {
      Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ path: `/${parts.join('/')}` }) },
    };
    const webview = {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: (uri: { path: string }) => `vscode-webview-resource:${uri.path}`,
    };
    const html = editorHtml(
      webview as never,
      api as never,
      {} as never,
      'fixed-nonce',
      {
        id: 'connection',
        ...baseInput,
        authentication: { type: 'password', hasStoredPassword: true },
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      [],
    );
    expect(html).toContain("default-src 'none'; style-src vscode-webview-resource:");
    expect(html).toContain('font-src vscode-webview-resource:');
    expect(html).toContain("script-src 'nonce-fixed-nonce'");
    expect(html).toContain('hasStoredPassword');
    expect(html).not.toContain('SENTINEL_PASSWORD');
    expect(html).toContain('beforeunload');
    expect(html).toContain('webview-theme.css');
    expect(html).toContain('connection-editor-style.css');
    expect(html).toContain('convenience classifier, not a security boundary');
    expect(html).toContain('Never ask before authorized operations');
    expect(html).toContain('class="surface-card form-card"');
    expect(html).not.toContain('<style');
    const script = /<script nonce="fixed-nonce">([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    if (script === undefined) throw new Error('Editor script was not generated.');
    expect(() => new Script(script)).not.toThrow();
  });

  it('shows a private-key example using the host platform path syntax', () => {
    const api = {
      Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ path: `/${parts.join('/')}` }) },
    };
    const webview = {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: (uri: { path: string }) => `vscode-webview-resource:${uri.path}`,
    };
    const render = (platform: NodeJS.Platform) =>
      editorHtml(
        webview as never,
        api as never,
        {} as never,
        'nonce',
        undefined,
        [],
        null,
        platform,
      );

    expect(render('win32')).toContain('placeholder="C:\\Users\\user\\.ssh\\id_ed25519"');
    expect(render('linux')).toContain('placeholder="/home/user/.ssh/id_ed25519"');
  });

  it('does not clear an obsolete secret before metadata validation succeeds', async () => {
    let receive!: (message: unknown) => Promise<void>;
    const panel = {
      webview: {
        html: '',
        cspSource: 'vscode-webview-resource:',
        asWebviewUri: (uri: { path: string }) => `vscode-webview-resource:${uri.path}`,
        onDidReceiveMessage: (listener: (message: unknown) => Promise<void>) => {
          receive = listener;
          return { dispose: () => undefined };
        },
        postMessage: vi.fn(async () => true),
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    };
    const changeCredential = vi.fn(async () => undefined);
    const editor = new ConnectionEditor(
      {
        window: { createWebviewPanel: () => panel },
        ViewColumn: { One: 1 },
        Uri: {
          joinPath: (_base: unknown, ...parts: string[]) => ({ path: `/${parts.join('/')}` }),
        },
      } as never,
      {} as never,
      {
        editConnection: vi.fn(async () => {
          throw new Error('metadata rejected');
        }),
        changeCredential,
      } as never,
    );
    editor.open({
      id: 'connection',
      ...baseInput,
      authentication: { type: 'password', hasStoredPassword: true },
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await receive({
      requestId: '1',
      type: 'save',
      value: baseInput,
      password: { action: 'clear' },
      passphrase: { action: 'keep' },
    });
    expect(changeCredential).not.toHaveBeenCalled();
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      requestId: '1',
      ok: false,
      error: 'Unable to save connection.',
    });
  });
});

describe('import preview runtime validation', () => {
  const candidate = {
    candidateId: 'candidate',
    sourcePath: '/home/user/.ssh/config',
    hostPattern: 'server',
    name: 'server',
    host: 'server.local',
    port: 22,
    username: 'user',
    identityFiles: ['/home/user/.ssh/id_ed25519'],
    selectedIdentityFile: '/home/user/.ssh/id_ed25519',
    selectedAuthentication: 'privateKey' as const,
    blockingIssues: [],
    warnings: [],
  };

  it('accepts only importable ids, existing folders, and resolved keys', () => {
    expect(
      validateImportMessage(
        {
          requestId: '1',
          type: 'import',
          selections: [
            {
              candidateId: 'candidate',
              name: 'renamed',
              folderId: null,
              authentication: 'privateKey',
              selectedIdentityFile: '/home/user/.ssh/id_ed25519',
            },
          ],
        },
        [candidate],
        [],
      ),
    ).toEqual([
      {
        candidateId: 'candidate',
        name: 'renamed',
        folderId: null,
        authentication: 'privateKey',
        selectedIdentityFile: '/home/user/.ssh/id_ed25519',
      },
    ]);
    expect(() =>
      validateImportMessage(
        {
          requestId: '1',
          type: 'import',
          selections: [
            {
              candidateId: 'candidate',
              name: 'server',
              folderId: null,
              authentication: 'privateKey',
              selectedIdentityFile: '/tmp/untrusted',
            },
          ],
        },
        [candidate],
        [],
      ),
    ).toThrow('Select one of the resolved identity files');
  });

  it('renders packaged styles and accessible import state without remote sources', () => {
    const api = {
      Uri: { joinPath: (_base: unknown, ...parts: string[]) => ({ path: `/${parts.join('/')}` }) },
    };
    const webview = {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: (uri: { path: string }) => `vscode-webview-resource:${uri.path}`,
    };
    const html = importPreviewHtml(
      webview as never,
      api as never,
      {} as never,
      'fixed-nonce',
      [candidate],
      [],
    );
    expect(html).toContain('webview-theme.css');
    expect(html).toContain('import-preview-style.css');
    expect(html).toContain('id="selection-count"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    const script = /<script nonce="fixed-nonce">([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    if (script === undefined) throw new Error('Import script was not generated.');
    expect(() => new Script(script)).not.toThrow();
  });
});
