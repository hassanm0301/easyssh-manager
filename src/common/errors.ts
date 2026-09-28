export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AUTHENTICATION'
  | 'HOST_KEY_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'CONNECTION_LOST'
  | 'CANCELLED'
  | 'OUTPUT_LIMIT';

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
