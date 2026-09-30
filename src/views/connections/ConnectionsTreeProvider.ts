import * as vscode from 'vscode';

import type { StateChange, StateRepository } from '../../connections/ports';
import type { ConnectionFolder, RemoteConnection } from '../../connections/types';

export type ConnectionTreeNode = FolderNode | ConnectionNode;

export class FolderNode extends vscode.TreeItem {
  constructor(folder: ConnectionFolder, expanded = false) {
    super(
      folder.name,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.folder = folder;
    this.update(folder, expanded);
  }

  folder: ConnectionFolder;

  update(folder: ConnectionFolder, expanded = false): this {
    this.folder = folder;
    this.label = folder.name;
    this.collapsibleState = expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
    this.id = `folder:${folder.id}`;
    this.contextValue = 'easysshManager.folder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = folder.name;
    this.accessibilityInformation = { label: `Folder ${folder.name}`, role: 'treeitem' };
    return this;
  }
}

export class ConnectionNode extends vscode.TreeItem {
  constructor(connection: RemoteConnection) {
    super(connection.name, vscode.TreeItemCollapsibleState.None);
    this.connection = connection;
    this.update(connection);
  }

  connection: RemoteConnection;

  update(connection: RemoteConnection): this {
    this.connection = connection;
    this.label = connection.name;
    this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    this.id = `connection:${connection.id}`;
    this.contextValue = 'easysshManager.connection';
    this.description = `${connection.username}@${connection.host}:${connection.port}`;
    this.tooltip = `${connection.name}\n${this.description}`;
    this.iconPath = new vscode.ThemeIcon('server');
    this.accessibilityInformation = {
      label: `${connection.name}, ${connection.username} at ${connection.host}, port ${connection.port}`,
      role: 'treeitem',
    };
    this.command = {
      command: 'easysshManager.editConnection',
      title: 'Edit Connection',
      arguments: [connection.id],
    };
    return this;
  }
}

/** Tree data remains metadata-only: TreeItems never expose credentials. */
export class ConnectionsTreeProvider
  implements
    vscode.TreeDataProvider<ConnectionTreeNode>,
    vscode.TreeDragAndDropController<ConnectionTreeNode>,
    vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionTreeNode | undefined>();
  private readonly folderNodes = new Map<string, FolderNode>();
  private readonly connectionNodes = new Map<string, ConnectionNode>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  readonly dragMimeTypes = ['application/vnd.code.tree.easysshManager.connections'];
  readonly dropMimeTypes = [...this.dragMimeTypes];

  constructor(
    private readonly state?: StateRepository,
    private readonly move?: (
      id: string,
      folderId: string | null,
      beforeId?: string,
    ) => Promise<void>,
  ) {}

  getTreeItem(element: ConnectionTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ConnectionTreeNode): Promise<ConnectionTreeNode[]> {
    if (!this.state) return [];
    const current = await this.state.load();
    const parentId = element instanceof FolderNode ? element.folder.id : null;
    if (element instanceof ConnectionNode) return [];
    const folders = current.folders
      .filter((folder) => folder.parentId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((folder) => this.folderNode(folder, current.uiPreferences.expandedFolderIds));
    const connections = current.connections
      .filter((connection) => connection.folderId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((connection) => this.connectionNode(connection));
    return [...folders, ...connections];
  }

  refresh(change?: StateChange): void {
    if (!change) {
      this.changeEmitter.fire(undefined);
      return;
    }
    const parentIds = new Set<string | null>();
    const changedItems: ConnectionTreeNode[] = [];
    collectFolderChanges(change, parentIds, changedItems, (folder) =>
      this.folderNode(folder, change.current.uiPreferences.expandedFolderIds),
    );
    collectConnectionChanges(change, parentIds, changedItems, (connection) =>
      this.connectionNode(connection),
    );
    if (parentIds.has(null)) {
      this.changeEmitter.fire(undefined);
      return;
    }
    for (const parentId of parentIds) {
      const folder = change.current.folders.find((item) => item.id === parentId);
      if (folder)
        this.changeEmitter.fire(
          this.folderNode(folder, change.current.uiPreferences.expandedFolderIds),
        );
    }
    for (const item of changedItems) this.changeEmitter.fire(item);
  }

  handleDrag(source: readonly ConnectionTreeNode[], dataTransfer: vscode.DataTransfer): void {
    dataTransfer.set(
      this.dragMimeTypes[0]!,
      new vscode.DataTransferItem(
        source.map((node) => node.id).filter((id): id is string => id !== undefined),
      ),
    );
  }

  async handleDrop(
    target: ConnectionTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (!this.move) return;
    const item = dataTransfer.get(this.dragMimeTypes[0]!);
    const ids = item?.value;
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) return;
    const targetFolder =
      target instanceof FolderNode
        ? target.folder.id
        : target instanceof ConnectionNode
          ? target.connection.folderId
          : null;
    const beforeId = target instanceof ConnectionNode ? target.connection.id : undefined;
    for (const rawId of ids) {
      const id = rawId.replace(/^(connection|folder):/, '');
      await this.move(id, targetFolder, beforeId);
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.folderNodes.clear();
    this.connectionNodes.clear();
  }

  private folderNode(folder: ConnectionFolder, expandedIds: readonly string[]): FolderNode {
    const existing = this.folderNodes.get(folder.id);
    if (existing) return existing.update(folder, expandedIds.includes(folder.id));
    const node = new FolderNode(folder, expandedIds.includes(folder.id));
    this.folderNodes.set(folder.id, node);
    return node;
  }

  private connectionNode(connection: RemoteConnection): ConnectionNode {
    const existing = this.connectionNodes.get(connection.id);
    if (existing) return existing.update(connection);
    const node = new ConnectionNode(connection);
    this.connectionNodes.set(connection.id, node);
    return node;
  }
}

function collectFolderChanges(
  change: StateChange,
  parentIds: Set<string | null>,
  changedItems: ConnectionTreeNode[],
  nodeFor: (folder: ConnectionFolder) => FolderNode,
): void {
  const previous = new Map(change.previous.folders.map((folder) => [folder.id, folder]));
  const current = new Map(change.current.folders.map((folder) => [folder.id, folder]));
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(id);
    const after = current.get(id);
    if (!before || !after || before.parentId !== after.parentId || before.order !== after.order) {
      if (before) parentIds.add(before.parentId);
      if (after) parentIds.add(after.parentId);
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changedItems.push(nodeFor(after));
    }
  }
}

function collectConnectionChanges(
  change: StateChange,
  parentIds: Set<string | null>,
  changedItems: ConnectionTreeNode[],
  nodeFor: (connection: RemoteConnection) => ConnectionNode,
): void {
  const previous = new Map(
    change.previous.connections.map((connection) => [connection.id, connection]),
  );
  const current = new Map(
    change.current.connections.map((connection) => [connection.id, connection]),
  );
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(id);
    const after = current.get(id);
    if (!before || !after || before.folderId !== after.folderId || before.order !== after.order) {
      if (before) parentIds.add(before.folderId);
      if (after) parentIds.add(after.folderId);
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      changedItems.push(nodeFor(after));
    }
  }
}
