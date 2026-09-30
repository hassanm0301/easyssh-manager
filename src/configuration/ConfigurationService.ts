import type * as vscode from 'vscode';

import { boundedInteger, boundedNumber } from '../common/validation';
import type { LogLevel } from '../common/logger';

export interface EasySshConfiguration {
  connectTimeoutMs: number;
  keepAliveIntervalMs: number;
  keepAliveCountMax: number;
  sftpIdleTimeoutMs: number;
  maxInlineFileSizeMiB: number;
  maxBufferedTransferMiB: number;
  logLevel: LogLevel;
}

export interface ConfigurationService {
  getSnapshot(): Readonly<EasySshConfiguration>;
  readonly onDidChange: vscode.Event<Readonly<EasySshConfiguration>>;
}

export interface ConfigurationReader {
  get<T>(section: string): T | undefined;
}

const defaults: Readonly<EasySshConfiguration> = {
  connectTimeoutMs: 15_000,
  keepAliveIntervalMs: 15_000,
  keepAliveCountMax: 3,
  sftpIdleTimeoutMs: 180_000,
  maxInlineFileSizeMiB: 20,
  maxBufferedTransferMiB: 64,
  logLevel: 'info',
};

export function readConfiguration(reader: ConfigurationReader): Readonly<EasySshConfiguration> {
  const logLevel = reader.get<unknown>('logLevel');
  return Object.freeze({
    connectTimeoutMs: boundedInteger(
      reader.get<unknown>('connectTimeoutMs'),
      defaults.connectTimeoutMs,
      1_000,
      120_000,
    ),
    keepAliveIntervalMs: boundedInteger(
      reader.get<unknown>('keepAliveIntervalMs'),
      defaults.keepAliveIntervalMs,
      0,
      300_000,
    ),
    keepAliveCountMax: boundedInteger(
      reader.get<unknown>('keepAliveCountMax'),
      defaults.keepAliveCountMax,
      1,
      20,
    ),
    sftpIdleTimeoutMs: boundedInteger(
      reader.get<unknown>('sftpIdleTimeoutMs'),
      defaults.sftpIdleTimeoutMs,
      10_000,
      1_800_000,
    ),
    maxInlineFileSizeMiB: boundedNumber(
      reader.get<unknown>('maxInlineFileSizeMiB'),
      defaults.maxInlineFileSizeMiB,
      1,
      1_024,
    ),
    maxBufferedTransferMiB: boundedNumber(
      reader.get<unknown>('maxBufferedTransferMiB'),
      defaults.maxBufferedTransferMiB,
      1,
      2_048,
    ),
    logLevel:
      logLevel === 'error' || logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug'
        ? logLevel
        : defaults.logLevel,
  });
}

export class VsCodeConfigurationService implements ConfigurationService, vscode.Disposable {
  private snapshot: Readonly<EasySshConfiguration>;
  private readonly emitter: vscode.EventEmitter<Readonly<EasySshConfiguration>>;
  readonly onDidChange: vscode.Event<Readonly<EasySshConfiguration>>;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly vscodeApi: typeof vscode) {
    this.snapshot = this.read();
    this.emitter = new vscodeApi.EventEmitter<Readonly<EasySshConfiguration>>();
    this.onDidChange = this.emitter.event;
    this.subscription = vscodeApi.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('easysshManager')) {
        this.snapshot = this.read();
        this.emitter.fire(this.snapshot);
      }
    });
  }

  getSnapshot(): Readonly<EasySshConfiguration> {
    return this.snapshot;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  private read(): Readonly<EasySshConfiguration> {
    return readConfiguration(this.vscodeApi.workspace.getConfiguration('easysshManager'));
  }
}
