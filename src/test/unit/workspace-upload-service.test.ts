import { describe, expect, it, vi } from 'vitest';
import { posix } from 'node:path';

import { EasySshError } from '../../common/errors';
import { RemoteResourceCache } from '../../sftp/RemoteResourceCache';
import type { RemoteStat, SftpClient, SftpConnectionPool, SftpUriCodec } from '../../sftp/ports';
import {
  WorkspacePaneService,
  WorkspaceUploadService,
  validateWorkspaceDragPayload,
} from '../../sftp/WorkspaceUploadService';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

interface TestUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;
  toString(): string;
  with(change: { path?: string; query?: string; fragment?: string }): TestUri;
}

function uri(path: string, scheme = 'mem', authority = '', query = '', fragment = ''): TestUri {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return {
    scheme,
    authority,
    path: normalized,
    query,
    fragment,
    fsPath: scheme === 'file' ? normalized : '',
    toString: () =>
      `${scheme}://${authority}${normalized}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`,
    with: (change) =>
      uri(
        change.path ?? normalized,
        scheme,
        authority,
        change.query ?? query,
        change.fragment ?? fragment,
      ),
  };
}

function parse(value: string): TestUri {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
    value,
  );
  if (!match?.[1] || match[2] === undefined || !match[3]) throw new Error('invalid URI');
  return uri(match[3], match[1], match[2], match[4] ?? '', match[5] ?? '');
}

class MemoryWorkspace {
  trusted = true;
  readonly stats = new Map<string, { type: number; size: number }>();
  readonly children = new Map<string, [string, number][]>();
  readonly bytes = new Map<string, Uint8Array>();
  readonly onRoots = new Set<() => void>();
  readonly onTrust = new Set<() => void>();
  readonly FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  roots = [{ name: 'first', uri: uri('/workspace') }];

  putDirectory(path: string, children: [string, number][] = []): void {
    this.stats.set(uri(path).toString(), { type: this.FileType.Directory, size: 0 });
    this.children.set(uri(path).toString(), children);
  }

  putFile(path: string, data: string, type = this.FileType.File): void {
    const bytes = Buffer.from(data);
    this.stats.set(uri(path).toString(), { type, size: bytes.length });
    this.bytes.set(uri(path).toString(), bytes);
  }

  host() {
    const roots = () => this.roots;
    const trusted = () => this.trusted;
    const stat = (target: TestUri) => this.stats.get(target.toString());
    const children = (target: TestUri) => this.children.get(target.toString()) ?? [];
    const bytes = (target: TestUri) => this.bytes.get(target.toString());
    const addRootListener = (listener: () => void) => this.onRoots.add(listener);
    const removeRootListener = (listener: () => void) => this.onRoots.delete(listener);
    const addTrustListener = (listener: () => void) => this.onTrust.add(listener);
    const removeTrustListener = (listener: () => void) => this.onTrust.delete(listener);
    return {
      FileType: this.FileType,
      ProgressLocation: { Notification: 15 },
      Uri: {
        parse: (value: string) => parse(value),
        file: (value: string) => uri(value, 'file'),
        joinPath: (base: TestUri, ...segments: string[]) =>
          uri(
            posix.normalize(`${base.path.replace(/\/$/, '')}/${segments.join('/')}`),
            base.scheme,
            base.authority,
            base.query,
            base.fragment,
          ),
      },
      workspace: {
        get workspaceFolders() {
          return roots();
        },
        get isTrusted() {
          return trusted();
        },
        fs: {
          stat: vi.fn(async (target: TestUri) => {
            const value = stat(target);
            if (!value) throw new Error('not found');
            return { ...value, ctime: 0, mtime: 0 };
          }),
          readDirectory: vi.fn(async (target: TestUri) => children(target)),
          readFile: vi.fn(async (target: TestUri) => {
            const data = bytes(target);
            if (!data) throw new Error('not found');
            return data;
          }),
        },
        onDidChangeWorkspaceFolders: (listener: () => void) => {
          addRootListener(listener);
          return { dispose: () => removeRootListener(listener) };
        },
        onDidGrantWorkspaceTrust: (listener: () => void) => {
          addTrustListener(listener);
          return { dispose: () => removeTrustListener(listener) };
        },
      },
      window: {
        showOpenDialog: vi.fn(),
        showWarningMessage: vi.fn(async () => 'Overwrite'),
        withProgress: vi.fn(async (_options, task) =>
          task(
            { report: () => undefined },
            {
              isCancellationRequested: false,
              onCancellationRequested: () => ({ dispose: () => undefined }),
            },
          ),
        ),
      },
    };
  }
}

class MemoryRemote implements SftpClient {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>(['/']);
  readonly calls: string[] = [];

  async lstat(path: string): Promise<RemoteStat> {
    this.calls.push(`lstat:${path}`);
    if (this.directories.has(path)) return { kind: 'directory', size: 0, mtimeMs: 1 };
    const file = this.files.get(path);
    if (file) return { kind: 'file', size: file.byteLength, mtimeMs: 1 };
    throw new EasySshError('NOT_FOUND', `${path} missing`);
  }
  stat(path: string): Promise<RemoteStat> {
    return this.lstat(path);
  }
  async realpath(path: string): Promise<string> {
    return path;
  }
  async readlink(): Promise<string> {
    return 'target';
  }
  async readDirectory(): Promise<[]> {
    return [];
  }
  async readFile(path: string): Promise<Uint8Array> {
    return this.files.get(path) ?? new Uint8Array();
  }
  async writeFile(path: string, data: Uint8Array, options: { overwrite: boolean }): Promise<void> {
    if (this.files.has(path) && !options.overwrite)
      throw new EasySshError('ALREADY_EXISTS', `${path} exists`);
    this.files.set(path, new Uint8Array(data));
  }
  async mkdir(path: string): Promise<void> {
    if (this.directories.has(path) || this.files.has(path))
      throw new EasySshError('ALREADY_EXISTS', `${path} exists`);
    this.directories.add(path);
  }
  async rename(source: string, target: string, overwrite: boolean): Promise<void> {
    if ((this.files.has(target) || this.directories.has(target)) && !overwrite) {
      throw new EasySshError('ALREADY_EXISTS', `${target} exists`);
    }
    const data = this.files.get(source);
    if (!data) throw new EasySshError('NOT_FOUND', `${source} missing`);
    this.files.delete(source);
    this.files.set(target, data);
  }
  async unlink(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new EasySshError('NOT_FOUND', `${path} missing`);
  }
  async rmdir(): Promise<void> {}
  async close(): Promise<void> {}
}

function uploadHarness(workspace: MemoryWorkspace, remote = new MemoryRemote()) {
  const codec: SftpUriCodec = {
    create: (connectionId, path) => uri(path, 'remote-sftp', connectionId) as never,
    parse: (value) => ({ connectionId: value.authority, remotePath: value.path }),
  };
  const pool = {
    acquire: vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      client: remote,
      touch: () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    })),
  } as unknown as SftpConnectionPool;
  const reporter = { emitMutationChanges: vi.fn() };
  const host = workspace.host();
  const service = new WorkspaceUploadService(
    host as never,
    pool,
    new RemoteResourceCache(codec),
    codec,
    reporter,
    { maxBufferedTransferMiB: () => 1 },
  );
  return { service, remote, reporter, host };
}

const neverCancelled = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

describe('workspace pane authorization', () => {
  it('issues only lazily listed roots and rejects prefix, query, encoded, and revoked URI attempts', async () => {
    const workspace = new MemoryWorkspace();
    workspace.roots = [
      { name: 'same', uri: uri('/workspace') },
      { name: 'same', uri: uri('/workspace-two') },
    ];
    workspace.putDirectory('/workspace', [['folder', workspace.FileType.Directory]]);
    workspace.putDirectory('/workspace/folder');
    workspace.putDirectory('/workspace-two');
    const host = workspace.host();
    const pane = new WorkspacePaneService(host as never);
    const view = pane.initialize();
    expect(view.roots.map((root) => root.name)).toEqual(['same', 'same']);
    expect(host.workspace.fs.readDirectory).not.toHaveBeenCalled();

    const entries = await pane.readChildren(view.roots[0]!.uri);
    expect(entries[0]).toMatchObject({ name: 'folder', kind: 'directory' });
    expect(() =>
      pane.authorizeDragPayload({ type: 'workspace-items', uris: ['mem:///workspaceish'] }),
    ).toThrow('not authorized');
    expect(() =>
      pane.authorizeDragPayload({
        type: 'workspace-items',
        uris: [`${view.roots[0]!.uri}?changed`],
      }),
    ).toThrow('not authorized');
    expect(() =>
      pane.authorizeDragPayload({ type: 'workspace-items', uris: ['mem:///workspace/%2Fescape'] }),
    ).toThrow('invalid');
    expect(() =>
      pane.authorizeDragPayload({
        type: 'workspace-items',
        uris: [entries[0]!.uri, entries[0]!.uri],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      pane.authorizeDragPayload({
        type: 'workspace-items',
        uris: [view.roots[0]!.uri, entries[0]!.uri],
      }),
    ).toThrow('descendants');

    pane.revokeAndRefresh();
    expect(() =>
      pane.authorizeDragPayload({ type: 'workspace-items', uris: [entries[0]!.uri] }),
    ).toThrow('not authorized');
  });

  it('renders and enforces the untrusted state without prompting for trust', () => {
    const workspace = new MemoryWorkspace();
    workspace.trusted = false;
    const pane = new WorkspacePaneService(workspace.host() as never);
    expect(pane.initialize()).toMatchObject({ state: 'untrusted', roots: [] });
    try {
      pane.authorizeDragPayload({ type: 'workspace-items', uris: ['mem:///workspace'] });
      throw new Error('Expected untrusted workspace rejection.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WORKSPACE_UNTRUSTED' });
    }
  });

  it('navigates to provider parents and resolves typed sibling paths without widening schemes', async () => {
    const workspace = new MemoryWorkspace();
    workspace.putDirectory('/', [
      ['workspace', workspace.FileType.Directory],
      ['sibling', workspace.FileType.Directory],
    ]);
    workspace.putDirectory('/workspace');
    workspace.putDirectory('/sibling', [['nested', workspace.FileType.Directory]]);
    workspace.putDirectory('/sibling/nested');
    const pane = new WorkspacePaneService(workspace.host() as never);
    const root = pane.initialize().roots[0]!;
    const parent = await pane.parent(root.uri);
    expect(parent).toBe('mem:///');
    const parentEntries = await pane.readChildren(parent);
    expect(parentEntries.map((entry) => entry.name)).toEqual(['sibling', 'workspace']);
    const siblingEntry = parentEntries.find((entry) => entry.name === 'sibling')!;
    await expect(
      pane.freshAuthorizedSources({ type: 'workspace-items', uris: [siblingEntry.uri] }),
    ).resolves.toHaveLength(1);
    const sibling = await pane.resolveTypedDirectory('../sibling', root.uri);
    expect(pane.displayPath(sibling)).toBe('mem:///sibling');
    expect((await pane.suggestDirectories('n', sibling))[0]).toMatchObject({
      label: 'nested',
      value: 'mem:///sibling/nested',
    });
    await expect(pane.resolveTypedDirectory('other://host/path', sibling)).rejects.toThrow(
      'unavailable filesystem provider',
    );
  });
});

describe('workspace upload planner and executor', () => {
  it('plans deep/empty folders iteratively, preserves hierarchy, skips links, and removes descendant roots', async () => {
    const workspace = new MemoryWorkspace();
    workspace.putDirectory('/workspace', [
      ['tree', workspace.FileType.Directory],
      ['linked', workspace.FileType.SymbolicLink],
    ]);
    workspace.putDirectory('/workspace/tree', [
      ['nested', workspace.FileType.Directory],
      ['empty', workspace.FileType.Directory],
    ]);
    workspace.putDirectory('/workspace/tree/nested', [['a.txt', workspace.FileType.File]]);
    workspace.putDirectory('/workspace/tree/empty');
    workspace.putFile('/workspace/tree/nested/a.txt', 'hello');
    workspace.putFile('/workspace/linked', '', workspace.FileType.SymbolicLink);
    const { service } = uploadHarness(workspace);
    const plan = await service.planWorkspaceItems({
      connectionId: CONNECTION_ID,
      sourceUris: [
        uri('/workspace/tree') as never,
        uri('/workspace/tree/nested/a.txt') as never,
        uri('/workspace/linked') as never,
      ],
      targetRemotePath: '/target',
      cancellation: neverCancelled,
    });
    expect(plan.roots).toHaveLength(1);
    expect(plan.entries.map((entry) => entry.targetPath)).toEqual([
      '/target/tree',
      '/target/tree/empty',
      '/target/tree/nested',
      '/target/tree/nested/a.txt',
    ]);
    expect(plan.skippedLinks).toEqual([
      { path: 'linked', reason: 'Symbolic links are not uploaded.' },
    ]);
    expect(plan.totalBytes).toBe(5);
  });

  it('creates empty directories atomically uploads virtual files, and emits exact target/parent changes', async () => {
    const workspace = new MemoryWorkspace();
    workspace.putDirectory('/workspace', [['folder', workspace.FileType.Directory]]);
    workspace.putDirectory('/workspace/folder', [
      ['empty', workspace.FileType.Directory],
      ['note.txt', workspace.FileType.File],
    ]);
    workspace.putDirectory('/workspace/folder/empty');
    workspace.putFile('/workspace/folder/note.txt', 'hello');
    const remote = new MemoryRemote();
    remote.directories.add('/target');
    const { service, reporter } = uploadHarness(workspace, remote);
    const summary = await service.uploadWorkspaceItems({
      connectionId: CONNECTION_ID,
      sourceUris: [uri('/workspace/folder') as never],
      targetRemotePath: '/target',
      cancellation: neverCancelled,
    });
    expect(summary).toMatchObject({
      uploaded: 1,
      createdDirectories: 2,
      failed: [],
      cancelled: false,
    });
    expect([...remote.directories]).toEqual(
      expect.arrayContaining(['/target/folder', '/target/folder/empty']),
    );
    expect(Buffer.from(remote.files.get('/target/folder/note.txt') ?? []).toString()).toBe('hello');
    expect(reporter.emitMutationChanges).toHaveBeenCalled();
  });

  it('uses operation-local Skip decisions and rejects oversized virtual sources before reading them', async () => {
    const workspace = new MemoryWorkspace();
    workspace.putDirectory('/workspace', [
      ['same.txt', workspace.FileType.File],
      ['large.bin', workspace.FileType.File],
    ]);
    workspace.putFile('/workspace/same.txt', 'new');
    workspace.putFile('/workspace/large.bin', 'x'.repeat(2 * 1024 * 1024));
    const remote = new MemoryRemote();
    remote.directories.add('/target');
    remote.files.set('/target/same.txt', Buffer.from('old'));
    const { service, host } = uploadHarness(workspace, remote);
    host.window.showWarningMessage.mockResolvedValueOnce('Skip');
    const summary = await service.uploadWorkspaceItems({
      connectionId: CONNECTION_ID,
      sourceUris: [uri('/workspace/same.txt') as never, uri('/workspace/large.bin') as never],
      targetRemotePath: '/target',
      cancellation: neverCancelled,
    });
    expect(summary.skipped).toContainEqual({
      path: 'same.txt',
      reason: 'Destination file was skipped.',
    });
    expect(summary.failed[0]?.reason).toContain('cannot be buffered');
    expect(remote.files.get('/target/same.txt')?.toString()).toBe('old');
    expect(host.workspace.fs.readFile).toHaveBeenCalledTimes(0);
  });

  it('plans a synthetic 10,000-entry directory without eager pane recursion or depth loss', async () => {
    const workspace = new MemoryWorkspace();
    const entries: [string, number][] = [];
    workspace.putDirectory('/workspace', [['bulk', workspace.FileType.Directory]]);
    for (let index = 0; index < 10_000; index += 1) {
      const name = `file-${index}.txt`;
      entries.push([name, workspace.FileType.File]);
      workspace.putFile(`/workspace/bulk/${name}`, 'x');
    }
    workspace.putDirectory('/workspace/bulk', entries);
    const host = workspace.host();
    const pane = new WorkspacePaneService(host as never);
    pane.initialize();
    expect(host.workspace.fs.readDirectory).not.toHaveBeenCalled();

    const { service } = uploadHarness(workspace);
    const plan = await service.planWorkspaceItems({
      connectionId: CONNECTION_ID,
      sourceUris: [uri('/workspace/bulk') as never],
      targetRemotePath: '/target',
      cancellation: neverCancelled,
    });
    expect(plan.totalFiles).toBe(10_000);
    expect(plan.entries).toHaveLength(10_001);
  });
});

describe('workspace drag contract', () => {
  it('accepts a typed payload and rejects mass-assignment-shaped messages', () => {
    expect(
      validateWorkspaceDragPayload({ type: 'workspace-items', uris: ['mem:///workspace/file'] }),
    ).toEqual({ type: 'workspace-items', uris: ['mem:///workspace/file'] });
    expect(() =>
      validateWorkspaceDragPayload({ type: 'workspace-items', uris: [], targetPath: '/' }),
    ).toThrow('Invalid');
  });
});
