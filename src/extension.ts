import * as vscode from 'vscode';

import { ExtensionApplication } from './application/ExtensionApplication';

let application: ExtensionApplication | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  application = new ExtensionApplication(vscode, context);
  context.subscriptions.push(application);
  await application.activate();
}

export async function deactivate(): Promise<void> {
  await application?.dispose();
  application = undefined;
}
