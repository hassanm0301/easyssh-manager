import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

import { RemoteResourceCache } from '../../sftp/RemoteResourceCache';
import { DefaultSftpUriCodec, type SftpUriComponents } from '../../sftp/SftpUriCodec';
import type { RemoteDirectoryEntry, RemoteStat } from '../../sftp/ports';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function uriFactory() {
  return {
    from: (components: SftpUriComponents) =>
      ({
        scheme: components.scheme,
        authority: components.authority ?? '',
        path: components.path ?? '',
        query: components.query ?? '',
        fragment: components.fragment ?? '',
        toString: () => `${components.scheme}://${components.authority}${components.path}`,
      }) as unknown as vscode.Uri,
  };
}

const codec = new DefaultSftpUriCodec(
  uriFactory(),
  (connectionId) => connectionId === FIRST_ID || connectionId === SECOND_ID,
);

const fileStat = (size: number): RemoteStat => ({ kind: 'file', size, mtimeMs: size * 1_000 });
const listing = (name: string, size: number): readonly RemoteDirectoryEntry[] => [
  { name, stat: fileStat(size) },
];

describe('remote resource cache', () => {
  it('expires metadata and directory entries independently and returns defensive copies', () => {
    let now = 100;
    const cache = new RemoteResourceCache(codec, {
      metadataTtlMs: 10,
      directoryTtlMs: 20,
      clock: () => now,
    });
    const stat = fileStat(5);
    const entries = listing('file', 5);
    cache.rememberMetadata(FIRST_ID, '/dir/file', stat);
    cache.rememberDirectory(FIRST_ID, '/dir', entries);

    const cachedStat = cache.getMetadata(FIRST_ID, '/dir/file');
    const cachedEntries = cache.getDirectory(FIRST_ID, '/dir');
    expect(cachedStat).toEqual(stat);
    expect(cachedEntries).toEqual(entries);
    (cachedStat as { size: number }).size = 99;
    (cachedEntries?.[0]?.stat as { size: number }).size = 99;
    expect(cache.getMetadata(FIRST_ID, '/dir/file')?.size).toBe(5);
    expect(cache.getDirectory(FIRST_ID, '/dir')?.[0]?.stat.size).toBe(5);

    now = 110;
    expect(cache.getMetadata(FIRST_ID, '/dir/file')).toBeUndefined();
    expect(cache.getDirectory(FIRST_ID, '/dir')).toBeDefined();
    now = 120;
    expect(cache.getDirectory(FIRST_ID, '/dir')).toBeUndefined();
  });

  it('bypasses cached metadata for fresh conflict checks', async () => {
    const cache = new RemoteResourceCache(codec);
    cache.rememberMetadata(FIRST_ID, '/file', fileStat(1));
    const loader = vi.fn(async () => fileStat(2));
    await expect(cache.loadMetadata(FIRST_ID, '/file', loader)).resolves.toMatchObject({ size: 1 });
    expect(loader).not.toHaveBeenCalled();
    await expect(cache.loadMetadata(FIRST_ID, '/file', loader, true)).resolves.toMatchObject({
      size: 2,
    });
    expect(loader).toHaveBeenCalledOnce();
    expect(cache.getMetadata(FIRST_ID, '/file')?.size).toBe(2);
  });

  it('invalidates only an exact path or its exact parent caches', () => {
    const cache = new RemoteResourceCache(codec);
    const fileUri = codec.create(FIRST_ID, '/dir/file');
    const siblingUri = codec.create(FIRST_ID, '/dir/sibling');
    cache.rememberMetadata(FIRST_ID, '/dir', fileStat(0));
    cache.rememberMetadata(FIRST_ID, '/dir/file', fileStat(1));
    cache.rememberMetadata(FIRST_ID, '/dir/sibling', fileStat(2));
    cache.rememberDirectory(FIRST_ID, '/dir', listing('file', 1));
    cache.rememberDirectory(FIRST_ID, '/other', listing('other', 3));
    cache.rememberVersion(fileUri, { mtimeMs: 1, size: 1 });
    cache.rememberVersion(siblingUri, { mtimeMs: 2, size: 2 });

    cache.invalidatePath(FIRST_ID, '/dir/file');
    expect(cache.getMetadata(FIRST_ID, '/dir/file')).toBeUndefined();
    expect(cache.getVersion(fileUri)).toBeUndefined();
    expect(cache.getMetadata(FIRST_ID, '/dir/sibling')).toBeDefined();
    expect(cache.getVersion(siblingUri)).toBeDefined();
    expect(cache.getDirectory(FIRST_ID, '/dir')).toBeDefined();

    cache.invalidateParent(FIRST_ID, '/dir/sibling');
    expect(cache.getMetadata(FIRST_ID, '/dir')).toBeUndefined();
    expect(cache.getDirectory(FIRST_ID, '/dir')).toBeUndefined();
    expect(cache.getDirectory(FIRST_ID, '/other')).toBeDefined();
    expect(cache.getVersion(siblingUri)).toBeDefined();
  });

  it('isolates identical paths by connection and emits precise invalidation events', () => {
    const cache = new RemoteResourceCache(codec);
    const events = vi.fn();
    cache.onDidInvalidate(events);
    cache.rememberMetadata(FIRST_ID, '/same', fileStat(1));
    cache.rememberMetadata(SECOND_ID, '/same', fileStat(2));
    cache.rememberVersion(codec.create(FIRST_ID, '/same'), { mtimeMs: 1, size: 1 });
    cache.rememberVersion(codec.create(SECOND_ID, '/same'), { mtimeMs: 2, size: 2 });

    cache.invalidateConnection(FIRST_ID);
    expect(cache.getMetadata(FIRST_ID, '/same')).toBeUndefined();
    expect(cache.getVersion(codec.create(FIRST_ID, '/same'))).toBeUndefined();
    expect(cache.getMetadata(SECOND_ID, '/same')?.size).toBe(2);
    expect(cache.getVersion(codec.create(SECOND_ID, '/same'))).toEqual({ mtimeMs: 2, size: 2 });
    expect(events).toHaveBeenCalledWith({
      connectionId: FIRST_ID,
      remotePath: '/',
      scope: 'connection',
    });
  });

  it('validates version tokens and normalizes cache keys', () => {
    const cache = new RemoteResourceCache(codec);
    cache.rememberMetadata(FIRST_ID, '//dir/./file', fileStat(1));
    expect(cache.getMetadata(FIRST_ID, '/dir/file')).toEqual(fileStat(1));
    expect(() =>
      cache.rememberVersion(codec.create(FIRST_ID, '/file'), {
        mtimeMs: 1,
        size: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/safe integer/);
  });
});
