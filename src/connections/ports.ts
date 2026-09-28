import type { ConnectionSummary } from './types';

/** Capability boundary for the future persisted connection service. */
export interface ConnectionRepository {
  list(): Promise<readonly ConnectionSummary[]>;
}
