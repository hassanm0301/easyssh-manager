import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { WINDOWS_MCP_UNAVAILABLE_MESSAGE } from '../../../common/platformCapabilities';
import { ExtensionApplication } from '../../../application/ExtensionApplication';
import { ImportPreview } from '../../../views/connections/ImportPreview';

suite('EasySSH Manager extension', () => {
  test('activates from its contributed view without errors', async () => {
    const extension = vscode.extensions.getExtension('hassanm0301.easyssh-manager');
    assert.ok(extension, 'extension should be discoverable');
    assert.ok(extension.packageJSON.os.includes(process.platform));
    assert.ok(['linux', 'win32'].includes(process.platform));
    assert.equal(os.platform(), process.platform);
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
    const activationDeadline = Date.now() + 2_000;
    while (!extension.isActive && Date.now() < activationDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
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
      'collapseAllConnections',
      'openSettings',
      'openSsh',
      'openSftp',
      'openRemoteFile',
      'openRemoteFileForDevelopment',
      'testConnection',
      'configureMcp',
      'viewMcpAudit',
      'exportMcpAudit',
      'clearMcpAudit',
      'uploadFiles',
      'uploadFolder',
    ].map((name) => `easysshManager.${name}`);
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of expected) assert.ok(registered.has(command), `${command} is registered`);
    await vscode.commands.executeCommand('easysshManager.refreshConnections');
  });

  test('round trips native Windows drive and UNC file URIs', function () {
    if (process.platform !== 'win32') this.skip();

    const drivePath = 'C:\\Users\\Zoë Example\\workspace\\file.txt';
    const driveUri = vscode.Uri.file(drivePath);
    assert.equal(driveUri.scheme, 'file');
    // VS Code canonicalizes the drive letter to lowercase in fsPath.
    assert.equal(driveUri.fsPath, `c:${path.win32.normalize(drivePath).slice(2)}`);

    const uncPath = '\\\\server\\share\\Zoë Example\\file.txt';
    const uncUri = vscode.Uri.file(uncPath);
    assert.equal(uncUri.scheme, 'file');
    assert.equal(uncUri.fsPath, path.win32.normalize(uncPath));
  });

  test('rejects Windows MCP setup before reading application context', async function () {
    if (process.platform !== 'win32') this.skip();

    const uninitialized = Object.create(ExtensionApplication.prototype) as ExtensionApplication;
    const configureMcp = Reflect.get(uninitialized, 'configureMcp') as () => Promise<void>;
    await assert.rejects(configureMcp.call(uninitialized), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, WINDOWS_MCP_UNAVAILABLE_MESSAGE);
      return true;
    });
  });
});

function openImportPreviewForAcceptance(): ImportPreview {
  const extension = vscode.extensions.getExtension('hassanm0301.easyssh-manager');
  assert.ok(extension, 'extension should be discoverable');
  const preview = new ImportPreview(vscode, extension.extensionUri);
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
