import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class {
    id?: string;
    contextValue?: string;
    description?: string;
    tooltip?: string;
    iconPath?: unknown;
    accessibilityInformation?: unknown;
    command?: unknown;
    constructor(
      readonly label: string,
      readonly collapsibleState: number,
    ) {}
  },
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
  DataTransferItem: class {
    constructor(readonly value: unknown) {}
  },
  EventEmitter: class<T> {
    private readonly listeners: ((value: T) => unknown)[] = [];
    readonly event = (listener: (value: T) => unknown) => {
      this.listeners.push(listener);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    };
    fire(value: T): void {
      for (const listener of [...this.listeners]) listener(value);
    }
    dispose(): void {
      this.listeners.length = 0;
    }
  },
}));

import type { StateChange, StateRepository } from '../../connections/ports';
import {
  defaultAgentAccessPolicy,
  emptyPersistedState,
  type PersistedStateV1,
} from '../../connections/types';
import {
  ConnectionNode,
  ConnectionsTreeProvider,
  FolderNode,
} from '../../views/connections/ConnectionsTreeProvider';

const folder = {
  id: 'folder',
  name: 'Folder',
  parentId: null,
  order: 0,
  createdAt: 1,
  updatedAt: 1,
};
const connection = {
  id: 'connection',
  name: 'Server',
  folderId: 'folder',
  order: 0,
  host: 'server.test',
  port: 22,
  username: 'user',
  defaultRemotePath: '/',
  authentication: { type: 'password' as const, hasStoredPassword: true },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
  createdAt: 1,
  updatedAt: 1,
};

class StateFake implements StateRepository {
  constructor(readonly value: PersistedStateV1) {}
  readonly onDidChange = () => ({ dispose: () => undefined });
  async load(): Promise<Readonly<PersistedStateV1>> {
    return structuredClone(this.value);
  }
  async update(): Promise<void> {}
}

describe('ConnectionsTreeProvider', () => {
  it('renders ordered metadata-only folders and connections with accessible actions', async () => {
    const value = emptyPersistedState();
    value.folders.push(folder);
    value.connections.push(connection, { ...connection, id: 'root', folderId: null, order: 0 });
    value.uiPreferences.expandedFolderIds.push(folder.id);
    const provider = new ConnectionsTreeProvider(new StateFake(value));

    const root = await provider.getChildren();
    expect(root).toHaveLength(2);
    expect(root[0]).toBeInstanceOf(FolderNode);
    expect(root[1]).toBeInstanceOf(ConnectionNode);
    expect(root[0]?.collapsibleState).toBe(2);
    expect(root[1]?.accessibilityInformation).toMatchObject({ role: 'treeitem' });
    expect(JSON.stringify(root)).not.toContain('SENTINEL_SECRET');

    const nested = await provider.getChildren(root[0]);
    expect(nested.map((item) => item.label)).toEqual(['Server']);
  });

  it('refreshes only a changed item or its affected parent using stable node identities', async () => {
    const value = emptyPersistedState();
    value.folders.push(folder);
    value.connections.push(connection);
    const provider = new ConnectionsTreeProvider(new StateFake(value));
    const cachedFolder = (await provider.getChildren())[0];
    const cachedConnection = (await provider.getChildren(cachedFolder))[0];
    const events: (FolderNode | ConnectionNode | undefined)[] = [];
    provider.onDidChangeTreeData((event) => events.push(event));

    const renamed: StateChange = {
      previous: structuredClone(value),
      current: {
        ...structuredClone(value),
        connections: [{ ...connection, name: 'Renamed', updatedAt: 2 }],
      },
    };
    provider.refresh(renamed);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(cachedConnection);
    expect(events[0]?.label).toBe('Renamed');

    events.length = 0;
    const added: StateChange = {
      previous: structuredClone(value),
      current: {
        ...structuredClone(value),
        connections: [connection, { ...connection, id: 'second', order: 1 }],
      },
    };
    provider.refresh(added);
    expect(events).toHaveLength(1);
    expect(events[0]).toBe(cachedFolder);
  });

  it('refreshes root for root mutations and maps connection drops to the target parent', async () => {
    const value = emptyPersistedState();
    value.folders.push(folder);
    value.connections.push(connection);
    const move = vi.fn(async () => undefined);
    const provider = new ConnectionsTreeProvider(new StateFake(value), move);
    const events: (FolderNode | ConnectionNode | undefined)[] = [];
    provider.onDidChangeTreeData((event) => events.push(event));
    provider.refresh({
      previous: structuredClone(value),
      current: {
        ...structuredClone(value),
        connections: [{ ...connection, folderId: null }],
      },
    });
    expect(events).toEqual([undefined]);

    const transfer = new Map<string, { value: unknown }>();
    transfer.set(provider.dragMimeTypes[0]!, { value: ['connection:source'] });
    await provider.handleDrop(new ConnectionNode(connection), transfer as never);
    expect(move).toHaveBeenCalledWith('source', folder.id, connection.id);
  });
});
