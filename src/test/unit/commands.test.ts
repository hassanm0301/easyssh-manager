import { describe, expect, it } from 'vitest';

import { CommandRegistry, type CommandHost } from '../../commands/CommandRegistry';
import { EasySshError } from '../../common/errors';
import { EasySshLogger } from '../../common/logger';

function createHost(): {
  host: CommandHost;
  invoke: () => Promise<unknown>;
  errors: string[];
  infos: string[];
} {
  let callback: (() => Promise<unknown>) | undefined;
  const errors: string[] = [];
  const infos: string[] = [];
  return {
    host: {
      registerCommand: (_id, registered) => {
        callback = () => registered();
        return { dispose: () => undefined };
      },
      showErrorMessage: (message) => {
        errors.push(message);
        return Promise.resolve(undefined);
      },
      showInformationMessage: (message) => {
        infos.push(message);
        return Promise.resolve(undefined);
      },
    },
    invoke: async () => callback?.(),
    errors,
    infos,
  };
}

describe('CommandRegistry', () => {
  it('maps domain, cancellation, and unknown failures to one safe notification', async () => {
    const channel = { appendLine: () => undefined, dispose: () => undefined };
    for (const [failure, expected] of [
      [new EasySshError('VALIDATION', 'Choose a connection.'), 'Choose a connection.'],
      [new EasySshError('CANCELLED', 'ignored'), 'Operation cancelled'],
      [new Error('raw protocol detail'), 'An unexpected error occurred'],
    ] as const) {
      const fixture = createHost();
      const registry = new CommandRegistry(
        fixture.host,
        new EasySshLogger(channel, () => 'debug'),
        () => 'ref-1',
      );
      registry.register({
        id: 'easysshManager.test',
        execute: async () => {
          throw failure;
        },
      });
      await fixture.invoke();
      expect([...fixture.errors, ...fixture.infos]).toHaveLength(1);
      expect([...fixture.errors, ...fixture.infos][0]).toContain(expected);
      expect([...fixture.errors, ...fixture.infos][0]).not.toContain('raw protocol detail');
    }
  });
});
