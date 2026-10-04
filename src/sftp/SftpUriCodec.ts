import { posix } from 'node:path';
import type * as vscode from 'vscode';

import { EasySshError } from '../common/errors';
import type { ConnectionId } from '../connections/types';
import type { ParsedSftpUri, SftpUriCodec } from './ports';

export const SFTP_URI_SCHEME = 'remote-sftp';

const CANONICAL_V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SftpUriComponents {
  readonly scheme: string;
  readonly authority?: string;
  readonly path?: string;
  readonly query?: string;
  readonly fragment?: string;
}

export interface SftpUriFactory {
  from(components: SftpUriComponents): vscode.Uri;
}

/**
 * Converts between persisted connection ids/remote POSIX paths and opaque VS Code URIs.
 * The factory dependency keeps URI construction testable without loading the VS Code host.
 */
export class DefaultSftpUriCodec implements SftpUriCodec {
  constructor(
    private readonly uriFactory: SftpUriFactory,
    private readonly isKnownConnection: (connectionId: ConnectionId) => boolean,
  ) {}

  create(connectionId: ConnectionId, remotePath: string): vscode.Uri {
    this.assertKnownConnection(connectionId);
    return this.uriFactory.from({
      scheme: SFTP_URI_SCHEME,
      authority: connectionId,
      path: normalizeRemotePath(remotePath),
    });
  }

  parse(uri: vscode.Uri): ParsedSftpUri {
    if (uri.scheme !== SFTP_URI_SCHEME) invalidUri('scheme');
    if (uri.query.length > 0) invalidUri('query');
    if (uri.fragment.length > 0) invalidUri('fragment');
    if (uri.authority.includes('@')) invalidUri('userinfo');
    this.assertKnownConnection(uri.authority);

    return {
      connectionId: uri.authority,
      remotePath: normalizeRemotePath(uri.path),
    };
  }

  private assertKnownConnection(connectionId: string): asserts connectionId is ConnectionId {
    if (!CANONICAL_V4_UUID.test(connectionId)) invalidUri('connection id');
    if (!this.isKnownConnection(connectionId)) {
      throw new EasySshError(
        'NOT_FOUND',
        `The remote SFTP connection '${connectionId}' does not exist.`,
      );
    }
  }
}

/** Normalize an absolute remote path without ever applying local-platform path rules. */
export function normalizeRemotePath(remotePath: string): string {
  if (typeof remotePath !== 'string' || !posix.isAbsolute(remotePath)) {
    throw new EasySshError('VALIDATION', 'Remote SFTP paths must be absolute POSIX paths.');
  }
  if (remotePath.includes('\0')) {
    throw new EasySshError('VALIDATION', 'Remote SFTP paths cannot contain NUL bytes.');
  }
  assertValidUnicode(remotePath);

  const segments: string[] = [];
  for (const segment of remotePath.split(posix.sep)) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new EasySshError(
          'VALIDATION',
          'Remote SFTP path traversal cannot escape the filesystem root.',
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length === 0 ? posix.sep : posix.join(posix.sep, ...segments);
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) invalidPathUnicode();
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalidPathUnicode();
    }
  }
}

function invalidPathUnicode(): never {
  throw new EasySshError('VALIDATION', 'Remote SFTP paths must contain valid Unicode.');
}

function invalidUri(component: string): never {
  throw new EasySshError('VALIDATION', `Invalid remote SFTP URI ${component}.`);
}
