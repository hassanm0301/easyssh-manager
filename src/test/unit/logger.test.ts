import { describe, expect, it } from 'vitest';

import { EasySshLogger, redactLogValue } from '../../common/logger';

describe('EasySshLogger', () => {
  it('redacts forbidden keys recursively and never emits a sentinel secret', () => {
    const sentinel = 'do-not-log-this-secret';
    const output: string[] = [];
    const logger = new EasySshLogger(
      { appendLine: (line) => output.push(line), dispose: () => undefined },
      () => 'debug',
    );
    logger.debug('attempt', {
      correlationId: 'abc',
      password: sentinel,
      hostname: 'test.example',
      ignored: { token: sentinel },
    });
    const value = redactLogValue({ nested: [{ authorization: sentinel }], safe: 'ok' });
    expect(value).toEqual({ nested: [{ authorization: '[REDACTED]' }], safe: 'ok' });
    expect(output.join('\n')).not.toContain(sentinel);
    expect(output.join('\n')).toContain('[REDACTED]');
  });

  it('does not traverse arbitrary prototypes and tolerates output disposal', () => {
    const prototype = {
      get secret() {
        throw new Error('should not run');
      },
    };
    const arbitrary = Object.create(prototype) as object;
    expect(redactLogValue(arbitrary)).toBe('[UNSERIALIZABLE]');
    const logger = new EasySshLogger(
      {
        appendLine: () => {
          throw new Error('disposed');
        },
        dispose: () => {
          throw new Error('disposed');
        },
      },
      () => 'info',
    );
    expect(() => logger.info('safe', { correlationId: 'a' })).not.toThrow();
    expect(() => logger.dispose()).not.toThrow();
  });
});
