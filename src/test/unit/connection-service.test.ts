import { describe, expect, it } from 'vitest';

import { ConnectionService } from '../../connections/ConnectionService';
import { InMemoryCredentialCleanupQueue } from '../../connections/CredentialStore';
import type { CredentialStore, StateRepository } from '../../connections/ports';
import { emptyPersistedState, type PersistedStateV1 } from '../../connections/types';

class StateFake implements StateRepository {
  value: PersistedStateV1 = emptyPersistedState();
  readonly onDidChange = () => ({ dispose: () => undefined });
  async load(): Promise<Readonly<PersistedStateV1>> {
    return structuredClone(this.value);
  }
  async update(mutator: (draft: PersistedStateV1) => void): Promise<void> {
    const next = structuredClone(this.value);
    mutator(next);
    this.value = next;
  }
}
class SecretsFake implements CredentialStore {
  readonly values = new Map<string, string>();
  private key(id: string, kind: string): string {
    return `${id}:${kind}`;
  }
  async getPassword(id: string): Promise<string | undefined> {
    return this.values.get(this.key(id, 'password'));
  }
  async setPassword(id: string, value: string): Promise<void> {
    this.values.set(this.key(id, 'password'), value);
  }
  async getKeyPassphrase(id: string): Promise<string | undefined> {
    return this.values.get(this.key(id, 'keyPassphrase'));
  }
  async setKeyPassphrase(id: string, value: string): Promise<void> {
    this.values.set(this.key(id, 'keyPassphrase'), value);
  }
  async clearPassword(id: string): Promise<void> {
    this.values.delete(this.key(id, 'password'));
  }
  async clearKeyPassphrase(id: string): Promise<void> {
    this.values.delete(this.key(id, 'keyPassphrase'));
  }
  async clearAll(id: string): Promise<void> {
    await this.clearPassword(id);
    await this.clearKeyPassphrase(id);
  }
  async copySelected(
    source: string,
    target: string,
    kinds: ('password' | 'keyPassphrase')[],
  ): Promise<('password' | 'keyPassphrase')[]> {
    const copied: ('password' | 'keyPassphrase')[] = [];
    for (const kind of kinds) {
      const value = this.values.get(this.key(source, kind));
      if (value !== undefined) {
        this.values.set(this.key(target, kind), value);
        copied.push(kind);
      }
    }
    return copied;
  }
}

describe('ConnectionService', () => {
  it('orders nested items, blocks cycles, and keeps credentials outside state', async () => {
    const state = new StateFake();
    const secrets = new SecretsFake();
    let id = 0;
    const service = new ConnectionService(
      state,
      secrets,
      () => 1,
      () => `id-${++id}`,
    );
    const root = await service.addFolder('Root');
    const child = await service.addFolder('Child', root.id);
    const connection = await service.addConnection({
      name: 'same',
      host: '2001:db8::1',
      username: 'user',
      folderId: child.id,
      authentication: { type: 'password', hasStoredPassword: false },
    });
    await service.changeCredential(connection.id, 'password', {
      action: 'set',
      value: 'SENTINEL_PASSWORD',
    });
    expect(JSON.stringify(state.value)).not.toContain('SENTINEL_PASSWORD');
    expect(await secrets.getPassword(connection.id)).toBe('SENTINEL_PASSWORD');
    await expect(service.moveItem(root.id, child.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await service.moveItem(connection.id, null);
    expect(state.value.connections[0]?.folderId).toBeNull();
    expect(state.value.connections[0]?.order).toBe(0);
  });
  it('clears both secret kinds when deleting a connection', async () => {
    const state = new StateFake();
    const secrets = new SecretsFake();
    const service = new ConnectionService(
      state,
      secrets,
      () => 1,
      () => 'id',
    );
    const connection = await service.addConnection({
      name: 'one',
      host: 'host',
      username: 'user',
      authentication: { type: 'agent' },
    });
    await secrets.setPassword(connection.id, 'password');
    await secrets.setKeyPassphrase(connection.id, 'phrase');
    await service.deleteConnection(connection.id);
    expect(secrets.values.size).toBe(0);
    expect(state.value.connections).toEqual([]);
  });

  it('normalizes spoofed credential hints and duplicates metadata with a unique id', async () => {
    const state = new StateFake();
    const secrets = new SecretsFake();
    let id = 0;
    const service = new ConnectionService(
      state,
      secrets,
      () => 5,
      () => `id-${++id}`,
    );
    const original = await service.addConnection({
      name: ' secure ',
      host: 'host',
      username: 'user',
      authentication: { type: 'password', hasStoredPassword: true },
    });
    expect(original.authentication).toEqual({ type: 'password', hasStoredPassword: false });
    await service.changeCredential(original.id, 'password', { action: 'set', value: 'secret' });
    const duplicate = await service.duplicateConnection(original.id);
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.authentication).toEqual({ type: 'password', hasStoredPassword: false });
    await service.copyCredentials(original.id, duplicate.id, ['password']);
    expect(state.value.connections[1]?.authentication).toEqual({
      type: 'password',
      hasStoredPassword: true,
    });
  });

  it('keeps sibling orders gapless across reorder, reparent, and move-children deletion', async () => {
    const state = new StateFake();
    const secrets = new SecretsFake();
    let id = 0;
    const service = new ConnectionService(
      state,
      secrets,
      () => 1,
      () => `id-${++id}`,
    );
    const left = await service.addFolder('left');
    const right = await service.addFolder('right');
    const nested = await service.addFolder('nested', left.id);
    const first = await service.addConnection({
      name: 'first',
      folderId: left.id,
      host: 'host',
      username: 'user',
      authentication: { type: 'agent' },
    });
    const second = await service.addConnection({
      name: 'second',
      folderId: left.id,
      host: 'host',
      username: 'user',
      authentication: { type: 'agent' },
    });
    await service.moveItem(second.id, left.id, first.id);
    expect(
      state.value.connections
        .filter((connection) => connection.folderId === left.id)
        .sort((a, b) => a.order - b.order)
        .map((connection) => connection.id),
    ).toEqual([second.id, first.id]);
    await service.moveItem(first.id, right.id);
    await service.deleteFolder(left.id, 'moveChildren');
    expect(state.value.folders.find((folder) => folder.id === nested.id)?.parentId).toBeNull();
    expect(
      state.value.connections.find((connection) => connection.id === second.id)?.folderId,
    ).toBeNull();
    expect(
      state.value.folders.filter((folder) => folder.parentId === null).map((item) => item.order),
    ).toEqual([0, 1]);
  });

  it('removes recursive metadata and reports durable cleanup when secret deletion fails', async () => {
    const state = new StateFake();
    const secrets = new SecretsFake();
    let id = 0;
    const service = new ConnectionService(
      state,
      secrets,
      () => 1,
      () => `id-${++id}`,
    );
    const folder = await service.addFolder('folder');
    await service.addConnection({
      name: 'one',
      folderId: folder.id,
      host: 'host',
      username: 'user',
      authentication: { type: 'agent' },
    });
    secrets.clearAll = async () => {
      throw new Error('secret storage unavailable');
    };
    await expect(service.deleteFolder(folder.id, 'recursive')).rejects.toThrow(
      'credential cleanup is pending',
    );
    expect(state.value.folders).toHaveLength(0);
    expect(state.value.connections).toHaveLength(0);
  });

  it('retries a queued cleanup after metadata deletion', async () => {
    const state = new StateFake();
    const secrets = new SecretsFake();
    const cleanup = new InMemoryCredentialCleanupQueue();
    const service = new ConnectionService(
      state,
      secrets,
      () => 1,
      () => 'id',
      cleanup,
    );
    const connection = await service.addConnection({
      name: 'one',
      host: 'host',
      username: 'user',
      authentication: { type: 'agent' },
    });
    const clear = secrets.clearAll.bind(secrets);
    secrets.clearAll = async () => {
      throw new Error('temporarily unavailable');
    };
    await expect(service.deleteConnection(connection.id)).rejects.toThrow('cleanup is pending');
    expect(state.value.connections).toEqual([]);
    expect(await cleanup.list()).toEqual([connection.id]);
    secrets.clearAll = clear;
    await service.retryCredentialCleanup();
    expect(await cleanup.list()).toEqual([]);
  });
});
