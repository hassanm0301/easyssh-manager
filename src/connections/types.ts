/** Stable connection identifiers are introduced with persisted profiles in Milestone 02. */
export type ConnectionId = string & { readonly __connectionId: unique symbol };

export interface ConnectionSummary {
  readonly id: ConnectionId;
  readonly label: string;
}
