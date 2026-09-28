import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { EasySshError } from '../common/errors';
import { InMemoryCredentialCleanupQueue } from './CredentialStore';
import type {
  CredentialCleanupQueue,
  CredentialKind,
  CredentialStore,
  StateRepository,
} from './ports';
import {
  defaultAgentAccessPolicy,
  type Authentication,
  type ConnectionFolder,
  type FolderId,
  type PersistedStateV1,
  type RemoteConnection,
} from './types';

export interface ConnectionInput {
  name: string;
  folderId?: string | null;
  host: string;
  port?: number;
  username: string;
  defaultRemotePath?: string;
  authentication: Authentication;
  agentAccess?: RemoteConnection['agentAccess'];
  options?: RemoteConnection['options'];
  importedFromSshConfig?: RemoteConnection['importedFromSshConfig'];
}

export type CredentialChange =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'set'; value: string };

export class ConnectionService {
  constructor(
    private readonly state: StateRepository,
    private readonly credentials: CredentialStore,
    private readonly now: () => number = Date.now,
    private readonly uuid: () => string = randomUUID,
    private readonly cleanup: CredentialCleanupQueue = new InMemoryCredentialCleanupQueue(),
  ) {}

  async addFolder(name: string, parentId: FolderId | null = null): Promise<ConnectionFolder> {
    let created!: ConnectionFolder;
    await this.state.update((draft) => {
      this.assertFolderParent(draft, parentId);
      const timestamp = this.now();
      created = {
        id: this.uuid(),
        name: validName(name),
        parentId,
        order: siblings(draft.folders, parentId).length,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      draft.folders.push(created);
    });
    return created;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.state.update((draft) => {
      const folder = required(
        draft.folders.find((item) => item.id === id),
        'Folder',
      );
      folder.name = validName(name);
      folder.updatedAt = this.now();
    });
  }

  async addConnection(input: ConnectionInput): Promise<RemoteConnection> {
    const id = this.uuid();
    let created!: RemoteConnection;
    try {
      await this.state.update((draft) => {
        const folderId = input.folderId ?? null;
        this.assertFolderParent(draft, folderId);
        const timestamp = this.now();
        created = makeConnection(
          id,
          input,
          siblings(draft.connections, folderId).length,
          timestamp,
        );
        draft.connections.push(created);
      });
      return created;
    } catch (error) {
      await this.cleanup.add([id]).catch(() => undefined);
      await this.cleanupCredentials(id).catch(() => undefined);
      throw error;
    }
  }

  async editConnection(id: string, input: ConnectionInput): Promise<void> {
    await this.state.update((draft) => {
      const current = required(
        draft.connections.find((item) => item.id === id),
        'Connection',
      );
      const folderId = input.folderId ?? null;
      this.assertFolderParent(draft, folderId);
      if (current.folderId !== folderId)
        moveInArray(
          draft.connections,
          current,
          folderId,
          undefined,
          (item) => item.folderId,
          this.now,
        );
      const updated = makeConnection(current.id, input, current.order, current.createdAt, current);
      Object.assign(current, updated, {
        createdAt: current.createdAt,
        updatedAt: this.now(),
        folderId,
      });
    });
  }

  async duplicateConnection(sourceId: string): Promise<RemoteConnection> {
    let duplicate!: RemoteConnection;
    await this.state.update((draft) => {
      const source = required(
        draft.connections.find((item) => item.id === sourceId),
        'Connection',
      );
      const timestamp = this.now();
      duplicate = structuredClone(source);
      duplicate.id = this.uuid();
      duplicate.name = duplicateName(source.name);
      duplicate.order = siblings(draft.connections, source.folderId).length;
      duplicate.createdAt = timestamp;
      duplicate.updatedAt = timestamp;
      if (duplicate.authentication.type === 'password')
        duplicate.authentication.hasStoredPassword = false;
      if (duplicate.authentication.type === 'privateKey')
        duplicate.authentication.hasStoredPassphrase = false;
      draft.connections.push(duplicate);
    });
    return duplicate;
  }

  async deleteConnection(id: string): Promise<void> {
    await this.cleanup.add([id]);
    try {
      await this.state.update((draft) => {
        const item = required(
          draft.connections.find((connection) => connection.id === id),
          'Connection',
        );
        draft.connections.splice(draft.connections.indexOf(item), 1);
        compact(siblings(draft.connections, item.folderId), this.now);
      });
    } catch (error) {
      await this.cleanup.remove(id).catch(() => undefined);
      throw error;
    }
    await this.cleanupCredentials(id);
  }

  /** Updates a credential independently of form metadata. A blank form field is always keep. */
  async changeCredential(
    id: string,
    kind: CredentialKind,
    change: CredentialChange,
  ): Promise<void> {
    if (change.action === 'keep') return;
    const previous =
      kind === 'password'
        ? await this.credentials.getPassword(id)
        : await this.credentials.getKeyPassphrase(id);
    try {
      if (change.action === 'clear') {
        if (kind === 'password') await this.credentials.clearPassword(id);
        else await this.credentials.clearKeyPassphrase(id);
      } else if (kind === 'password') {
        await this.credentials.setPassword(id, change.value);
      } else {
        await this.credentials.setKeyPassphrase(id, change.value);
      }
      await this.state.update((draft) => {
        const connection = required(
          draft.connections.find((item) => item.id === id),
          'Connection',
        );
        if (connection.authentication.type === 'password' && kind === 'password') {
          connection.authentication.hasStoredPassword = change.action === 'set';
        }
        if (connection.authentication.type === 'privateKey' && kind === 'keyPassphrase') {
          connection.authentication.hasStoredPassphrase = change.action === 'set';
        }
        connection.updatedAt = this.now();
      });
    } catch (error) {
      // Metadata failure must not leave a new secret behind. Restore the former opaque value.
      if (previous === undefined) {
        if (kind === 'password') await this.credentials.clearPassword(id).catch(() => undefined);
        else await this.credentials.clearKeyPassphrase(id).catch(() => undefined);
      } else if (kind === 'password') {
        await this.credentials.setPassword(id, previous).catch(() => undefined);
      } else {
        await this.credentials.setKeyPassphrase(id, previous).catch(() => undefined);
      }
      throw error;
    }
  }

  async reconcileCredentialHints(): Promise<void> {
    const current = await this.state.load();
    const changes = await Promise.all(
      current.connections.map(async (connection) => {
        if (connection.authentication.type === 'password') {
          return [
            connection.id,
            'password',
            (await this.credentials.getPassword(connection.id)) !== undefined,
          ] as const;
        }
        if (connection.authentication.type === 'privateKey') {
          return [
            connection.id,
            'keyPassphrase',
            (await this.credentials.getKeyPassphrase(connection.id)) !== undefined,
          ] as const;
        }
        return undefined;
      }),
    );
    const needsUpdate = changes.some((change) => {
      if (!change) return false;
      const connection = current.connections.find((item) => item.id === change[0]);
      return connection?.authentication.type === 'password' && change[1] === 'password'
        ? connection.authentication.hasStoredPassword !== change[2]
        : connection?.authentication.type === 'privateKey' && change[1] === 'keyPassphrase'
          ? connection.authentication.hasStoredPassphrase !== change[2]
          : false;
    });
    if (!needsUpdate) return;
    await this.state.update((draft) => {
      for (const change of changes) {
        if (!change) continue;
        const connection = draft.connections.find((item) => item.id === change[0]);
        if (!connection) continue;
        if (connection.authentication.type === 'password' && change[1] === 'password')
          connection.authentication.hasStoredPassword = change[2];
        if (connection.authentication.type === 'privateKey' && change[1] === 'keyPassphrase')
          connection.authentication.hasStoredPassphrase = change[2];
      }
    });
  }

  async retryCredentialCleanup(): Promise<void> {
    const existing = new Set((await this.state.load()).connections.map((item) => item.id));
    for (const id of await this.cleanup.list()) {
      if (existing.has(id)) {
        await this.cleanup.remove(id).catch(() => undefined);
        continue;
      }
      await this.cleanupCredentials(id).catch(() => undefined);
    }
  }

  async copyCredentials(
    sourceId: string,
    targetId: string,
    kinds: CredentialKind[],
  ): Promise<void> {
    const previous = new Map<CredentialKind, string | undefined>();
    for (const kind of kinds) {
      previous.set(
        kind,
        kind === 'password'
          ? await this.credentials.getPassword(targetId)
          : await this.credentials.getKeyPassphrase(targetId),
      );
    }
    const copied = await this.credentials.copySelected(sourceId, targetId, kinds);
    try {
      await this.state.update((draft) => {
        const target = required(
          draft.connections.find((item) => item.id === targetId),
          'Connection',
        );
        if (target.authentication.type === 'password' && copied.includes('password')) {
          target.authentication.hasStoredPassword = true;
        }
        if (target.authentication.type === 'privateKey' && copied.includes('keyPassphrase')) {
          target.authentication.hasStoredPassphrase = true;
        }
        target.updatedAt = this.now();
      });
    } catch (error) {
      for (const kind of copied) {
        const value = previous.get(kind);
        if (kind === 'password') {
          if (value === undefined)
            await this.credentials.clearPassword(targetId).catch(() => undefined);
          else await this.credentials.setPassword(targetId, value).catch(() => undefined);
        } else if (value === undefined) {
          await this.credentials.clearKeyPassphrase(targetId).catch(() => undefined);
        } else {
          await this.credentials.setKeyPassphrase(targetId, value).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  /** Moves an item and compacts both sibling lists as one atomic state update. */
  async moveItem(id: string, targetFolderId: string | null, beforeId?: string): Promise<void> {
    await this.state.update((draft) => {
      const connection = draft.connections.find((item) => item.id === id);
      if (connection) {
        this.assertFolderParent(draft, targetFolderId);
        if (beforeId === id && connection.folderId === targetFolderId) return;
        moveInArray(
          draft.connections,
          connection,
          targetFolderId,
          beforeId,
          (item) => item.folderId,
          this.now,
        );
        return;
      }
      const folder = required(
        draft.folders.find((item) => item.id === id),
        'Item',
      );
      this.assertFolderParent(draft, targetFolderId);
      if (beforeId === id && folder.parentId === targetFolderId) return;
      if (
        targetFolderId === folder.id ||
        this.folderDescendants(draft, folder.id).has(targetFolderId ?? '')
      ) {
        throw new EasySshError(
          'VALIDATION',
          'A folder cannot be moved into itself or a descendant.',
        );
      }
      moveInArray(
        draft.folders,
        folder,
        targetFolderId,
        beforeId,
        (item) => item.parentId,
        this.now,
      );
    });
  }

  async deleteFolder(id: string, strategy: 'moveChildren' | 'recursive'): Promise<void> {
    let connectionIds: string[] = [];
    if (strategy === 'recursive') {
      const current = await this.state.load();
      const descendants = this.folderDescendants(current as PersistedStateV1, id);
      descendants.add(id);
      connectionIds = current.connections
        .filter((item) => item.folderId !== null && descendants.has(item.folderId))
        .map((item) => item.id);
      await this.cleanup.add(connectionIds);
    }
    try {
      await this.state.update((draft) => {
        const folder = required(
          draft.folders.find((item) => item.id === id),
          'Folder',
        );
        const descendants = this.folderDescendants(draft, id);
        if (strategy === 'moveChildren') {
          const children = draft.folders.filter((item) => item.parentId === id).sort(byOrder);
          const folderDestination = siblings(draft.folders, folder.parentId).filter(
            (item) => item.id !== folder.id,
          ).length;
          for (const [index, child] of children.entries()) {
            child.parentId = folder.parentId;
            child.order = folderDestination + index;
            child.updatedAt = this.now();
          }
          const directConnections = draft.connections
            .filter((item) => item.folderId === id)
            .sort(byOrder);
          const connectionDestination = siblings(draft.connections, folder.parentId).length;
          for (const [index, connection] of directConnections.entries()) {
            connection.folderId = folder.parentId;
            connection.order = connectionDestination + index;
            connection.updatedAt = this.now();
          }
          draft.folders.splice(draft.folders.indexOf(folder), 1);
          draft.uiPreferences.expandedFolderIds = draft.uiPreferences.expandedFolderIds.filter(
            (folderId) => folderId !== id,
          );
          compact(siblings(draft.folders, folder.parentId), this.now);
          compact(siblings(draft.connections, folder.parentId), this.now);
        } else {
          descendants.add(id);
          const currentConnectionIds = draft.connections
            .filter((item) => item.folderId !== null && descendants.has(item.folderId))
            .map((item) => item.id);
          draft.connections = draft.connections.filter(
            (item) => !currentConnectionIds.includes(item.id),
          );
          draft.folders = draft.folders.filter((item) => !descendants.has(item.id));
          draft.uiPreferences.expandedFolderIds = draft.uiPreferences.expandedFolderIds.filter(
            (folderId) => !descendants.has(folderId),
          );
          for (const parent of new Set(draft.folders.map((item) => item.parentId)))
            compact(siblings(draft.folders, parent), this.now);
        }
      });
    } catch (error) {
      for (const connectionId of connectionIds)
        await this.cleanup.remove(connectionId).catch(() => undefined);
      throw error;
    }
    if (strategy === 'recursive') {
      const failures: unknown[] = [];
      for (const connectionId of connectionIds) {
        try {
          await this.cleanupCredentials(connectionId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0)
        throw new EasySshError(
          'CONFLICT',
          'Connection metadata was deleted, but credential cleanup is pending and will be retried.',
          new AggregateError(failures),
        );
    }
  }

  private async cleanupCredentials(id: string): Promise<void> {
    try {
      await this.credentials.clearAll(id);
      await this.cleanup.remove(id);
    } catch (error) {
      throw new EasySshError(
        'CONFLICT',
        'Credential cleanup is pending and will be retried automatically.',
        error,
      );
    }
  }

  private assertFolderParent(state: PersistedStateV1, id: string | null): void {
    if (id !== null && !state.folders.some((folder) => folder.id === id))
      throw new EasySshError('NOT_FOUND', 'Destination folder was not found.');
  }
  private folderDescendants(state: PersistedStateV1, root: string): Set<string> {
    const found = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const parent = pending.pop()!;
      for (const folder of state.folders)
        if (folder.parentId === parent && !found.has(folder.id)) {
          found.add(folder.id);
          pending.push(folder.id);
        }
    }
    return found;
  }
}

function makeConnection(
  id: string,
  input: ConnectionInput,
  order: number,
  timestamp: number,
  previous?: RemoteConnection,
): RemoteConnection {
  const auth = normalizedAuthentication(input.authentication, previous?.authentication);
  if (auth.type === 'privateKey' && auth.privateKeyPath.trim() === '')
    throw new EasySshError('VALIDATION', 'A private-key path is required.');
  return {
    id,
    name: validName(input.name),
    folderId: input.folderId ?? null,
    order,
    host: validHost(input.host),
    port: validInteger(input.port ?? 22, 1, 65_535, 'Port'),
    username: validUsername(input.username),
    defaultRemotePath: validRemotePath(input.defaultRemotePath ?? '/'),
    authentication: auth,
    agentAccess: validAgentAccess(input.agentAccess ?? defaultAgentAccessPolicy()),
    options: validOptions(input.options ?? {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.importedFromSshConfig === undefined
      ? {}
      : { importedFromSshConfig: structuredClone(input.importedFromSshConfig) }),
  };
}
function validName(value: string): string {
  const name = value.trim();
  if (!name || name.includes('\0') || Array.from(name).length > 200)
    throw new EasySshError('VALIDATION', 'Name is required and must be at most 200 characters.');
  return name;
}
function duplicateName(value: string): string {
  const suffix = ' copy';
  return `${Array.from(value)
    .slice(0, 200 - suffix.length)
    .join('')}${suffix}`;
}
function validUsername(value: string): string {
  const name = value.trim();
  if (!name || name.includes('\0') || Array.from(name).length > 255)
    throw new EasySshError('VALIDATION', 'Username is required.');
  return name;
}
function validHost(value: string): string {
  const host = value.trim();
  if (
    !host ||
    Array.from(host).length > 1024 ||
    host.includes('\0') ||
    /:\/\//.test(host) ||
    /@/.test(host) ||
    /\s/.test(host)
  )
    throw new EasySshError('VALIDATION', 'Enter a hostname or IP address without URI credentials.');
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) return literal;
  const dns = host.endsWith('.') ? host.slice(0, -1) : host;
  if (
    dns.length > 253 ||
    !dns.split('.').every((label) => /^(?!-)[a-z\d-]{1,63}(?<!-)$/i.test(label))
  )
    throw new EasySshError('VALIDATION', 'Enter a valid DNS hostname, IPv4, or IPv6 address.');
  return host;
}
function validRemotePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0'))
    throw new EasySshError('VALIDATION', 'Remote path must be an absolute POSIX path.');
  const normalized: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join('/')}`;
}

function normalizedAuthentication(
  value: Authentication,
  previous?: Authentication,
): Authentication {
  if (value.type === 'agent') return { type: 'agent' };
  if (value.type === 'password') {
    return {
      type: 'password',
      hasStoredPassword: previous?.type === 'password' ? previous.hasStoredPassword : false,
    };
  }
  const privateKeyPath = value.privateKeyPath.trim();
  if (!privateKeyPath || privateKeyPath.includes('\0'))
    throw new EasySshError('VALIDATION', 'A private-key path is required.');
  return {
    type: 'privateKey',
    privateKeyPath,
    hasStoredPassphrase: previous?.type === 'privateKey' ? previous.hasStoredPassphrase : false,
  };
}

function validAgentAccess(value: RemoteConnection['agentAccess']): RemoteConnection['agentAccess'] {
  const roots = [
    ...new Set(
      value.allowedRoots.map((root) => {
        if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0'))
          throw new EasySshError('VALIDATION', 'Agent roots must be absolute POSIX paths.');
        return validRemotePath(root).replace(/\/$/, '') || '/';
      }),
    ),
  ];
  if (value.allowInteractiveShell !== false)
    throw new EasySshError('VALIDATION', 'Interactive agent shells are not permitted.');
  if (!['always', 'destructive', 'never'].includes(value.confirmationMode))
    throw new EasySshError('VALIDATION', 'Invalid agent confirmation mode.');
  if (value.enabled && (value.allowReadFiles || value.allowWriteFiles) && roots.length === 0)
    throw new EasySshError('VALIDATION', 'File access requires at least one allowed root.');
  return { ...structuredClone(value), allowedRoots: roots, allowInteractiveShell: false };
}

function validOptions(value: RemoteConnection['options']): RemoteConnection['options'] {
  const result: RemoteConnection['options'] = {};
  if (value.keepAliveIntervalMs !== undefined)
    result.keepAliveIntervalMs = validInteger(
      value.keepAliveIntervalMs,
      0,
      300_000,
      'Keepalive interval',
    );
  if (value.readyTimeoutMs !== undefined)
    result.readyTimeoutMs = validInteger(value.readyTimeoutMs, 1_000, 120_000, 'Ready timeout');
  return result;
}

function validInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new EasySshError('VALIDATION', `${label} must be between ${min} and ${max}.`);
  return value;
}
function required<T>(value: T | undefined, kind: string): T {
  if (!value) throw new EasySshError('NOT_FOUND', `${kind} was not found.`);
  return value;
}
function siblings<T extends { order: number }>(
  items: T[],
  parent: string | null,
  getter?: (item: T) => string | null,
): T[] {
  const parentOf = getter ?? ((item: T) => (item as unknown as ConnectionFolder).parentId);
  return items.filter((item) => parentOf(item) === parent).sort(byOrder);
}
function byOrder<T extends { order: number }>(a: T, b: T): number {
  return a.order - b.order;
}
function compact<T extends { order: number; updatedAt?: number }>(
  items: T[],
  now?: () => number,
): void {
  items.sort(byOrder).forEach((item, index) => {
    if (item.order !== index) {
      item.order = index;
      if (now && item.updatedAt !== undefined) item.updatedAt = now();
    }
  });
}
function moveInArray<T extends { id: string; order: number; updatedAt: number }>(
  items: T[],
  item: T,
  parent: string | null,
  beforeId: string | undefined,
  getParent: (item: T) => string | null,
  now: () => number,
): void {
  compact(siblings(items, getParent(item), getParent), now);
  const sourceIndex = items.indexOf(item);
  items.splice(sourceIndex, 1);
  compact(siblings(items, getParent(item), getParent), now);
  if ('folderId' in item) (item as T & { folderId: string | null }).folderId = parent;
  else (item as T & { parentId: string | null }).parentId = parent;
  const targets = siblings(items, parent, getParent);
  const index = beforeId ? targets.findIndex((target) => target.id === beforeId) : -1;
  const insertionIndex = index < 0 ? targets.length : index;
  for (const target of targets) {
    if (target.order >= insertionIndex) target.order += 1;
  }
  item.order = insertionIndex;
  item.updatedAt = now();
  items.push(item);
  compact(siblings(items, parent, getParent), now);
}
