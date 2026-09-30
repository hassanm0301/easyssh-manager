import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { ImportPreview } from '../../../views/connections/ImportPreview';

suite('EasySSH Manager extension', () => {
  test('activates from its contributed view without errors', async () => {
    const extension = vscode.extensions.getExtension('hassanm0301.easyssh-manager');
    assert.ok(extension, 'extension should be discoverable');
    assert.deepEqual(extension.packageJSON.extensionKind, ['ui']);
    assert.equal(extension.packageJSON.main, './dist/extension.js');
    assert.equal(extension.packageJSON.browser, undefined);
    assert.equal(
      extension.packageJSON.contributes.views.easysshManager[0].id,
      'easysshManager.connections',
    );
    assert.match(
      extension.packageJSON.contributes.viewsWelcome[0].contents,
      /easysshManager\.addConnection/,
    );
    await vscode.commands.executeCommand('workbench.view.extension.easysshManager');
    if (!extension.isActive) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(extension.isActive, true);
    if (process.env.EASYSSH_ACCEPTANCE_PANEL === 'editor')
      await vscode.commands.executeCommand('easysshManager.addConnection');
    const preview =
      process.env.EASYSSH_ACCEPTANCE_PANEL === 'import'
        ? openImportPreviewForAcceptance()
        : undefined;
    const acceptancePause = Number(process.env.EASYSSH_ACCEPTANCE_PAUSE_MS ?? 0);
    if (Number.isFinite(acceptancePause) && acceptancePause > 0)
      await new Promise((resolve) => setTimeout(resolve, acceptancePause));
    preview?.dispose();
  });

  test('registers the complete milestone-two command surface', async () => {
    const expected = [
      'addConnection',
      'addFolder',
      'editConnection',
      'duplicateConnection',
      'deleteConnection',
      'renameFolder',
      'moveItem',
      'deleteFolder',
      'importSshConfig',
      'refreshConnections',
      'openSsh',
      'openSftp',
      'testConnection',
    ].map((name) => `easysshManager.${name}`);
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of expected) assert.ok(registered.has(command), `${command} is registered`);
    await vscode.commands.executeCommand('easysshManager.refreshConnections');
  });
});

function openImportPreviewForAcceptance(): ImportPreview {
  const preview = new ImportPreview(vscode);
  preview.open(
    [
      {
        candidateId: 'safe',
        sourcePath: '/home/user/.ssh/config',
        hostPattern: 'production',
        name: 'Production',
        host: 'production.example.com',
        port: 22,
        username: 'deploy',
        identityFiles: ['/home/user/.ssh/id_ed25519'],
        selectedIdentityFile: '/home/user/.ssh/id_ed25519',
        selectedAuthentication: 'privateKey',
        blockingIssues: [],
        warnings: [{ code: 'MULTIPLE_IDENTITIES', message: 'Review the selected identity file.' }],
      },
      {
        candidateId: 'blocked',
        sourcePath: '/home/user/.ssh/config',
        hostPattern: 'proxied',
        name: 'Proxied host',
        host: 'proxied.example.com',
        port: 22,
        username: 'deploy',
        identityFiles: [],
        selectedAuthentication: 'agent',
        blockingIssues: [
          { code: 'PROXYJUMP', message: 'ProxyJump changes connectivity and is not supported.' },
        ],
        warnings: [],
      },
    ],
    [],
    async () => undefined,
  );
  return preview;
}
