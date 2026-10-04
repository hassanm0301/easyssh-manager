import { describe, expect, it, vi } from 'vitest';

import { RemoteResourceCache } from '../../sftp/RemoteResourceCache';
import { SftpBrowserService, sortEntries } from '../../sftp/SftpBrowserService';
import type { SftpClient, SftpConnectionPool } from '../../sftp/ports';
import { validateSftpPanelState, validateSftpRequest } from '../../sftp/browser/contracts';
import { sftpPanelHtml } from '../../views/sftp/SftpPanel';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function client(): SftpClient {
  return {
    lstat: vi.fn(async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 })),
    stat: vi.fn(async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 })),
    realpath: vi.fn(async (path: string) => path),
    readlink: vi.fn(async () => 'target'),
    readDirectory: vi.fn(async () => [
      { name: 'z.txt', stat: { kind: 'file' as const, size: 1, mtimeMs: 3 } },
      { name: 'a-dir', stat: { kind: 'directory' as const, size: 0, mtimeMs: 2 } },
      { name: 'link', stat: { kind: 'symbolicLink' as const, size: 0, mtimeMs: 1 } },
    ]),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('SFTP browser protocol boundary', () => {
  it('accepts only exact bounded schemas and normalizes untrusted paths', () => {
    expect(
      validateSftpRequest({
        requestId: 'a_1',
        type: 'createFile',
        parentPath: '/one/../two',
        name: 'x',
      }),
    ).toEqual({ requestId: 'a_1', type: 'createFile', parentPath: '/two', name: 'x' });
    expect(() =>
      validateSftpRequest({
        requestId: '1',
        type: 'list',
        path: '/',
        force: true,
        connectionId: CONNECTION_ID,
      }),
    ).toThrow('Invalid SFTP browser request');
    expect(() => validateSftpRequest({ requestId: '1', type: 'download', paths: [] })).toThrow(
      'Invalid SFTP browser request',
    );
    expect(() =>
      validateSftpRequest({
        requestId: '1',
        type: 'createDirectory',
        parentPath: '/',
        name: '../escape',
      }),
    ).toThrow('safe path segment');
    expect(() => validateSftpRequest(Object.create({ requestId: '1', type: 'back' }))).toThrow(
      'Invalid SFTP browser request',
    );
  });

  it('restores only versioned secret-free state and removes bad history entries', () => {
    const restored = validateSftpPanelState({
      version: 1,
      connectionId: CONNECTION_ID,
      currentPath: '/root/../safe',
      historyBack: ['/', '/one', '../../escape', '/one'],
      historyForward: ['/next'],
      sort: { key: 'mtime', direction: 'desc' },
    });
    expect(restored).toEqual({
      version: 1,
      connectionId: CONNECTION_ID,
      currentPath: '/safe',
      historyBack: ['/', '/one'],
      historyForward: ['/next'],
      sort: { key: 'mtime', direction: 'desc' },
    });
    expect(() => validateSftpPanelState({ ...restored, password: 'secret' })).toThrow(
      'Invalid saved SFTP panel state',
    );
  });

  it('uses one-directory listings and stable directories-first sorting', async () => {
    const remote = client();
    const release = vi.fn(async () => undefined);
    const pool = {
      acquire: vi.fn(async () => ({
        connectionId: CONNECTION_ID,
        client: remote,
        touch: () => undefined,
        [Symbol.asyncDispose]: release,
      })),
    } as unknown as SftpConnectionPool;
    const browser = new SftpBrowserService(pool, new RemoteResourceCache({} as never));
    const result = await browser.list(CONNECTION_ID, '/', {
      force: true,
      sort: 'name',
      direction: 'asc',
    });
    expect(remote.readDirectory).toHaveBeenCalledTimes(1);
    expect(result.entries.map((entry) => entry.name)).toEqual(['a-dir', 'z.txt', 'link']);
    expect(release).toHaveBeenCalledOnce();
    expect(
      sortEntries(
        [
          { name: 'b', path: '/b', kind: 'file', size: 1, mtimeMs: 1 },
          { name: 'a', path: '/a', kind: 'file', size: 1, mtimeMs: 1 },
        ],
        'name',
        'asc',
      ).map((entry) => entry.name),
    ).toEqual(['a', 'b']);
  });
});

describe('SFTP browser webview security', () => {
  it('uses only packaged local sources and a nonce-restricted CSP', () => {
    const Uri = {
      joinPath: (_base: unknown, ...segments: string[]) => ({ path: `/${segments.join('/')}` }),
    };
    const webview = {
      cspSource: 'vscode-webview-resource:',
      asWebviewUri: (uri: { path: string }) => `vscode-webview-resource:${uri.path}`,
    };
    const html = sftpPanelHtml(webview as never, { Uri } as never, {} as never, 'nonce-value');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-nonce-value'");
    expect(html).toContain('style-src vscode-webview-resource:');
    expect(html).not.toContain('unsafe-eval');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('onclick=');
    expect(html).toContain('sftp-browser.js');
  });
});
