import * as vscode from 'vscode';

import type { StateRepository } from '../../connections/ports';
import type { ConnectionFolder, RemoteConnection } from '../../connections/types';

export type ConnectionTreeNode = FolderNode | ConnectionNode;

export class FolderNode extends vscode.TreeItem {
  constructor(
    readonly folder: ConnectionFolder,
    expanded = false,
  ) {
    super(
      folder.name,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `folder:${folder.id}`;
    this.contextValue = 'easysshManager.folder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = folder.name;
    this.accessibilityInformation = { label: `Folder ${folder.name}`, role: 'treeitem' };
  }
}

export class ConnectionNode extends vscode.TreeItem {
  constructor(readonly connection: RemoteConnection) {
    super(connection.name, vscode.TreeItemCollapsibleState.None);
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
      .map(
        (folder) =>
          new FolderNode(folder, current.uiPreferences.expandedFolderIds.includes(folder.id)),
      );
    const connections = current.connections
      .filter((connection) => connection.folderId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((connection) => new ConnectionNode(connection));
    return [...folders, ...connections];
  }

  refresh(node?: ConnectionTreeNode): void {
    this.changeEmitter.fire(node);
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
  }
}
