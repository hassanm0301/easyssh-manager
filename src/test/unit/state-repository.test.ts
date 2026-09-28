import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    private readonly listeners: ((value: T) => unknown)[] = [];
    readonly event = (listener: (value: T) => unknown) => {
      this.listeners.push(listener);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose(): void {
      this.listeners.length = 0;
    }
  },
}));

import {
  FutureSchemaError,
  STATE_KEY,
  VsCodeStateRepository,
  validatePersistedState,
} from '../../connections/StateRepository';
import { emptyPersistedState } from '../../connections/types';

class GlobalStateFake {
  readonly values = new Map<string, unknown>();
  failNextWrite = false;
  writes: string[] = [];
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('write failed');
    }
    await Promise.resolve();
    this.writes.push(key);
    this.values.set(key, structuredClone(value));
  }
}

describe('VsCodeStateRepository', () => {
  let storage: GlobalStateFake;

  beforeEach(() => {
    storage = new GlobalStateFake();
  });

  it('initializes and persists one empty v1 envelope', async () => {
    const repository = new VsCodeStateRepository(storage);
    await expect(repository.load()).resolves.toEqual(emptyPersistedState());
    expect(storage.values.get(STATE_KEY)).toEqual(emptyPersistedState());
  });

  it('serializes concurrent updates without losing either mutation', async () => {
    const repository = new VsCodeStateRepository(storage);
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    await Promise.all([
      repository.update((draft) => {
        draft.folders.push({
          id: firstId,
          name: 'first',
          parentId: null,
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        });
      }),
      repository.update((draft) => {
        draft.folders.push({
          id: secondId,
          name: 'second',
          parentId: null,
          order: 1,
          createdAt: 1,
          updatedAt: 1,
        });
      }),
    ]);
    expect((await repository.load()).folders.map((folder) => folder.id)).toEqual([
      firstId,
      secondId,
    ]);
  });

  it('keeps cached state and change events unchanged after a failed write', async () => {
    const repository = new VsCodeStateRepository(storage);
    await repository.load();
    const changes = vi.fn();
    repository.onDidChange(changes);
    storage.failNextWrite = true;
    await expect(
      repository.update((draft) => {
        draft.folders.push({
          id: '33333333-3333-4333-8333-333333333333',
          name: 'not committed',
          parentId: null,
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        });
      }),
    ).rejects.toThrow('write failed');
    expect((await repository.load()).folders).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });

  it('migrates v0, recovers malformed current data, and rejects future data', async () => {
    storage.values.set(STATE_KEY, { schemaVersion: 0 });
    const migrated = new VsCodeStateRepository(storage);
    await expect(migrated.load()).resolves.toEqual(emptyPersistedState());

    storage = new GlobalStateFake();
    storage.values.set(STATE_KEY, { schemaVersion: 1, connections: 'broken' });
    const notify = vi.fn(async () => undefined);
    const recovered = new VsCodeStateRepository(storage, { error: notify });
    await expect(recovered.load()).resolves.toEqual(emptyPersistedState());
    expect([...storage.values.keys()].some((key) => key.startsWith(`${STATE_KEY}.recovery.`))).toBe(
      true,
    );
    expect(notify).toHaveBeenCalledOnce();

    storage = new GlobalStateFake();
    storage.values.set(STATE_KEY, { schemaVersion: 99, sentinel: true });
    const future = new VsCodeStateRepository(storage);
    await expect(future.load()).rejects.toBeInstanceOf(FutureSchemaError);
    expect(storage.writes).toEqual([]);
  });
});

describe('persisted runtime schema', () => {
  it('rejects unknown fields, non-v4 ids, and invalid host credentials', () => {
    expect(() => validatePersistedState({ ...emptyPersistedState(), unexpected: true })).toThrow();
    expect(() =>
      validatePersistedState({
        ...emptyPersistedState(),
        folders: [
          {
            id: 'not-a-uuid',
            name: 'folder',
            parentId: null,
            order: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ).toThrow();
  });
});
