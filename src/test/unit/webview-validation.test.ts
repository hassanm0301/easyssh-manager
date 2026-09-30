import { describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';

vi.mock('vscode', () => ({ ViewColumn: { One: 1 } }));

import {
  ConnectionEditor,
  editorHtml,
  validateEditorInput,
  validateEditorMessage,
} from '../../views/connections/ConnectionEditor';
import { validateImportMessage } from '../../views/connections/ImportPreview';
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
    const html = editorHtml(
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
    expect(html).toContain(
      "default-src 'none'; style-src 'nonce-fixed-nonce'; script-src 'nonce-fixed-nonce'",
    );
    expect(html).toContain('hasStoredPassword');
    expect(html).not.toContain('SENTINEL_PASSWORD');
    expect(html).toContain('beforeunload');
    expect(html).toContain('[hidden]{display:none!important}');
    expect(html).toContain('input[type=checkbox]{display:inline;width:auto}');
    expect(html).toContain('var(--vscode-input-background)');
    const script = /<script nonce="fixed-nonce">([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    if (script === undefined) throw new Error('Editor script was not generated.');
    expect(() => new Script(script)).not.toThrow();
  });

  it('does not clear an obsolete secret before metadata validation succeeds', async () => {
    let receive!: (message: unknown) => Promise<void>;
    const panel = {
      webview: {
        html: '',
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
      } as never,
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
});
