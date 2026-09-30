import { EasySshError } from '../common/errors';
import type { StateRepository } from '../connections/ports';
import type { RemoteConnection } from '../connections/types';
import type { ConnectionResolver } from './ports';

/** Resolves a fresh, non-secret snapshot for every transport. */
export class StateConnectionResolver implements ConnectionResolver {
  constructor(private readonly state: StateRepository) {}

  async resolve(connectionId: string): Promise<Readonly<RemoteConnection>> {
    const connection = (await this.state.load()).connections.find(
      (item) => item.id === connectionId,
    );
    if (!connection) throw new EasySshError('NOT_FOUND', 'Connection was not found.');
    return Object.freeze(structuredClone(connection));
  }
}
