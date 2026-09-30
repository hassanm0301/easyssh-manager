import { describe, expect, it, vi } from 'vitest';

import { EasySshError } from '../../common/errors';
import { defaultAgentAccessPolicy, type RemoteConnection } from '../../connections/types';
import { TestConnectionService } from '../../ssh/TestConnectionService';
import type {
  ConnectionPurpose,
  ConnectionResolver,
  SftpSubsystemHandle,
  SshConnectionHandle,
  SshSessionManager,
} from '../../ssh/ports';

const connection: RemoteConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'test-service',
  folderId: null,
  order: 0,
  host: 'example.test',
  port: 22,
  username: 'tester',
  defaultRemotePath: '/configured/path',
  authentication: { type: 'agent' },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
  createdAt: 1,
  updatedAt: 1,
};

describe('Test Connection', () => {
  it('authenticates, opens SFTP, resolves and lists the configured path, then closes all scopes', async () => {
    const subsystemDispose = vi.fn(async () => undefined);
    const handleDispose = vi.fn(async () => undefined);
    const realpath = vi.fn(
      (path: string, callback: (error: Error | undefined, resolved: string) => void) =>
        callback(undefined, path),
    );
    const readdir = vi.fn(
      (_path: string, callback: (error: Error | undefined, entries: never[]) => void) =>
        callback(undefined, []),
    );
    const subsystem = {
      sftp: { realpath, readdir },
      [Symbol.asyncDispose]: subsystemDispose,
    } as unknown as SftpSubsystemHandle;
    const handle = {
      openSftp: vi.fn(async () => subsystem),
      [Symbol.asyncDispose]: handleDispose,
    } as unknown as SshConnectionHandle;
    const manager = managerWith(async () => handle);
    const service = new TestConnectionService(manager, resolver());

    const result = await service.testSaved(connection.id, 'test-1');
    expect(result.stages).toHaveLength(4);
    expect(realpath).toHaveBeenCalledWith('/configured/path', expect.any(Function));
    expect(readdir).toHaveBeenCalledWith('/configured/path', expect.any(Function));
    expect(subsystemDispose).toHaveBeenCalledOnce();
    expect(handleDispose).toHaveBeenCalledOnce();
  });

  it('reports the failing stage and still disposes an authenticated connection', async () => {
    const handleDispose = vi.fn(async () => undefined);
    const handle = {
      openSftp: vi.fn(async () => {
        throw new EasySshError('CHANNEL_REJECTED', 'channel unavailable');
      }),
      [Symbol.asyncDispose]: handleDispose,
    } as unknown as SshConnectionHandle;
    const service = new TestConnectionService(
      managerWith(async () => handle),
      resolver(),
    );
    await expect(service.testSaved(connection.id, 'test-2')).rejects.toMatchObject({
      code: 'CHANNEL_REJECTED',
      message: expect.stringContaining('SFTP startup'),
    });
    expect(handleDispose).toHaveBeenCalledOnce();
  });

  it('bounds remote path operations and disposes the SFTP and SSH handles on timeout', async () => {
    const subsystemDispose = vi.fn(async () => undefined);
    const handleDispose = vi.fn(async () => undefined);
    const subsystem = {
      sftp: {
        realpath: (path: string, callback: (error: Error | undefined, resolved: string) => void) =>
          callback(undefined, path),
        readdir: () => undefined,
      },
      [Symbol.asyncDispose]: subsystemDispose,
    } as unknown as SftpSubsystemHandle;
    const handle = {
      openSftp: vi.fn(async () => subsystem),
      [Symbol.asyncDispose]: handleDispose,
    } as unknown as SshConnectionHandle;
    const service = new TestConnectionService(
      managerWith(async () => handle),
      resolver(),
      5,
    );

    await expect(service.testSaved(connection.id, 'test-timeout')).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('remote path validation'),
    });
    expect(subsystemDispose).toHaveBeenCalledOnce();
    expect(handleDispose).toHaveBeenCalledOnce();
  });
});

function resolver(): ConnectionResolver {
  return { resolve: vi.fn(async () => connection) };
}

function managerWith(
  connect: (connectionId: string, purpose: ConnectionPurpose) => Promise<SshConnectionHandle>,
): SshSessionManager {
  return {
    connect: vi.fn(connect),
    connectCandidate: vi.fn(),
    disposeConnection: vi.fn(),
    disposeAll: vi.fn(),
    activeConnectionCount: 0,
    [Symbol.asyncDispose]: vi.fn(),
  } as unknown as SshSessionManager;
}
