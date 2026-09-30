import type { ConnectionSummary, PersistedStateV1 } from './types';

/** Read-only summary boundary retained for future consumers of connection metadata. */
export interface ConnectionRepository {
  list(): Promise<readonly ConnectionSummary[]>;
}

export interface StateChange {
  readonly previous: Readonly<PersistedStateV1>;
  readonly current: Readonly<PersistedStateV1>;
}

export interface StateRepository {
  load(): Promise<Readonly<PersistedStateV1>>;
  update(mutator: (draft: PersistedStateV1) => void): Promise<void>;
  readonly onDidChange: (listener: (change: StateChange) => unknown) => { dispose(): void };
}

export type CredentialKind = 'password' | 'keyPassphrase';

export interface CredentialStore {
  getPassword(connectionId: string): Promise<string | undefined>;
  setPassword(connectionId: string, value: string): Promise<void>;
  getKeyPassphrase(connectionId: string): Promise<string | undefined>;
  setKeyPassphrase(connectionId: string, value: string): Promise<void>;
  clearPassword(connectionId: string): Promise<void>;
  clearKeyPassphrase(connectionId: string): Promise<void>;
  clearAll(connectionId: string): Promise<void>;
  copySelected(
    sourceId: string,
    targetId: string,
    kinds: CredentialKind[],
  ): Promise<CredentialKind[]>;
}

/** Contains only connection ids; never credential values. */
export interface CredentialCleanupQueue {
  add(connectionIds: readonly string[]): Promise<void>;
  remove(connectionId: string): Promise<void>;
  list(): Promise<readonly string[]>;
}

/** Never persist this cache. Session owners must clear it when their session ends. */
export interface SessionCredentialCache {
  get(sessionId: string, kind: CredentialKind): string | undefined;
  set(sessionId: string, kind: CredentialKind, value: string): void;
  clear(sessionId: string): void;
}
