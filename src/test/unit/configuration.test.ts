import { describe, expect, it } from 'vitest';

import { readConfiguration } from '../../configuration/ConfigurationService';

describe('configuration validation', () => {
  it('uses documented defaults for missing values', () => {
    const configuration = readConfiguration({ get: () => undefined });
    expect(configuration).toEqual({
      connectTimeoutMs: 15000,
      keepAliveIntervalMs: 15000,
      keepAliveCountMax: 3,
      sftpIdleTimeoutMs: 180000,
      maxInlineFileSizeMiB: 20,
      maxBufferedTransferMiB: 64,
      logLevel: 'info',
    });
  });

  it('rejects invalid types and bounds independently', () => {
    const values: Record<string, unknown> = {
      connectTimeoutMs: 999,
      keepAliveIntervalMs: '15000',
      keepAliveCountMax: 21,
      sftpIdleTimeoutMs: 10000.5,
      maxInlineFileSizeMiB: 1025,
      maxBufferedTransferMiB: Number.NaN,
      logLevel: 'verbose',
    };
    const configuration = readConfiguration({
      get: <T>(key: string) => values[key] as T | undefined,
    });
    expect(configuration).toEqual({
      connectTimeoutMs: 15000,
      keepAliveIntervalMs: 15000,
      keepAliveCountMax: 3,
      sftpIdleTimeoutMs: 180000,
      maxInlineFileSizeMiB: 20,
      maxBufferedTransferMiB: 64,
      logLevel: 'info',
    });
  });
});
