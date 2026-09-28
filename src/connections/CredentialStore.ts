import type {
  CredentialCleanupQueue,
  CredentialKind,
  CredentialStore,
  SessionCredentialCache,
} from './ports';

export interface SecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const keyFor = (connectionId: string, kind: CredentialKind): string =>
  `easysshManager.connection.${connectionId}.${kind === 'password' ? 'password' : 'keyPassphrase'}`;

/** The only service that knows SecretStorage key names. Values never enter persisted state. */
export class VsCodeCredentialStore implements CredentialStore {
  constructor(private readonly secrets: SecretStorage) {}

  async getPassword(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(keyFor(connectionId, 'password'));
  }
  async setPassword(connectionId: string, value: string): Promise<void> {
    await this.secrets.store(keyFor(connectionId, 'password'), value);
  }
  async getKeyPassphrase(connectionId: string): Promise<string | undefined> {
    return this.secrets.get(keyFor(connectionId, 'keyPassphrase'));
  }
  async setKeyPassphrase(connectionId: string, value: string): Promise<void> {
    await this.secrets.store(keyFor(connectionId, 'keyPassphrase'), value);
  }
  async clearPassword(connectionId: string): Promise<void> {
    await this.secrets.delete(keyFor(connectionId, 'password'));
  }
  async clearKeyPassphrase(connectionId: string): Promise<void> {
    await this.secrets.delete(keyFor(connectionId, 'keyPassphrase'));
  }
  async clearAll(connectionId: string): Promise<void> {
    const results = await Promise.allSettled([
      this.clearPassword(connectionId),
      this.clearKeyPassphrase(connectionId),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length > 0)
      throw new AggregateError(failures, 'Unable to clear all stored credentials.');
  }
  async copySelected(
    sourceId: string,
    targetId: string,
    kinds: CredentialKind[],
  ): Promise<CredentialKind[]> {
    const copied: CredentialKind[] = [];
    const previous = new Map<CredentialKind, string | undefined>();
    try {
      for (const kind of new Set(kinds)) {
        const value =
          kind === 'password'
            ? await this.getPassword(sourceId)
            : await this.getKeyPassphrase(sourceId);
        if (value !== undefined) {
          previous.set(
            kind,
            kind === 'password'
              ? await this.getPassword(targetId)
              : await this.getKeyPassphrase(targetId),
          );
          if (kind === 'password') await this.setPassword(targetId, value);
          else await this.setKeyPassphrase(targetId, value);
          copied.push(kind);
        }
      }
    } catch (error) {
      for (const kind of copied) await this.restore(targetId, kind, previous.get(kind));
      throw error;
    }
    return copied;
  }

  private async restore(
    connectionId: string,
    kind: CredentialKind,
    value: string | undefined,
  ): Promise<void> {
    try {
      if (kind === 'password') {
        if (value === undefined) await this.clearPassword(connectionId);
        else await this.setPassword(connectionId, value);
      } else if (value === undefined) await this.clearKeyPassphrase(connectionId);
      else await this.setKeyPassphrase(connectionId, value);
    } catch {
      // Preserve the original storage failure after best-effort compensation.
    }
  }
}

export class InMemorySessionCredentialCache implements SessionCredentialCache {
  private readonly values = new Map<string, Map<CredentialKind, string>>();
  get(sessionId: string, kind: CredentialKind): string | undefined {
    return this.values.get(sessionId)?.get(kind);
  }
  set(sessionId: string, kind: CredentialKind, value: string): void {
    const session = this.values.get(sessionId) ?? new Map<CredentialKind, string>();
    session.set(kind, value);
    this.values.set(sessionId, session);
  }
  clear(sessionId: string): void {
    this.values.delete(sessionId);
  }
}

export interface CleanupState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const CLEANUP_KEY = 'easysshManager.credentialCleanup';

/** A durable, secret-free retry list for credentials whose metadata was removed. */
export class VsCodeCredentialCleanupQueue implements CredentialCleanupQueue {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly state: CleanupState) {}

  add(connectionIds: readonly string[]): Promise<void> {
    return this.update((ids) => {
      for (const id of connectionIds) if (!ids.includes(id)) ids.push(id);
    });
  }

  remove(connectionId: string): Promise<void> {
    return this.update((ids) => {
      const index = ids.indexOf(connectionId);
      if (index >= 0) ids.splice(index, 1);
    });
  }

  async list(): Promise<readonly string[]> {
    await this.pending;
    return [...this.read()];
  }

  private update(mutator: (ids: string[]) => void): Promise<void> {
    const operation = async (): Promise<void> => {
      const ids = this.read();
      mutator(ids);
      await this.state.update(CLEANUP_KEY, ids);
    };
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private read(): string[] {
    const value = this.state.get<unknown>(CLEANUP_KEY);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === 'string'))];
  }
}

export class InMemoryCredentialCleanupQueue implements CredentialCleanupQueue {
  private readonly ids = new Set<string>();
  async add(connectionIds: readonly string[]): Promise<void> {
    for (const id of connectionIds) this.ids.add(id);
  }
  async remove(connectionId: string): Promise<void> {
    this.ids.delete(connectionId);
  }
  async list(): Promise<readonly string[]> {
    return [...this.ids];
  }
}
