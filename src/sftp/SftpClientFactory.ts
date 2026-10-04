import { randomUUID } from 'node:crypto';

import type { ConnectionId } from '../connections/types';
import type { SshSessionManager, CancellationTokenLike } from '../ssh/ports';
import type { SftpClient, SftpClientFactory } from './ports';
import { Ssh2SftpClient } from './Ssh2SftpClient';

/** Opens a dedicated SSH transport/SFTP subsystem for a pooled SFTP client. */
export class SessionSftpClientFactory implements SftpClientFactory {
  constructor(
    private readonly sessions: Pick<SshSessionManager, 'connect'>,
    private readonly operationTimeoutMs: () => number,
    private readonly uuid: () => string = randomUUID,
  ) {}

  async open(
    connectionId: ConnectionId,
    cancellation?: CancellationTokenLike,
  ): Promise<SftpClient> {
    const connection = await this.sessions.connect(connectionId, {
      kind: 'sftp',
      scopeId: this.uuid(),
      ...(cancellation === undefined ? {} : { cancellation }),
    });
    try {
      const subsystem = await connection.openSftp();
      return new Ssh2SftpClient(subsystem.sftp, this.operationTimeoutMs(), () =>
        connection[Symbol.asyncDispose](),
      );
    } catch (error) {
      await connection[Symbol.asyncDispose]();
      throw error;
    }
  }
}
