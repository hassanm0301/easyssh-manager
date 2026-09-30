import { describe, expect, it, vi } from 'vitest';

import { defaultAgentAccessPolicy, type RemoteConnection } from '../../connections/types';
import { DefaultSshSessionManager } from '../../ssh/SshSessionManager';
import type { CredentialLease, Event, SshCloseReason, SshConnectionHandle } from '../../ssh/ports';

const connection: RemoteConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'manager-test',
  folderId: null,
  order: 0,
  host: 'example.test',
  port: 22,
  username: 'tester',
  defaultRemotePath: '/',
  authentication: { type: 'password', hasStoredPassword: true },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
  createdAt: 1,
  updatedAt: 1,
};

describe('SSH session manager', () => {
  it('creates isolated clients and leases and disposes only the selected handle', async () => {
    const acquired: string[] = [];
    const handles = [fakeHandle('one'), fakeHandle('two')];
    const manager = new DefaultSshSessionManager(
      { resolve: vi.fn(async () => connection) },
      {
        acquire: vi.fn(async (_profile, scope) => {
          acquired.push(scope.scopeId);
          return { password: scope.scopeId, [Symbol.asyncDispose]: vi.fn() };
        }),
      },
      {
        connect: vi.fn(async (_profile, lease: CredentialLease) => {
          expect(lease.password).toBe(acquired.at(-1));
          return handles.shift()!;
        }),
      },
    );
    const first = await manager.connect(connection.id, { kind: 'terminal', scopeId: 'terminal-1' });
    const second = await manager.connect(connection.id, {
      kind: 'terminal',
      scopeId: 'terminal-2',
    });
    expect(acquired).toEqual(['terminal-1', 'terminal-2']);
    expect(manager.activeConnectionCount).toBe(2);

    await manager.disposeConnection(first.id);
    expect(first[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(second[Symbol.asyncDispose]).not.toHaveBeenCalled();
    expect(manager.activeConnectionCount).toBe(1);
    await manager.disposeAll();
    expect(second[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(manager.activeConnectionCount).toBe(0);
  });
});

function fakeHandle(id: string): SshConnectionHandle {
  const listeners = new Set<(reason: SshCloseReason) => unknown>();
  const onDidClose: Event<SshCloseReason> = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  return {
    id,
    connectionId: connection.id,
    client: {} as never,
    onDidClose,
    openShell: vi.fn(),
    openSftp: vi.fn(),
    exec: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async () => {
      for (const listener of [...listeners]) listener('disposed');
    }),
  };
}
