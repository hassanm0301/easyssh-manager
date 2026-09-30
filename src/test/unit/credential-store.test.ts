import { describe, expect, it } from 'vitest';

import {
  InMemorySessionCredentialCache,
  VsCodeCredentialCleanupQueue,
  VsCodeCredentialStore,
} from '../../connections/CredentialStore';

class SecretStorageFake {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('VsCodeCredentialStore', () => {
  it('stores, replaces, selectively copies, and clears both opaque secret kinds', async () => {
    const storage = new SecretStorageFake();
    const credentials = new VsCodeCredentialStore(storage);
    await credentials.setPassword('source', 'first');
    await credentials.setPassword('source', 'second');
    await credentials.setKeyPassphrase('source', 'phrase');
    expect(await credentials.getPassword('source')).toBe('second');
    expect(await credentials.copySelected('source', 'target', ['password'])).toEqual(['password']);
    expect(await credentials.getPassword('target')).toBe('second');
    expect(await credentials.getKeyPassphrase('target')).toBeUndefined();
    await credentials.clearAll('source');
    expect(await credentials.getPassword('source')).toBeUndefined();
    expect(await credentials.getKeyPassphrase('source')).toBeUndefined();
  });

  it('attempts both deletions and reports every failed credential cleanup', async () => {
    const deleted: string[] = [];
    const credentials = new VsCodeCredentialStore({
      get: async () => undefined,
      store: async () => undefined,
      delete: async (key) => {
        deleted.push(key);
        throw new Error(`failed ${key}`);
      },
    });
    await expect(credentials.clearAll('connection')).rejects.toBeInstanceOf(AggregateError);
    expect(deleted).toEqual([
      'easysshManager.connection.connection.password',
      'easysshManager.connection.connection.keyPassphrase',
    ]);
  });

  it('restores an overwritten target when a later selected copy fails', async () => {
    const storage = new SecretStorageFake();
    await storage.store('easysshManager.connection.source.password', 'source-password');
    await storage.store('easysshManager.connection.source.keyPassphrase', 'source-phrase');
    await storage.store('easysshManager.connection.target.password', 'target-password');
    const originalStore = storage.store.bind(storage);
    storage.store = async (key, value) => {
      if (key === 'easysshManager.connection.target.keyPassphrase')
        throw new Error('passphrase copy failed');
      await originalStore(key, value);
    };
    const credentials = new VsCodeCredentialStore(storage);
    await expect(
      credentials.copySelected('source', 'target', ['password', 'keyPassphrase']),
    ).rejects.toThrow('passphrase copy failed');
    expect(await credentials.getPassword('target')).toBe('target-password');
    expect(await credentials.getKeyPassphrase('target')).toBeUndefined();
  });
});

describe('InMemorySessionCredentialCache', () => {
  it('isolates values by session and clears the whole session', () => {
    const cache = new InMemorySessionCredentialCache();
    cache.set('terminal-1', 'password', 'one');
    cache.set('terminal-2', 'password', 'two');
    cache.clear('terminal-1');
    expect(cache.get('terminal-1', 'password')).toBeUndefined();
    expect(cache.get('terminal-2', 'password')).toBe('two');
  });
});

describe('VsCodeCredentialCleanupQueue', () => {
  it('persists only deduplicated connection ids for retry', async () => {
    const values = new Map<string, unknown>();
    const queue = new VsCodeCredentialCleanupQueue({
      get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key, value) => {
        values.set(key, structuredClone(value));
      },
    });
    await Promise.all([queue.add(['one']), queue.add(['one', 'two'])]);
    expect(await queue.list()).toEqual(['one', 'two']);
    expect(JSON.stringify([...values.values()])).not.toContain('password');
    await queue.remove('one');
    expect(await queue.list()).toEqual(['two']);
  });
});
