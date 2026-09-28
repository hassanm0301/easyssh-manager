import * as vscode from 'vscode';

import { CommandRegistry } from '../commands/CommandRegistry';
import { DisposableStore } from '../common/disposables';
import { createVsCodeLogger, type EasySshLogger } from '../common/logger';
import { VsCodeConfigurationService } from '../configuration/ConfigurationService';
import { ConnectionsTreeProvider } from '../views/connections/ConnectionsTreeProvider';

/** The single extension composition root. Subsystems own their own behavior. */
export class ExtensionApplication implements vscode.Disposable {
  private readonly disposables = new DisposableStore();
  private readonly configuration: VsCodeConfigurationService;
  private readonly logger: EasySshLogger;
  private readonly commands: CommandRegistry;
  private readonly treeProvider: ConnectionsTreeProvider;

  constructor(private readonly vscodeApi: typeof vscode) {
    this.configuration = this.disposables.add(new VsCodeConfigurationService(vscodeApi));
    this.logger = this.disposables.add(
      createVsCodeLogger(vscodeApi, () => this.configuration.getSnapshot().logLevel),
    );
    this.treeProvider = this.disposables.add(new ConnectionsTreeProvider());
    this.disposables.add(
      vscodeApi.window.createTreeView('easysshManager.connections', {
        treeDataProvider: this.treeProvider,
        showCollapseAll: false,
      }),
    );
    this.commands = this.disposables.add(
      new CommandRegistry(
        {
          registerCommand: (id, callback) => vscodeApi.commands.registerCommand(id, callback),
          showErrorMessage: (message) => vscodeApi.window.showErrorMessage(message),
          showInformationMessage: (message) => vscodeApi.window.showInformationMessage(message),
        },
        this.logger,
      ),
    );
  }

  activate(): void {
    this.commands.register({
      id: 'easysshManager.refreshConnections',
      execute: async () => {
        this.treeProvider.refresh();
      },
    });
    this.logger.info('EasySSH Manager activated', { operation: 'activation' });
  }

  async dispose(): Promise<void> {
    await this.disposables.dispose();
  }
}
