import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  emptyPersistedState,
  defaultAgentAccessPolicy,
  type RemoteConnection,
} from '../../connections/types';
import { EasySshError } from '../../common/errors';
import { McpAgentService } from '../../mcp/McpAgentService';

const connection = (id: string, enabled: boolean): RemoteConnection => ({
  id,
  name: 'Development',
  folderId: null,
  order: 0,
  host: 'host.invalid',
  port: 22,
  username: 'user',
  defaultRemotePath: '/',
  authentication: { type: 'agent' },
  agentAccess: { ...defaultAgentAccessPolicy(), enabled, allowExec: true },
  options: {},
  createdAt: 1,
  updatedAt: 1,
});

describe('MCP extension-host authority', () => {
  it('lists only enabled connections without authentication metadata', async () => {
    const state = emptyPersistedState();
    state.connections.push(connection('11111111-1111-4111-8111-111111111111', true));
    state.connections.push(connection('22222222-2222-4222-8222-222222222222', false));
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      {} as never,
      {} as never,
    );
    const listed = (await service.dispatch(
      'remote_list_connections',
      {},
      new AbortController().signal,
    )) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('authentication');
    expect(listed[0]).not.toHaveProperty('privateKeyPath');
  });

  it('rechecks disabled policy for every direct request', async () => {
    const state = emptyPersistedState();
    state.connections.push(connection('11111111-1111-4111-8111-111111111111', false));
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.dispatch(
        'ssh_exec',
        {
          connectionId: '11111111-1111-4111-8111-111111111111',
          command: 'whoami',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DISABLED' });
  });

  it('prompts for destructive command compositions and hides their raw text', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.confirmationMode = 'destructive';
    state.connections.push(enabled);
    const ssh = { connect: vi.fn() };
    const prompt = {
      showWarningMessage: vi.fn(
        async (message: string, options: { modal: true }, ...items: string[]) => {
          void message;
          void options;
          void items;
          return 'Deny';
        },
      ),
    };
    const service = new McpAgentService(
      { load: async () => state },
      ssh as never,
      {} as never,
      prompt,
    );
    await expect(
      service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'echo ok; rm -rf /tmp/demo' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_DENIED' });
    expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
    expect(prompt.showWarningMessage.mock.calls[0]?.[0]).not.toContain('rm -rf');
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it('serializes prompts and rechecks a queued call before opening its prompt', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const answers: Array<(value: string | undefined) => void> = [];
    const prompt = {
      showWarningMessage: vi.fn(
        () => new Promise<string | undefined>((resolve) => answers.push(resolve)),
      ),
    };
    let loads = 0;
    const service = new McpAgentService(
      {
        load: async () => {
          loads += 1;
          if (loads === 9) enabled.agentAccess.allowExec = false;
          return state;
        },
      },
      { connect: vi.fn() } as never,
      {} as never,
      prompt,
    );
    const first = service.dispatch(
      'ssh_exec',
      { connectionId: enabled.id, command: 'first-command' },
      new AbortController().signal,
    );
    const queued = service.dispatch(
      'ssh_exec',
      { connectionId: enabled.id, command: 'queued-command' },
      new AbortController().signal,
    );
    await flushMicrotasks();
    expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
    answers[0]?.('Deny');
    await expect(first).rejects.toMatchObject({ code: 'CONFIRMATION_DENIED' });
    await expect(queued).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
  });

  it('expires an unanswered confirmation after sixty seconds', async () => {
    vi.useFakeTimers();
    try {
      const state = emptyPersistedState();
      const enabled = connection('11111111-1111-4111-8111-111111111111', true);
      state.connections.push(enabled);
      const prompt = {
        showWarningMessage: vi.fn(() => new Promise<string | undefined>(() => undefined)),
      };
      const service = new McpAgentService(
        { load: async () => state },
        { connect: vi.fn() } as never,
        {} as never,
        prompt,
      );
      const pending = service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'wait-for-approval' },
        new AbortController().signal,
      );
      await flushMicrotasks();
      expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
      const expired = expect(pending).rejects.toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
      await vi.advanceTimersByTimeAsync(60_000);
      await expired;
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an open confirmation immediately when its connection is revoked', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const prompt = {
      showWarningMessage: vi.fn(() => new Promise<string | undefined>(() => undefined)),
    };
    const service = new McpAgentService(
      { load: async () => state },
      { connect: vi.fn() } as never,
      {} as never,
      prompt,
    );
    const pending = service.dispatch(
      'ssh_exec',
      { connectionId: enabled.id, command: 'wait-for-approval' },
      new AbortController().signal,
    );
    await flushMicrotasks();
    expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    service.revokeConnection(enabled.id);
    await cancelled;
  });

  it('treats a closed confirmation window as a denial', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const prompt = { showWarningMessage: vi.fn(async () => undefined) };
    const ssh = { connect: vi.fn() };
    const service = new McpAgentService(
      { load: async () => state },
      ssh as never,
      {} as never,
      prompt,
    );
    await expect(
      service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'do-not-run' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_DENIED' });
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  it('lets never-mode mutations skip prompts only while their write grant is enabled', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.confirmationMode = 'never';
    enabled.agentAccess.allowWriteFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const stat = { kind: 'directory' as const, size: 0, mtimeMs: 1 };
    const client = {
      lstat: async (path: string) => {
        if (path === '/app') return stat;
        throw new EasySshError('NOT_FOUND', 'Missing.');
      },
      realpath: async (path: string) => path,
      mkdir: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const acquire = vi.fn(async () => ({ client, [Symbol.asyncDispose]: async () => undefined }));
    const prompt = { showWarningMessage: vi.fn(async () => 'Approve') };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      { acquire } as never,
      prompt,
    );
    await expect(
      service.dispatch(
        'sftp_mkdir',
        { connectionId: enabled.id, path: '/app/new' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ created: true });
    expect(prompt.showWarningMessage).not.toHaveBeenCalled();
    enabled.agentAccess.allowWriteFiles = false;
    await expect(
      service.dispatch(
        'sftp_mkdir',
        { connectionId: enabled.id, path: '/app/other' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(client.mkdir).toHaveBeenCalledOnce();
  });

  it('re-resolves policy immediately before dispatch', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    let loads = 0;
    const reader = {
      load: async () => {
        loads += 1;
        if (loads === 3) enabled.agentAccess.enabled = false;
        return state;
      },
    };
    const service = new McpAgentService(reader, {} as never, {} as never, {} as never);
    await expect(
      service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'whoami' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DISABLED' });
  });

  it('uses segment containment for canonical SFTP roots', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const stat = { kind: 'directory' as const, size: 0, mtimeMs: 1 };
    const client = {
      realpath: async (path: string) => path,
      lstat: async () => stat,
      readDirectory: async () => [],
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      {} as never,
    );
    await expect(
      service.dispatch(
        'sftp_list',
        { connectionId: enabled.id, path: '/application' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(
      service.dispatch(
        'sftp_list',
        { connectionId: enabled.id, path: '/app' },
        new AbortController().signal,
      ),
    ).resolves.toEqual([]);
  });

  it('fails closed for dangling links and canonicalization errors on existing paths', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const client = {
      lstat: async (path: string) => {
        if (path === '/app') return { kind: 'directory' as const, size: 0, mtimeMs: 1 };
        if (path === '/app/dangling') return { kind: 'symbolicLink' as const, size: 0, mtimeMs: 1 };
        if (path === '/app/denied') return { kind: 'file' as const, size: 1, mtimeMs: 1 };
        throw new EasySshError('NOT_FOUND', 'Missing.');
      },
      realpath: async (path: string) => {
        if (path === '/app/dangling') throw new EasySshError('NOT_FOUND', 'Broken link.');
        if (path === '/app/denied')
          throw new EasySshError('PERMISSION_DENIED', 'Cannot canonicalize.');
        return path;
      },
      stat: async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 }),
      readFile: async () => Buffer.from('x'),
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      {} as never,
    );
    await expect(
      service.dispatch(
        'sftp_stat',
        { connectionId: enabled.id, path: '/app/dangling' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.dispatch(
        'sftp_stat',
        { connectionId: enabled.id, path: '/app/denied' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rejects external symlink targets and rechecks containment after confirmation', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowWriteFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    let linkTarget = '/app/inside';
    const linkStat = { kind: 'symbolicLink' as const, size: 6, mtimeMs: 1 };
    const client = {
      lstat: async (path: string) => {
        if (path === '/app') return { kind: 'directory' as const, size: 0, mtimeMs: 1 };
        if (path === '/app/escape' || path === '/app/link') return linkStat;
        throw new EasySshError('NOT_FOUND', 'Missing.');
      },
      realpath: async (path: string) => {
        if (path === '/app/escape') return '/outside/secret';
        if (path === '/app/link') return linkTarget;
        return path;
      },
      unlink: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const prompt = {
      showWarningMessage: vi.fn(async () => {
        linkTarget = '/outside/replaced';
        return 'Approve';
      }),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      prompt,
    );
    await expect(
      service.dispatch(
        'sftp_stat',
        { connectionId: enabled.id, path: '/app/escape' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(
      service.dispatch(
        'sftp_mkdir',
        { connectionId: enabled.id, path: '/app/escape/new' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    await expect(
      service.dispatch(
        'sftp_delete',
        { connectionId: enabled.id, path: '/app/link' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
    expect(client.unlink).not.toHaveBeenCalled();
    expect(client.mkdir).not.toHaveBeenCalled();
  });

  it('uses the shared bounded directory reader and rejects truncated listings', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const stat = { kind: 'directory' as const, size: 0, mtimeMs: 1 };
    const client = {
      lstat: async () => stat,
      realpath: async (path: string) => path,
      readDirectoryBounded: vi.fn(async (path: string, limit: number) => {
        expect(path).toBe('/app');
        expect(limit).toBe(10_000);
        return { entries: [], truncated: true };
      }),
      readDirectory: vi.fn(async () => {
        throw new Error('Unbounded listing must not be called.');
      }),
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      {} as never,
    );
    await expect(
      service.dispatch(
        'sftp_list',
        { connectionId: enabled.id, path: '/app' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(client.readDirectoryBounded).toHaveBeenCalledWith('/app', 10_000);
    expect(client.readDirectory).not.toHaveBeenCalled();
  });

  it('supports ranged reads and matching-version atomic overwrites', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowWriteFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const files = new Map<string, Buffer>([['/app/file.txt', Buffer.from('hello')]]);
    const stats = new Map<string, { kind: 'file'; size: number; mtimeMs: number }>([
      ['/app/file.txt', { kind: 'file', size: 5, mtimeMs: 1 }],
    ]);
    const client = {
      realpath: async (path: string) => path,
      lstat: async (path: string) => {
        const item = stats.get(path);
        if (!item) throw new EasySshError('NOT_FOUND', 'Missing.');
        return item;
      },
      stat: async (path: string) => {
        const item = stats.get(path);
        if (!item) throw new EasySshError('NOT_FOUND', 'Missing.');
        return item;
      },
      readFile: async (path: string, range?: { offset: number; length: number }) => {
        const data = files.get(path)!;
        return range ? data.subarray(range.offset, range.offset + range.length) : data;
      },
      writeFile: async (path: string, value: Uint8Array) => {
        files.set(path, Buffer.from(value));
        stats.set(path, { kind: 'file', size: value.byteLength, mtimeMs: 2 });
      },
      rename: async (source: string, destination: string) => {
        files.set(destination, files.get(source)!);
        stats.set(destination, { kind: 'file', size: files.get(source)!.length, mtimeMs: 2 });
        files.delete(source);
        stats.delete(source);
      },
      unlink: async (path: string) => {
        files.delete(path);
        stats.delete(path);
      },
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const window = { showWarningMessage: vi.fn(async () => 'Approve') };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      window,
    );
    const read = (await service.dispatch(
      'sftp_read',
      { connectionId: enabled.id, path: '/app/file.txt', encoding: 'utf8', offset: 1, length: 2 },
      new AbortController().signal,
    )) as { data: string; bytesRead: number; totalSize: number };
    expect(read).toMatchObject({ data: 'el', bytesRead: 2, totalSize: 5 });
    const current = (await service.dispatch(
      'sftp_stat',
      { connectionId: enabled.id, path: '/app/file.txt' },
      new AbortController().signal,
    )) as { version: string };
    await expect(
      service.dispatch(
        'sftp_write',
        {
          connectionId: enabled.id,
          path: '/app/file.txt',
          encoding: 'utf8',
          data: 'world',
          expectedVersion: current.version,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ written: 5, version: expect.any(String) });
    expect(files.get('/app/file.txt')?.toString()).toBe('world');
    await expect(
      service.dispatch(
        'sftp_write',
        {
          connectionId: enabled.id,
          path: '/app/file.txt',
          encoding: 'utf8',
          data: 'stale',
          expectedVersion: current.version,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect(files.get('/app/file.txt')?.toString()).toBe('world');
    await expect(
      service.dispatch(
        'sftp_write',
        {
          connectionId: enabled.id,
          path: '/app/file.txt',
          encoding: 'utf8',
          data: 'forced',
          force: true,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ written: 6, version: expect.any(String) });
    expect(window.showWarningMessage).toHaveBeenCalledTimes(3);
    expect(files.get('/app/file.txt')?.toString()).toBe('forced');
  });

  it('uses the canonical target version when writing through an allowed symlink', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowWriteFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const linkStat = { kind: 'symbolicLink' as const, size: 10, mtimeMs: 1 };
    const fileStat = { kind: 'file' as const, size: 5, mtimeMs: 1 };
    const stats = new Map<string, { kind: 'symbolicLink' | 'file'; size: number; mtimeMs: number }>(
      [
        ['/app/alias', linkStat],
        ['/app/target', fileStat],
      ],
    );
    const contents = new Map([['/app/target', Buffer.from('hello')]]);
    const client = {
      realpath: async (path: string) => (path === '/app/alias' ? '/app/target' : path),
      lstat: async (path: string) => {
        const value = stats.get(path);
        if (!value) throw new EasySshError('NOT_FOUND', 'Missing.');
        return value;
      },
      stat: async (path: string) => {
        const value = stats.get(path);
        if (!value) throw new EasySshError('NOT_FOUND', 'Missing.');
        return value;
      },
      writeFile: async (path: string, data: Uint8Array) => {
        contents.set(path, Buffer.from(data));
        stats.set(path, { kind: 'file', size: data.byteLength, mtimeMs: 2 });
      },
      rename: async (source: string, destination: string) => {
        contents.set(destination, contents.get(source)!);
        stats.set(destination, { kind: 'file', size: contents.get(source)!.length, mtimeMs: 2 });
        contents.delete(source);
        stats.delete(source);
      },
      unlink: async (path: string) => {
        contents.delete(path);
        stats.delete(path);
      },
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const service = new McpAgentService({ load: async () => state }, {} as never, pool as never, {
      showWarningMessage: async () => 'Approve',
    });
    const before = (await service.dispatch(
      'sftp_stat',
      { connectionId: enabled.id, path: '/app/alias' },
      new AbortController().signal,
    )) as { version: string; kind: string };
    expect(before.kind).toBe('symbolicLink');
    await expect(
      service.dispatch(
        'sftp_write',
        {
          connectionId: enabled.id,
          path: '/app/alias',
          encoding: 'utf8',
          data: 'world',
          expectedVersion: before.version,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ written: 5 });
    expect(contents.get('/app/target')?.toString()).toBe('world');
  });

  it('cancels active SFTP work when a connection grant is revoked', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowReadFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let rejectRead!: (error: Error) => void;
    const client = {
      realpath: async (path: string) => path,
      lstat: async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 }),
      stat: async () => ({ kind: 'file' as const, size: 1, mtimeMs: 1 }),
      readFile: async () => {
        started();
        return new Promise<Uint8Array>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
      close: async () => {
        rejectRead(new EasySshError('CANCELLED', 'SFTP call cancelled.'));
      },
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      {} as never,
    );
    const pending = service.dispatch(
      'sftp_read',
      { connectionId: enabled.id, path: '/app/file.txt', encoding: 'base64' },
      new AbortController().signal,
    );
    await operationStarted;
    service.revokeConnection(enabled.id);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('runs bounded non-PTY exec with safely quoted cwd after confirmation', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close(): void };
    channel.stderr = new EventEmitter();
    channel.close = () => channel.emit('close');
    const exec = vi.fn(async ({ command }: { command: string }) => {
      expect(command).toContain('child=$!');
      expect(command).toContain('set -m');
      expect(command).toContain('kill -TERM -- -"$child"');
      expect(command).toContain('/tmp/a');
      expect(command).toContain('&& printf hello');
      setTimeout(() => {
        channel.emit('data', Buffer.from('hello'));
        channel.stderr.emit('data', Buffer.from('warning'));
        channel.emit('exit', 0, null);
        channel.emit('close');
      }, 0);
      return { stream: channel };
    });
    const handle = { exec, [Symbol.asyncDispose]: async () => undefined };
    const ssh = {
      connect: vi.fn(async (connectionId: string, options: { kind: 'test'; scopeId: string }) => {
        expect(connectionId).toBe(enabled.id);
        expect(options).not.toHaveProperty('cancellation');
        return handle;
      }),
    };
    const prompt = {
      showWarningMessage: vi.fn(
        async (message: string, options: { modal: true }, ...items: string[]) => {
          void message;
          void options;
          void items;
          return 'Approve';
        },
      ),
    };
    const service = new McpAgentService(
      { load: async () => state },
      ssh as never,
      {} as never,
      prompt,
    );
    await expect(
      service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'printf hello', cwd: "/tmp/a'b" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      stdout: 'hello',
      stderr: 'warning',
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(prompt.showWarningMessage).toHaveBeenCalledOnce();
    expect(prompt.showWarningMessage.mock.calls[0]?.[0]).not.toContain('printf hello');
    expect(prompt.showWarningMessage.mock.calls[0]?.[0]).toContain('output limit 1 MiB per stream');
    expect(ssh.connect).toHaveBeenCalledWith(enabled.id, expect.objectContaining({ kind: 'test' }));
    expect(exec).toHaveBeenCalledOnce();
  });

  it('rejects exec output overflow without returning partial data', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close(): void };
    channel.stderr = new EventEmitter();
    channel.close = () => channel.emit('close');
    const ssh = {
      connect: async () => ({
        exec: async () => {
          setTimeout(() => channel.emit('data', Buffer.alloc(1024 * 1024 + 1)), 0);
          return { stream: channel };
        },
        [Symbol.asyncDispose]: async () => undefined,
      }),
    };
    const service = new McpAgentService({ load: async () => state }, ssh as never, {} as never, {
      showWarningMessage: async () => 'Approve',
    });
    await expect(
      service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'generate-output' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
  });

  it('terminates exec at its timeout and reports the timeout outcome', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const channel = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close(): void };
    channel.stderr = new EventEmitter();
    channel.close = () => channel.emit('close');
    const ssh = {
      connect: async () => ({
        exec: async () => ({ stream: channel }),
        [Symbol.asyncDispose]: async () => undefined,
      }),
    };
    const service = new McpAgentService({ load: async () => state }, ssh as never, {} as never, {
      showWarningMessage: async () => 'Approve',
    });
    await expect(
      service.dispatch(
        'ssh_exec',
        { connectionId: enabled.id, command: 'wait', timeoutMs: 5 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ timedOut: true, exitCode: null, stdout: '', stderr: '' });
  });

  it('signals the remote exec process before closing an aborted SSH channel', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const channel = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      close(): void;
      signal(name: string): void;
    };
    channel.stderr = new EventEmitter();
    channel.close = () => channel.emit('close');
    channel.signal = vi.fn((name: string) => {
      queueMicrotask(() => channel.emit('exit', null, name));
    });
    const ssh = {
      connect: async () => ({
        exec: async () => ({ stream: channel }),
        [Symbol.asyncDispose]: async () => undefined,
      }),
    };
    const service = new McpAgentService({ load: async () => state }, ssh as never, {} as never, {
      showWarningMessage: async () => 'Approve',
    });
    const controller = new AbortController();
    const pending = service.dispatch(
      'ssh_exec',
      { connectionId: enabled.id, command: 'wait-for-cancellation' },
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(channel.signal).toHaveBeenCalledWith('TERM');
  });

  it('revokes every active request during extension shutdown', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    state.connections.push(enabled);
    const channel = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      close(): void;
      signal(name: string): void;
    };
    channel.stderr = new EventEmitter();
    channel.close = () => channel.emit('close');
    channel.signal = vi.fn((name: string) => {
      queueMicrotask(() => channel.emit('exit', null, name));
    });
    const ssh = {
      connect: async () => ({
        exec: async () => ({ stream: channel }),
        [Symbol.asyncDispose]: async () => undefined,
      }),
    };
    const service = new McpAgentService({ load: async () => state }, ssh as never, {} as never, {
      showWarningMessage: async () => 'Approve',
    });
    const pending = service.dispatch(
      'ssh_exec',
      { connectionId: enabled.id, command: 'wait-for-extension-shutdown' },
      new AbortController().signal,
    );
    await flushMicrotasks();
    service.revokeAll();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(channel.signal).toHaveBeenCalledWith('TERM');
  });

  it('confirms and rechecks mkdir, no-overwrite rename, and file deletion', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowWriteFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const records = new Map<string, { kind: 'directory' | 'file'; size: number; mtimeMs: number }>([
      ['/app', { kind: 'directory', size: 0, mtimeMs: 1 }],
      ['/app/source', { kind: 'file', size: 1, mtimeMs: 1 }],
    ]);
    const missing = (): never => {
      throw new EasySshError('NOT_FOUND', 'Missing.');
    };
    const client = {
      realpath: async (path: string) => (records.has(path) ? path : missing()),
      lstat: async (path: string) => records.get(path) ?? missing(),
      mkdir: async (path: string) => {
        records.set(path, { kind: 'directory', size: 0, mtimeMs: 2 });
      },
      rename: async (source: string, target: string) => {
        const value = records.get(source) ?? missing();
        records.set(target, value);
        records.delete(source);
      },
      unlink: async (path: string) => {
        records.delete(path);
      },
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const prompt = {
      showWarningMessage: vi.fn(async (...args: [string, { modal: true }, ...string[]]) => {
        void args;
        return 'Approve';
      }),
    };
    const mutationCache = {
      invalidatePath: vi.fn(),
      invalidateParent: vi.fn(),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      prompt,
      undefined,
      mutationCache,
    );
    await expect(
      service.dispatch(
        'sftp_mkdir',
        { connectionId: enabled.id, path: '/app/folder' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ created: true });
    await expect(
      service.dispatch(
        'sftp_rename',
        { connectionId: enabled.id, source: '/app/source', destination: '/app/folder/moved' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ renamed: true });
    await expect(
      service.dispatch(
        'sftp_delete',
        { connectionId: enabled.id, path: '/app/folder/moved' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ deleted: true, count: 1 });
    expect(records.has('/app/folder/moved')).toBe(false);
    expect(prompt.showWarningMessage).toHaveBeenCalledTimes(3);
    expect(mutationCache.invalidatePath).toHaveBeenCalledWith(enabled.id, '/app/folder');
    expect(mutationCache.invalidatePath).toHaveBeenCalledWith(enabled.id, '/app/source');
    expect(mutationCache.invalidatePath).toHaveBeenCalledWith(enabled.id, '/app/folder/moved');
    expect(mutationCache.invalidateParent).toHaveBeenCalledWith(enabled.id, '/app/folder/moved');
  });

  it('recursively deletes in post-order without traversing symbolic links', async () => {
    const state = emptyPersistedState();
    const enabled = connection('11111111-1111-4111-8111-111111111111', true);
    enabled.agentAccess.allowWriteFiles = true;
    enabled.agentAccess.allowedRoots = ['/app'];
    state.connections.push(enabled);
    const records = new Map<
      string,
      { kind: 'directory' | 'file' | 'symbolicLink'; size: number; mtimeMs: number }
    >([
      ['/app', { kind: 'directory', size: 0, mtimeMs: 1 }],
      ['/app/tree', { kind: 'directory', size: 0, mtimeMs: 1 }],
      ['/app/tree/target', { kind: 'file', size: 1, mtimeMs: 1 }],
      ['/app/tree/link', { kind: 'symbolicLink', size: 6, mtimeMs: 1 }],
      ['/app/tree/note', { kind: 'file', size: 2, mtimeMs: 1 }],
    ]);
    const missing = (): never => {
      throw new EasySshError('NOT_FOUND', 'Missing.');
    };
    const visitedDirectories: string[] = [];
    const deleted: string[] = [];
    const client = {
      realpath: async (path: string) =>
        path === '/app/tree/link' ? '/app/tree/target' : records.has(path) ? path : missing(),
      lstat: async (path: string) => records.get(path) ?? missing(),
      readDirectory: async (path: string) => {
        visitedDirectories.push(path);
        return [
          { name: 'target', stat: records.get('/app/tree/target') },
          { name: 'link', stat: records.get('/app/tree/link') },
          { name: 'note', stat: records.get('/app/tree/note') },
        ];
      },
      unlink: async (path: string) => {
        deleted.push(path);
        records.delete(path);
      },
      rmdir: async (path: string) => {
        deleted.push(path);
        records.delete(path);
      },
      close: async () => undefined,
    };
    const pool = {
      acquire: async () => ({ client, [Symbol.asyncDispose]: async () => undefined }),
    };
    const prompt = {
      showWarningMessage: vi.fn(async (...args: [string, { modal: true }, ...string[]]) => {
        expect(args[0]).toContain('cannot be undone');
        expect(args[2]).toBe('Delete Recursively');
        return 'Delete Recursively';
      }),
    };
    const service = new McpAgentService(
      { load: async () => state },
      {} as never,
      pool as never,
      prompt,
    );
    await expect(
      service.dispatch(
        'sftp_delete',
        { connectionId: enabled.id, path: '/app/tree', recursive: true },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ deleted: true, count: 5 });
    expect(visitedDirectories).toEqual(['/app/tree']);
    expect(deleted).toContain('/app/tree/link');
    expect(deleted).toContain('/app/tree');
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}
