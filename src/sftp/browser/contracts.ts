import { posix } from 'node:path';

import { EasySshError } from '../../common/errors';
import type { RemoteEntryKind } from '../ports';
import { normalizeRemotePath } from '../SftpUriCodec';

export const SFTP_PANEL_STATE_VERSION = 1 as const;
export const MAX_REQUEST_ID_LENGTH = 80;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_CHILD_NAME_LENGTH = 255;
export const MAX_DOWNLOAD_PATHS = 100;
export const MAX_HISTORY_ENTRIES = 100;

export type SftpSortKey = 'name' | 'size' | 'mtime';
export type SftpSortDirection = 'asc' | 'desc';

/** Persisted panel state intentionally contains only navigation/display metadata. */
export interface SftpPanelState {
  readonly version: typeof SFTP_PANEL_STATE_VERSION;
  readonly connectionId: string;
  readonly currentPath: string;
  readonly historyBack: readonly string[];
  readonly historyForward: readonly string[];
  readonly sort: { readonly key: SftpSortKey; readonly direction: SftpSortDirection };
}

export interface RemoteEntryView {
  readonly name: string;
  readonly path: string;
  readonly kind: RemoteEntryKind;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly linkTarget?: string;
}

export type SftpRequest =
  | {
      readonly requestId: string;
      readonly type: 'list';
      readonly path: string;
      readonly force: boolean;
    }
  | { readonly requestId: string; readonly type: 'navigate'; readonly path: string }
  | { readonly requestId: string; readonly type: 'open'; readonly path: string }
  | {
      readonly requestId: string;
      readonly type: 'createFile';
      readonly parentPath: string;
      readonly name: string;
    }
  | {
      readonly requestId: string;
      readonly type: 'createDirectory';
      readonly parentPath: string;
      readonly name: string;
    }
  | {
      readonly requestId: string;
      readonly type: 'rename';
      readonly path: string;
      readonly newName: string;
    }
  | { readonly requestId: string; readonly type: 'delete'; readonly path: string }
  | { readonly requestId: string; readonly type: 'download'; readonly paths: readonly string[] }
  | { readonly requestId: string; readonly type: 'copyPath'; readonly path: string }
  | { readonly requestId: string; readonly type: 'back' }
  | { readonly requestId: string; readonly type: 'forward' }
  | { readonly requestId: string; readonly type: 'up' }
  | { readonly requestId: string; readonly type: 'cancel' }
  | {
      readonly requestId: string;
      readonly type: 'setSort';
      readonly key: SftpSortKey;
      readonly direction: SftpSortDirection;
    };

export interface SftpResponse<T> {
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export function validateSftpRequest(value: unknown): SftpRequest {
  if (!isExactObject(value) || !isRequestId(value.requestId) || typeof value.type !== 'string') {
    throw new EasySshError('VALIDATION', 'Invalid SFTP browser request.');
  }
  switch (value.type) {
    case 'list':
      exactKeys(value, ['requestId', 'type', 'path', 'force']);
      if (typeof value.force !== 'boolean') invalidRequest();
      return {
        requestId: value.requestId,
        type: 'list',
        path: requestPath(value.path),
        force: value.force,
      };
    case 'navigate':
    case 'open':
    case 'delete':
    case 'copyPath':
      exactKeys(value, ['requestId', 'type', 'path']);
      return { requestId: value.requestId, type: value.type, path: requestPath(value.path) };
    case 'createFile':
    case 'createDirectory':
      exactKeys(value, ['requestId', 'type', 'parentPath', 'name']);
      return {
        requestId: value.requestId,
        type: value.type,
        parentPath: requestPath(value.parentPath),
        name: validateChildName(value.name),
      };
    case 'rename':
      exactKeys(value, ['requestId', 'type', 'path', 'newName']);
      return {
        requestId: value.requestId,
        type: 'rename',
        path: requestPath(value.path),
        newName: validateChildName(value.newName),
      };
    case 'download':
      exactKeys(value, ['requestId', 'type', 'paths']);
      if (
        !Array.isArray(value.paths) ||
        value.paths.length === 0 ||
        value.paths.length > MAX_DOWNLOAD_PATHS
      ) {
        invalidRequest();
      }
      return {
        requestId: value.requestId,
        type: 'download',
        paths: value.paths.map((path) => requestPath(path)),
      };
    case 'back':
    case 'forward':
    case 'up':
    case 'cancel':
      exactKeys(value, ['requestId', 'type']);
      return { requestId: value.requestId, type: value.type };
    case 'setSort':
      exactKeys(value, ['requestId', 'type', 'key', 'direction']);
      if (!isSortKey(value.key) || !isSortDirection(value.direction)) invalidRequest();
      return {
        requestId: value.requestId,
        type: 'setSort',
        key: value.key,
        direction: value.direction,
      };
    default:
      invalidRequest();
  }
}

export function validateSftpPanelState(
  value: unknown,
  expectedConnectionId?: string,
): SftpPanelState {
  if (!isExactObject(value))
    throw new EasySshError('VALIDATION', 'Invalid saved SFTP panel state.');
  if (
    !sameKeys(value, [
      'version',
      'connectionId',
      'currentPath',
      'historyBack',
      'historyForward',
      'sort',
    ]) ||
    value.version !== SFTP_PANEL_STATE_VERSION ||
    typeof value.connectionId !== 'string' ||
    (expectedConnectionId !== undefined && value.connectionId !== expectedConnectionId) ||
    !Array.isArray(value.historyBack) ||
    !Array.isArray(value.historyForward) ||
    value.historyBack.length > MAX_HISTORY_ENTRIES ||
    value.historyForward.length > MAX_HISTORY_ENTRIES ||
    !isExactObject(value.sort) ||
    !sameKeys(value.sort, ['key', 'direction']) ||
    !isSortKey(value.sort.key) ||
    !isSortDirection(value.sort.direction)
  ) {
    throw new EasySshError('VALIDATION', 'Invalid saved SFTP panel state.');
  }
  return {
    version: SFTP_PANEL_STATE_VERSION,
    connectionId: value.connectionId,
    currentPath: requestPath(value.currentPath),
    historyBack: normalizeHistory(value.historyBack),
    historyForward: normalizeHistory(value.historyForward),
    sort: { key: value.sort.key, direction: value.sort.direction },
  };
}

export function validateChildName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CHILD_NAME_LENGTH ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new EasySshError('VALIDATION', 'Remote child names must be one safe path segment.');
  }
  // Normalization additionally detects malformed surrogate pairs without changing the child value.
  normalizeRemotePath(posix.join('/', value));
  return value;
}

export function isExactObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function sanitizeSftpError(error: unknown): NonNullable<SftpResponse<never>['error']> {
  const known = error instanceof EasySshError ? error : undefined;
  const code = known?.code ?? 'REMOTE_IO';
  const retryable = ['NETWORK', 'CONNECTION_LOST', 'TIMEOUT', 'REMOTE_IO'].includes(code);
  const message =
    known?.message && known.message.length <= 300
      ? known.message
      : 'The remote operation could not be completed.';
  return { code, message, retryable };
}

function requestPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH)
    invalidRequest();
  return normalizeRemotePath(value);
}

function normalizeHistory(values: readonly unknown[]): readonly string[] {
  const normalized: string[] = [];
  for (const value of values) {
    try {
      const path = requestPath(value);
      if (normalized.at(-1) !== path) normalized.push(path);
    } catch {
      // Restoration must tolerate old or corrupt individual entries.
    }
  }
  return normalized.slice(-MAX_HISTORY_ENTRIES);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (!sameKeys(value, keys)) invalidRequest();
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function isSortKey(value: unknown): value is SftpSortKey {
  return value === 'name' || value === 'size' || value === 'mtime';
}

function isSortDirection(value: unknown): value is SftpSortDirection {
  return value === 'asc' || value === 'desc';
}

function invalidRequest(): never {
  throw new EasySshError('VALIDATION', 'Invalid SFTP browser request.');
}
