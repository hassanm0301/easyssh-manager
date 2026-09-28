import type { ConnectionId } from '../connections/types';

/** Network behavior deliberately begins in Milestone 03. */
export interface SshSessionFactory {
  connect(connectionId: ConnectionId): Promise<SshSession>;
}

export interface SshSession {
  dispose(): void | Promise<void>;
}
