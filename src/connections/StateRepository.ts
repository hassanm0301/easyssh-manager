import * as vscode from 'vscode';
import { isIP } from 'node:net';

import { EasySshError } from '../common/errors';
import { isPlainObject } from '../common/validation';
import type { StateChange, StateRepository as StateRepositoryPort } from './ports';
import {
  defaultAgentAccessPolicy,
  emptyPersistedState,
  type Authentication,
  type ConnectionFolder,
  type PersistedStateV1,
  type RemoteConnection,
} from './types';

export const STATE_KEY = 'easysshManager.state';
const RECOVERY_PREFIX = 'easysshManager.state.recovery.';

export interface GlobalState {
  get<T>(section: string): T | undefined;
  update(section: string, value: unknown): Thenable<void>;
}

export interface StateNotifier {
  error(message: string): Thenable<unknown>;
}

/** A single-envelope, serialised state store. It intentionally has no secret dependency. */
export class VsCodeStateRepository implements StateRepositoryPort, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<StateChange>();
  private pending: Promise<void> = Promise.resolve();
  private cached: PersistedStateV1 | undefined;
  private warnedCorruption = false;

  readonly onDidChange = this.changes.event;

  constructor(
    private readonly globalState: GlobalState,
    private readonly notifier: StateNotifier = { error: () => Promise.resolve(undefined) },
  ) {}

  async load(): Promise<Readonly<PersistedStateV1>> {
    if (this.cached) return freezeCopy(this.cached);
    const raw = this.globalState.get<unknown>(STATE_KEY);
    if (raw === undefined) {
      const empty = emptyPersistedState();
      await this.globalState.update(STATE_KEY, empty);
      this.cached = empty;
      return freezeCopy(this.cached);
    }
    let migrated: unknown;
    let validated: PersistedStateV1;
    try {
      migrated = migratePersistedState(raw);
      validated = validatePersistedState(migrated);
    } catch (error) {
      if (error instanceof FutureSchemaError) throw error;
      const recoveryKey = `${RECOVERY_PREFIX}${Date.now()}`;
      await this.globalState.update(recoveryKey, raw);
      const empty = emptyPersistedState();
      await this.globalState.update(STATE_KEY, empty);
      this.cached = empty;
      if (!this.warnedCorruption) {
        this.warnedCorruption = true;
        void this.notifier.error(
          'EasySSH Manager recovered malformed connection data. A recovery snapshot was retained in extension storage.',
        );
      }
      return freezeCopy(this.cached);
    }
    if (migrated !== raw || JSON.stringify(migrated) !== JSON.stringify(validated))
      await this.globalState.update(STATE_KEY, validated);
    this.cached = validated;
    return freezeCopy(this.cached);
  }

  update(mutator: (draft: PersistedStateV1) => void): Promise<void> {
    const operation = async (): Promise<void> => {
      const previous = clone(await this.load());
      const draft = clone(previous);
      mutator(draft);
      const next = validatePersistedState(draft);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      await this.globalState.update(STATE_KEY, next);
      this.cached = next;
      this.changes.fire({ previous: freezeCopy(previous), current: freezeCopy(next) });
    };
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  dispose(): void {
    this.changes.dispose();
  }
}

export class FutureSchemaError extends EasySshError {
  constructor(version: unknown) {
    super(
      'CONFLICT',
      `Connection data was created by a newer EasySSH Manager version (schema ${String(version)}). Back up or downgrade before continuing.`,
    );
  }
}

/** Runtime schema used for both globalState reads and writes. */
export function validatePersistedState(value: unknown): PersistedStateV1 {
  if (!isPlainObject(value))
    throw new EasySshError('VALIDATION', 'Stored connection data is not an object.');
  if (typeof value.schemaVersion === 'number' && value.schemaVersion > 1) {
    throw new FutureSchemaError(value.schemaVersion);
  }
  if (value.schemaVersion !== 1)
    throw new EasySshError('VALIDATION', 'Unsupported connection data schema.');
  exactKeys(
    value,
    ['schemaVersion', 'connections', 'folders', 'hostKeys', 'uiPreferences'],
    'state',
  );
  const connections = array(value.connections, 'connections').map(validateConnection);
  const folders = array(value.folders, 'folders').map(validateFolder);
  const hostKeys = array(value.hostKeys, 'hostKeys').map(validateHostKey);
  const uiPreferences = validateUiPreferences(value.uiPreferences);
  validateHierarchy(connections, folders);
  if (uiPreferences.expandedFolderIds.some((id) => !folders.some((folder) => folder.id === id)))
    invalid('expanded folder id');
  return { schemaVersion: 1, connections, folders, hostKeys, uiPreferences };
}

/** Pure sequential migration boundary. Version zero was never released, but keeping it here
 * makes state evolution explicit and prevents migrations from ever touching SecretStorage. */
export function migratePersistedState(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if (typeof value.schemaVersion === 'number' && value.schemaVersion > 1) {
    throw new FutureSchemaError(value.schemaVersion);
  }
  let current: unknown = value;
  while (isPlainObject(current) && current.schemaVersion !== 1) {
    if (current.schemaVersion === 0) current = migrateV0ToV1(current);
    else return current;
  }
  return current;
}

export function migrateV0ToV1(value: Record<string, unknown>): PersistedStateV1 {
  return {
    schemaVersion: 1,
    connections: Array.isArray(value.connections) ? value.connections : [],
    folders: Array.isArray(value.folders) ? value.folders : [],
    hostKeys: Array.isArray(value.hostKeys) ? value.hostKeys : [],
    uiPreferences: isPlainObject(value.uiPreferences)
      ? (value.uiPreferences as unknown as PersistedStateV1['uiPreferences'])
      : { expandedFolderIds: [] },
  } as PersistedStateV1;
}

function validateConnection(value: unknown): RemoteConnection {
  if (!isPlainObject(value)) invalid('connection');
  exactKeys(
    value,
    [
      'id',
      'name',
      'folderId',
      'order',
      'host',
      'port',
      'username',
      'defaultRemotePath',
      'authentication',
      'importedFromSshConfig',
      'agentAccess',
      'options',
      'createdAt',
      'updatedAt',
    ],
    'connection fields',
  );
  const authentication = validateAuthentication(value.authentication);
  const options = isPlainObject(value.options) ? value.options : invalid('connection options');
  const connection: RemoteConnection = {
    id: uuid(value.id, 'connection id'),
    name: nonEmpty(value.name, 'connection name', 200),
    folderId: nullableUuid(value.folderId, 'folder id'),
    order: nonNegativeInteger(value.order, 'connection order'),
    host: host(value.host),
    port: integer(value.port, 'port', 1, 65535),
    username: nonEmpty(value.username, 'username', 255),
    defaultRemotePath: posixPath(value.defaultRemotePath),
    authentication,
    agentAccess: validateAgentAccess(value.agentAccess),
    options: validatedOptions(options),
    createdAt: nonNegativeInteger(value.createdAt, 'createdAt'),
    updatedAt: nonNegativeInteger(value.updatedAt, 'updatedAt'),
  };
  if (value.importedFromSshConfig !== undefined) {
    if (!isPlainObject(value.importedFromSshConfig)) invalid('import provenance');
    exactKeys(value.importedFromSshConfig, ['sourcePath', 'hostPattern'], 'import provenance');
    connection.importedFromSshConfig = {
      sourcePath: nonNulString(value.importedFromSshConfig.sourcePath, 'source path'),
      hostPattern: nonNulString(value.importedFromSshConfig.hostPattern, 'host pattern'),
    };
  }
  return connection;
}

function validateFolder(value: unknown): ConnectionFolder {
  if (!isPlainObject(value)) invalid('folder');
  exactKeys(value, ['id', 'name', 'parentId', 'order', 'createdAt', 'updatedAt'], 'folder fields');
  return {
    id: uuid(value.id, 'folder id'),
    name: nonEmpty(value.name, 'folder name', 200),
    parentId: nullableUuid(value.parentId, 'folder parent id'),
    order: nonNegativeInteger(value.order, 'folder order'),
    createdAt: nonNegativeInteger(value.createdAt, 'folder createdAt'),
    updatedAt: nonNegativeInteger(value.updatedAt, 'folder updatedAt'),
  };
}

function validateAuthentication(value: unknown): Authentication {
  if (!isPlainObject(value) || typeof value.type !== 'string') invalid('authentication');
  if (value.type === 'password' && typeof value.hasStoredPassword === 'boolean') {
    exactKeys(value, ['type', 'hasStoredPassword'], 'password authentication');
    return { type: 'password', hasStoredPassword: value.hasStoredPassword };
  }
  if (
    value.type === 'privateKey' &&
    typeof value.privateKeyPath === 'string' &&
    value.privateKeyPath.trim().length > 0 &&
    !value.privateKeyPath.includes('\0') &&
    typeof value.hasStoredPassphrase === 'boolean'
  ) {
    exactKeys(
      value,
      ['type', 'privateKeyPath', 'hasStoredPassphrase'],
      'private-key authentication',
    );
    return {
      type: 'privateKey',
      privateKeyPath: value.privateKeyPath,
      hasStoredPassphrase: value.hasStoredPassphrase,
    };
  }
  if (value.type === 'agent') {
    exactKeys(value, ['type'], 'agent authentication');
    return { type: 'agent' };
  }
  return invalid('authentication');
}

function validateAgentAccess(value: unknown) {
  if (!isPlainObject(value)) invalid('agent access');
  exactKeys(
    value,
    [
      'enabled',
      'allowReadFiles',
      'allowWriteFiles',
      'allowExec',
      'allowInteractiveShell',
      'confirmationMode',
      'allowedRoots',
    ],
    'agent access fields',
  );
  const policy = defaultAgentAccessPolicy();
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.allowReadFiles !== 'boolean' ||
    typeof value.allowWriteFiles !== 'boolean' ||
    typeof value.allowExec !== 'boolean' ||
    value.allowInteractiveShell !== false ||
    !['always', 'destructive', 'never'].includes(String(value.confirmationMode))
  )
    invalid('agent access');
  policy.enabled = value.enabled;
  policy.allowReadFiles = value.allowReadFiles;
  policy.allowWriteFiles = value.allowWriteFiles;
  policy.allowExec = value.allowExec;
  policy.confirmationMode = value.confirmationMode as typeof policy.confirmationMode;
  policy.allowedRoots = [
    ...new Set(array(value.allowedRoots, 'allowed roots').map((root) => normalizedRoot(root))),
  ];
  if (
    policy.enabled &&
    (policy.allowReadFiles || policy.allowWriteFiles) &&
    policy.allowedRoots.length === 0
  ) {
    invalid('agent access roots');
  }
  return policy;
}

function validateHostKey(value: unknown) {
  if (!isPlainObject(value)) invalid('host key');
  // Milestone 02 briefly emitted the legacy shape. Canonicalize it on load without
  // changing the envelope version because no released schema consumed host keys.
  if (
    Object.keys(value).every((key) =>
      ['host', 'port', 'algorithm', 'fingerprint', 'addedAt'].includes(key),
    ) &&
    typeof value.host === 'string' &&
    typeof value.port === 'number'
  ) {
    const addedAt = nonNegativeInteger(value.addedAt, 'host key addedAt');
    const fingerprint = nonEmpty(value.fingerprint, 'host key fingerprint', 1024);
    if (!/^SHA256:[A-Za-z\d+/]{43}$/.test(fingerprint)) invalid('host key fingerprint');
    return {
      hostIdentity: `${value.host.toLowerCase()}:${integer(value.port, 'host key port', 1, 65535)}`,
      algorithm: nonEmpty(value.algorithm, 'host key algorithm', 100),
      sha256Fingerprint: fingerprint,
      firstTrustedAt: addedAt,
      lastSeenAt: addedAt,
    };
  }
  exactKeys(
    value,
    ['hostIdentity', 'algorithm', 'sha256Fingerprint', 'firstTrustedAt', 'lastSeenAt'],
    'host key fields',
  );
  const fingerprint = nonEmpty(value.sha256Fingerprint, 'host key fingerprint', 1024);
  if (!/^SHA256:[A-Za-z\d+/]{43}$/.test(fingerprint)) invalid('host key fingerprint');
  const firstTrustedAt = nonNegativeInteger(value.firstTrustedAt, 'host key firstTrustedAt');
  const lastSeenAt = nonNegativeInteger(value.lastSeenAt, 'host key lastSeenAt');
  if (lastSeenAt < firstTrustedAt) invalid('host key timestamps');
  return {
    hostIdentity: nonEmpty(value.hostIdentity, 'host identity', 1100),
    algorithm: nonEmpty(value.algorithm, 'host key algorithm', 100),
    sha256Fingerprint: fingerprint,
    firstTrustedAt,
    lastSeenAt,
  };
}

function validateUiPreferences(value: unknown) {
  if (!isPlainObject(value)) invalid('ui preferences');
  exactKeys(value, ['expandedFolderIds'], 'ui preference fields');
  return {
    expandedFolderIds: [
      ...new Set(
        array(value.expandedFolderIds, 'expanded folders').map((id) => uuid(id, 'folder id')),
      ),
    ],
  };
}

function validateHierarchy(connections: RemoteConnection[], folders: ConnectionFolder[]): void {
  const ids = new Set<string>();
  for (const folder of folders) {
    if (ids.has(folder.id)) invalid('duplicate folder id');
    ids.add(folder.id);
    if (
      folder.parentId !== null &&
      !ids.has(folder.parentId) &&
      !folders.some((candidate) => candidate.id === folder.parentId)
    )
      invalid('folder parent');
  }
  for (const folder of folders) {
    const visited = new Set<string>();
    for (
      let current: string | null = folder.id;
      current !== null;
      current = folders.find((item) => item.id === current)?.parentId ?? null
    ) {
      if (visited.has(current)) invalid('folder cycle');
      visited.add(current);
    }
  }
  const connectionIds = new Set<string>();
  for (const connection of connections) {
    if (connectionIds.has(connection.id) || ids.has(connection.id))
      invalid('duplicate connection id');
    connectionIds.add(connection.id);
    if (connection.folderId !== null && !ids.has(connection.folderId)) invalid('connection folder');
  }
  for (const [parent, items] of groupByParent(folders))
    assertGapless(
      items.map((item) => item.order),
      `folder order at ${parent}`,
    );
  for (const [parent, items] of groupByParent(connections, (item) => item.folderId))
    assertGapless(
      items.map((item) => item.order),
      `connection order at ${parent}`,
    );
}

function validatedOptions(options: Record<string, unknown>): RemoteConnection['options'] {
  exactKeys(
    options,
    ['keepAliveIntervalMs', 'keepAliveCountMax', 'readyTimeoutMs'],
    'connection option fields',
  );
  const keepAliveIntervalMs = optionalInteger(
    options.keepAliveIntervalMs,
    'keepAliveIntervalMs',
    0,
    300000,
  );
  const readyTimeoutMs = optionalInteger(options.readyTimeoutMs, 'readyTimeoutMs', 1000, 120000);
  const keepAliveCountMax = optionalInteger(options.keepAliveCountMax, 'keepAliveCountMax', 1, 20);
  return {
    ...(keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs }),
    ...(keepAliveCountMax === undefined ? {} : { keepAliveCountMax }),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
  };
}
function groupByParent<T extends { order: number }>(
  items: T[],
  parent?: (item: T) => string | null,
) {
  const parentOf = parent ?? ((item: T) => (item as unknown as ConnectionFolder).parentId);
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const key = parentOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
function assertGapless(orders: number[], label: string): void {
  if (orders.sort((a, b) => a - b).some((order, index) => order !== index)) invalid(label);
}
function array(value: unknown, label: string): unknown[] {
  return Array.isArray(value) ? value : invalid(label);
}
function string(value: unknown, label: string): string {
  return typeof value === 'string' ? value : invalid(label);
}
function uuid(value: unknown, label: string): string {
  const id = string(value, label);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : invalid(label);
}
function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}
function nonNulString(value: unknown, label: string): string {
  const result = string(value, label);
  return result.includes('\0') ? invalid(label) : result;
}
function nonEmpty(value: unknown, label: string, max: number): string {
  const text = string(value, label).trim();
  return text.length > 0 && Array.from(text).length <= max && !text.includes('\0')
    ? text
    : invalid(label);
}
function integer(value: unknown, label: string, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : invalid(label);
}
function nonNegativeInteger(value: unknown, label: string): number {
  return integer(value, label, 0, Number.MAX_SAFE_INTEGER);
}
function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  return value === undefined ? undefined : integer(value, label, min, max);
}
function posixPath(value: unknown): string {
  const path = nonEmpty(value, 'remote path', 4096);
  if (!path.startsWith('/') || path.includes('\0')) return invalid('remote path');
  const normalized: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join('/')}`;
}
function host(value: unknown): string {
  const result = nonEmpty(value, 'host', 1024);
  if (result.includes('@') || result.includes('://') || /\s/.test(result)) return invalid('host');
  const literal = result.startsWith('[') && result.endsWith(']') ? result.slice(1, -1) : result;
  if (isIP(literal) !== 0) return literal;
  const dns = result.endsWith('.') ? result.slice(0, -1) : result;
  return dns.length <= 253 &&
    dns.split('.').every((label) => /^(?!-)[a-z\d-]{1,63}(?<!-)$/i.test(label))
    ? result
    : invalid('host');
}
function normalizedRoot(value: unknown): string {
  const path = posixPath(value).replace(/\/$/, '') || '/';
  return path;
}
function invalid(label: string): never {
  throw new EasySshError('VALIDATION', `Invalid persisted ${label}.`);
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(label);
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function freezeCopy<T>(value: T): Readonly<T> {
  return deepFreeze(clone(value));
}
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
