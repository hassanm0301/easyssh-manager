import { posix } from 'node:path';

import { EasySshError } from '../common/errors';
import type { ConnectionId } from '../connections/types';
import type { CancellationTokenLike } from '../ssh/ports';
import type { RemoteResourceCache } from './RemoteResourceCache';
import { normalizeRemotePath } from './SftpUriCodec';
import type { RemoteDirectoryEntry, SftpConnectionPool } from './ports';
import type { RemoteEntryView, SftpSortDirection, SftpSortKey } from './browser/contracts';

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly RemoteEntryView[];
}

/** A single-directory browser facade. It never walks descendants while listing. */
export class SftpBrowserService {
  constructor(
    private readonly pool: SftpConnectionPool,
    private readonly cache: RemoteResourceCache,
  ) {}

  async list(
    connectionId: ConnectionId,
    requestedPath: string,
    options: {
      readonly force: boolean;
      readonly sort: SftpSortKey;
      readonly direction: SftpSortDirection;
      readonly cancellation?: CancellationTokenLike;
    },
  ): Promise<DirectoryListing> {
    const path = normalizeRemotePath(requestedPath);
    const lease = await this.pool.acquire(connectionId, options.cancellation);
    try {
      const entries = await this.cache.loadDirectory(
        connectionId,
        path,
        () => lease.client.readDirectory(path),
        options.force,
      );
      return {
        path,
        entries: sortEntries(toEntryViews(path, entries), options.sort, options.direction),
      };
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }

  async resolveExplicitLink(connectionId: ConnectionId, requestedPath: string): Promise<string> {
    const path = normalizeRemotePath(requestedPath);
    const lease = await this.pool.acquire(connectionId);
    try {
      const stat = await lease.client.lstat(path);
      if (stat.kind !== 'symbolicLink') return path;
      const target = await lease.client.readlink(path);
      const resolved = target.startsWith('/')
        ? normalizeRemotePath(target)
        : normalizeRemotePath(posix.join(posix.dirname(path), target));
      // Confirm the explicit target exists before callers navigate/open it.
      await lease.client.stat(resolved);
      return resolved;
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }
}

export function sortEntries(
  entries: readonly RemoteEntryView[],
  key: SftpSortKey,
  direction: SftpSortDirection,
): readonly RemoteEntryView[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const group = kindGroup(left.entry) - kindGroup(right.entry);
      if (group !== 0) return group;
      const value = compareEntry(left.entry, right.entry, key);
      if (value !== 0) return value * multiplier;
      const name = left.entry.name.localeCompare(right.entry.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      return name !== 0 ? name : left.index - right.index;
    })
    .map(({ entry }) => entry);
}

function toEntryViews(
  parent: string,
  entries: readonly RemoteDirectoryEntry[],
): readonly RemoteEntryView[] {
  return entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .map((entry) => {
      if (!isSafeRemoteEntryName(entry.name)) {
        throw new EasySshError('REMOTE_IO', 'The server returned an unsafe directory entry name.');
      }
      const path = normalizeRemotePath(posix.join(parent, entry.name));
      return {
        name: entry.name,
        path,
        kind: entry.stat.kind,
        ...(entry.stat.kind === 'file' ? { size: entry.stat.size } : {}),
        ...(Number.isSafeInteger(entry.stat.mtimeMs) ? { mtimeMs: entry.stat.mtimeMs } : {}),
      };
    });
}

function isSafeRemoteEntryName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0')
  );
}

function compareEntry(left: RemoteEntryView, right: RemoteEntryView, key: SftpSortKey): number {
  if (key === 'name') {
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  }
  if (key === 'size') return (left.size ?? -1) - (right.size ?? -1);
  return (left.mtimeMs ?? -1) - (right.mtimeMs ?? -1);
}

function kindGroup(entry: RemoteEntryView): number {
  if (entry.kind === 'directory') return 0;
  if (entry.kind === 'file') return 1;
  if (entry.kind === 'symbolicLink') return 2;
  return 3;
}
