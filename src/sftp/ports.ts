import type { ConnectionId } from '../connections/types';

/** SFTP operations are implemented in Milestone 04 behind this boundary. */
export interface SftpClientFactory {
  open(connectionId: ConnectionId): Promise<SftpClient>;
}

export interface SftpClient {
  dispose(): void | Promise<void>;
}
