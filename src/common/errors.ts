export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_DIRECTORY'
  | 'IS_DIRECTORY'
  | 'UNSUPPORTED'
  | 'REMOTE_IO'
  | 'CONFLICT'
  | 'NETWORK'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_KEY'
  | 'AUTHENTICATION'
  | 'HOST_KEY_REJECTED'
  | 'HOST_KEY_MISMATCH'
  | 'CHANNEL_REJECTED'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'CONNECTION_LOST'
  | 'CANCELLED'
  | 'OUTPUT_LIMIT'
  | 'WORKSPACE_UNTRUSTED';

export class EasySshError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EasySshError';
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof EasySshError
    ? error.code === 'CANCELLED'
    : error instanceof Error && error.name === 'CancellationError';
}
