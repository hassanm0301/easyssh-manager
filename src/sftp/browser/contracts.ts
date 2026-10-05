import { posix } from 'node:path';

import { EasySshError } from '../../common/errors';
import type { RemoteEntryKind } from '../ports';
import { normalizeRemotePath } from '../SftpUriCodec';
import { validateWorkspaceDragPayload, type WorkspaceDragPayload } from '../WorkspaceUploadService';

export const SFTP_PANEL_STATE_VERSION = 2 as const;
export const MAX_REQUEST_ID_LENGTH = 80;
export const MAX_PATH_LENGTH = 4_096;
export const MAX_CHILD_NAME_LENGTH = 255;
export const MAX_DOWNLOAD_PATHS = 100;
export const MAX_HISTORY_ENTRIES = 100;

export type SftpSortKey = 'name' | 'size' | 'mtime';
export type SftpSortDirection = 'asc' | 'desc';
export type SftpColumnKey = 'name' | 'type' | 'size' | 'mtime' | 'path';
export type SftpPane = 'workspace' | 'remote';
export type SftpColumnWidths = Readonly<Record<SftpColumnKey, number>>;

export interface SftpLayoutState {
  readonly paneRatio: number;
  readonly visibleColumns: readonly SftpColumnKey[];
  readonly workspaceColumnWidths: SftpColumnWidths;
  readonly remoteColumnWidths: SftpColumnWidths;
}

export function defaultSftpLayoutState(): SftpLayoutState {
  const widths = { name: 260, type: 110, size: 100, mtime: 180, path: 280 } as const;
  return {
    paneRatio: 0.4,
    visibleColumns: ['name', 'size', 'mtime'],
    workspaceColumnWidths: { ...widths },
    remoteColumnWidths: { ...widths },
  };
}

/** Persisted panel state intentionally contains only navigation/display metadata. */
export interface SftpPanelState {
  readonly version: typeof SFTP_PANEL_STATE_VERSION;
  readonly connectionId: string;
  readonly currentPath: string;
  readonly historyBack: readonly string[];
  readonly historyForward: readonly string[];
  readonly sort: { readonly key: SftpSortKey; readonly direction: SftpSortDirection };
  readonly layout: SftpLayoutState;
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
  | { readonly requestId: string; readonly type: 'ready' }
  | {
      readonly requestId: string;
      readonly type: 'list';
      readonly path: string;
      readonly force: boolean;
    }
  | { readonly requestId: string; readonly type: 'navigate'; readonly path: string }
  | { readonly requestId: string; readonly type: 'navigateInput'; readonly value: string }
  | {
      readonly requestId: string;
      readonly type: 'remoteExpand';
      readonly path: string;
      readonly force: boolean;
    }
  | { readonly requestId: string; readonly type: 'remoteSuggest'; readonly value: string }
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
  | { readonly requestId: string; readonly type: 'workspaceRefresh' }
  | { readonly requestId: string; readonly type: 'workspaceExpand'; readonly uri: string }
  | {
      readonly requestId: string;
      readonly type: 'workspaceNavigate';
      readonly target: string;
      readonly input: boolean;
    }
  | { readonly requestId: string; readonly type: 'workspaceBack' }
  | { readonly requestId: string; readonly type: 'workspaceForward' }
  | { readonly requestId: string; readonly type: 'workspaceUp' }
  | { readonly requestId: string; readonly type: 'workspaceOpen'; readonly uri: string }
  | { readonly requestId: string; readonly type: 'workspaceCopyPath'; readonly uri: string }
  | { readonly requestId: string; readonly type: 'workspaceSuggest'; readonly value: string }
  | {
      readonly requestId: string;
      readonly type: 'workspaceSetSort';
      readonly key: SftpSortKey;
      readonly direction: SftpSortDirection;
    }
  | {
      readonly requestId: string;
      readonly type: 'workspaceDrop';
      readonly targetPath: string;
      readonly payload: WorkspaceDragPayload;
    }
  | { readonly requestId: string; readonly type: 'uploadFiles'; readonly targetPath: string }
  | { readonly requestId: string; readonly type: 'uploadFolder'; readonly targetPath: string }
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
    }
  | { readonly requestId: string; readonly type: 'setLayout'; readonly layout: SftpLayoutState };

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
    case 'navigateInput':
    case 'remoteSuggest':
      exactKeys(value, ['requestId', 'type', 'value']);
      return { requestId: value.requestId, type: value.type, value: inputPath(value.value) };
    case 'remoteExpand':
      exactKeys(value, ['requestId', 'type', 'path', 'force']);
      if (typeof value.force !== 'boolean') invalidRequest();
      return {
        requestId: value.requestId,
        type: 'remoteExpand',
        path: requestPath(value.path),
        force: value.force,
      };
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
    case 'workspaceRefresh':
      exactKeys(value, ['requestId', 'type']);
      return { requestId: value.requestId, type: 'workspaceRefresh' };
    case 'workspaceExpand':
      exactKeys(value, ['requestId', 'type', 'uri']);
      if (typeof value.uri !== 'string' || value.uri.length === 0 || value.uri.length > 8_192) {
        invalidRequest();
      }
      return { requestId: value.requestId, type: 'workspaceExpand', uri: value.uri };
    case 'workspaceNavigate':
      exactKeys(value, ['requestId', 'type', 'target', 'input']);
      if (typeof value.input !== 'boolean') invalidRequest();
      return {
        requestId: value.requestId,
        type: 'workspaceNavigate',
        target: inputPath(value.target),
        input: value.input,
      };
    case 'workspaceOpen':
    case 'workspaceCopyPath':
      exactKeys(value, ['requestId', 'type', 'uri']);
      if (typeof value.uri !== 'string' || value.uri.length === 0 || value.uri.length > 8_192) {
        invalidRequest();
      }
      return { requestId: value.requestId, type: value.type, uri: value.uri };
    case 'workspaceSuggest':
      exactKeys(value, ['requestId', 'type', 'value']);
      return {
        requestId: value.requestId,
        type: 'workspaceSuggest',
        value: inputPath(value.value, true),
      };
    case 'workspaceDrop':
      exactKeys(value, ['requestId', 'type', 'targetPath', 'payload']);
      return {
        requestId: value.requestId,
        type: 'workspaceDrop',
        targetPath: requestPath(value.targetPath),
        payload: validateWorkspaceDragPayload(value.payload),
      };
    case 'uploadFiles':
    case 'uploadFolder':
      exactKeys(value, ['requestId', 'type', 'targetPath']);
      return {
        requestId: value.requestId,
        type: value.type,
        targetPath: requestPath(value.targetPath),
      };
    case 'ready':
    case 'back':
    case 'forward':
    case 'up':
    case 'cancel':
      exactKeys(value, ['requestId', 'type']);
      return { requestId: value.requestId, type: value.type };
    case 'workspaceBack':
    case 'workspaceForward':
    case 'workspaceUp':
      exactKeys(value, ['requestId', 'type']);
      return { requestId: value.requestId, type: value.type };
    case 'setSort':
    case 'workspaceSetSort':
      exactKeys(value, ['requestId', 'type', 'key', 'direction']);
      if (!isSortKey(value.key) || !isSortDirection(value.direction)) invalidRequest();
      return {
        requestId: value.requestId,
        type: value.type,
        key: value.key,
        direction: value.direction,
      };
    case 'setLayout':
      exactKeys(value, ['requestId', 'type', 'layout']);
      return {
        requestId: value.requestId,
        type: 'setLayout',
        layout: validateLayout(value.layout),
      };
    default:
      invalidRequest();
  }
}

function inputPath(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > 8_192 ||
    value.includes('\0')
  ) {
    invalidRequest();
  }
  return value;
}

export function validateSftpPanelState(
  value: unknown,
  expectedConnectionId?: string,
): SftpPanelState {
  if (!isExactObject(value))
    throw new EasySshError('VALIDATION', 'Invalid saved SFTP panel state.');
  const legacy = value.version === 1;
  const expectedKeys = legacy
    ? ['version', 'connectionId', 'currentPath', 'historyBack', 'historyForward', 'sort']
    : ['version', 'connectionId', 'currentPath', 'historyBack', 'historyForward', 'sort', 'layout'];
  if (
    !sameKeys(value, expectedKeys) ||
    (!legacy && value.version !== SFTP_PANEL_STATE_VERSION) ||
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
    layout: legacy ? defaultSftpLayoutState() : validateLayout(value.layout),
  };
}

function validateLayout(value: unknown): SftpLayoutState {
  if (
    !isExactObject(value) ||
    !sameKeys(value, [
      'paneRatio',
      'visibleColumns',
      'workspaceColumnWidths',
      'remoteColumnWidths',
    ]) ||
    typeof value.paneRatio !== 'number' ||
    !Number.isFinite(value.paneRatio) ||
    value.paneRatio < 0.2 ||
    value.paneRatio > 0.8 ||
    !Array.isArray(value.visibleColumns) ||
    value.visibleColumns.length === 0 ||
    value.visibleColumns.length > 5 ||
    !value.visibleColumns.every(isColumnKey) ||
    !value.visibleColumns.includes('name') ||
    new Set(value.visibleColumns).size !== value.visibleColumns.length
  ) {
    invalidRequest();
  }
  return {
    paneRatio: value.paneRatio,
    visibleColumns: [...value.visibleColumns],
    workspaceColumnWidths: validateColumnWidths(value.workspaceColumnWidths),
    remoteColumnWidths: validateColumnWidths(value.remoteColumnWidths),
  };
}

function validateColumnWidths(value: unknown): SftpColumnWidths {
  const keys: readonly SftpColumnKey[] = ['name', 'type', 'size', 'mtime', 'path'];
  if (
    !isExactObject(value) ||
    !sameKeys(value, keys) ||
    !keys.every(
      (key) =>
        typeof value[key] === 'number' &&
        Number.isFinite(value[key]) &&
        value[key] >= 64 &&
        value[key] <= 1_200,
    )
  ) {
    invalidRequest();
  }
  return {
    name: value.name as number,
    type: value.type as number,
    size: value.size as number,
    mtime: value.mtime as number,
    path: value.path as number,
  };
}

function isColumnKey(value: unknown): value is SftpColumnKey {
  return (
    value === 'name' ||
    value === 'type' ||
    value === 'size' ||
    value === 'mtime' ||
    value === 'path'
  );
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
