import type * as vscode from 'vscode';

import { isPlainObject } from './validation';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogFields = Readonly<Record<string, unknown>>;

const levels: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
const forbiddenKey =
  /password|passphrase|privatekey|secret|token|authorization|content|stdout|stderr/i;
const sensitiveOperationalKey = /hostname|username|path|command/i;
const allowedKeys = new Set([
  'correlationId',
  'code',
  'operation',
  'reason',
  'status',
  'attempt',
  'durationMs',
]);

export interface OutputChannel {
  appendLine(value: string): void;
  dispose(): void;
}

/**
 * Redacts only arrays and plain objects. Other prototypes are never traversed,
 * because getters and custom serializers can expose data or throw.
 */
export function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactLogValue);
  }
  if (!isPlainObject(value)) {
    return value !== null && typeof value === 'object' ? '[UNSERIALIZABLE]' : value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = forbiddenKey.test(key) ? '[REDACTED]' : redactLogValue(nested);
  }
  return result;
}

export class EasySshLogger {
  private disposed = false;

  constructor(
    private readonly channel: OutputChannel,
    private readonly getLevel: () => LogLevel,
    private readonly now: () => Date = () => new Date(),
  ) {}

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.channel.dispose();
    } catch {
      // VS Code may already have disposed the output channel during shutdown.
    }
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (this.disposed || levels[level] > levels[this.getLevel()]) {
      return;
    }
    try {
      const safeFields = this.selectFields(level, fields);
      const suffix = Object.keys(safeFields).length > 0 ? ` ${JSON.stringify(safeFields)}` : '';
      this.channel.appendLine(
        `${this.now().toISOString()} [${level.toUpperCase()}] ${message}${suffix}`,
      );
    } catch {
      // Logging is best-effort and must never impact extension behavior.
    }
  }

  private selectFields(level: LogLevel, fields: LogFields | undefined): Record<string, unknown> {
    if (!fields || !isPlainObject(fields)) {
      return {};
    }
    const selected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (forbiddenKey.test(key)) {
        selected[key] = '[REDACTED]';
      } else if (allowedKeys.has(key) || (level === 'debug' && sensitiveOperationalKey.test(key))) {
        selected[key] = redactLogValue(value);
      }
    }
    return selected;
  }
}

export function createVsCodeLogger(
  vscodeApi: typeof vscode,
  getLevel: () => LogLevel,
): EasySshLogger {
  return new EasySshLogger(vscodeApi.window.createOutputChannel('EasySSH Manager'), getLevel);
}
