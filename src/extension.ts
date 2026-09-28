import * as vscode from 'vscode';

import { ExtensionApplication } from './application/ExtensionApplication';

let application: ExtensionApplication | undefined;

export function activate(context: vscode.ExtensionContext): void {
  application = new ExtensionApplication(vscode);
  context.subscriptions.push(application);
  application.activate();
}

export async function deactivate(): Promise<void> {
  await application?.dispose();
  application = undefined;
}
