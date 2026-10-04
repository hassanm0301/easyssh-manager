import { EventEmitter } from 'node:events';
import type { SFTPWrapper } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';

import { SessionSftpClientFactory } from '../../sftp/SftpClientFactory';
import type { SftpSubsystemHandle, SshConnectionHandle, SshSessionManager } from '../../ssh/ports';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function connectionHandle(openSftp: () => Promise<SftpSubsystemHandle>) {
  return {
    openSftp,
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  } as unknown as SshConnectionHandle;
}

describe('session-backed SFTP client factory', () => {
  it('opens a dedicated SFTP-purpose session and transfers ownership to the client', async () => {
    const end = vi.fn();
    const sftp = Object.assign(new EventEmitter(), { end }) as unknown as SFTPWrapper;
    const handle = connectionHandle(async () => ({
      sftp,
      [Symbol.asyncDispose]: async () => undefined,
    }));
    const connect = vi.fn(async () => handle);
    const factory = new SessionSftpClientFactory(
      { connect } as Pick<SshSessionManager, 'connect'>,
      () => 12_345,
      () => 'scope-id',
    );

    const client = await factory.open(CONNECTION_ID);
    expect(connect).toHaveBeenCalledWith(CONNECTION_ID, {
      kind: 'sftp',
      scopeId: 'scope-id',
    });
    await client.close();
    expect(end).toHaveBeenCalledOnce();
    expect(handle[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it('disposes the SSH session when opening its SFTP subsystem fails', async () => {
    const handle = connectionHandle(async () => {
      throw new Error('subsystem rejected');
    });
    const factory = new SessionSftpClientFactory({ connect: async () => handle }, () => 1_000);
    await expect(factory.open(CONNECTION_ID)).rejects.toThrow('subsystem rejected');
    expect(handle[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });
});
