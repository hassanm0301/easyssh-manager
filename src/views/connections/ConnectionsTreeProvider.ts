import * as vscode from 'vscode';

/** Empty native view; persisted connection items are added in Milestone 02. */
export class ConnectionsTreeProvider implements vscode.TreeDataProvider<never>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  getTreeItem(): vscode.TreeItem {
    throw new Error('ConnectionsTreeProvider has no items before Milestone 02');
  }

  getChildren(): never[] {
    return [];
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
