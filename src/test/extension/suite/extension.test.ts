import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('EasySSH Manager extension', () => {
  test('activates from its contributed view without errors', async () => {
    const extension = vscode.extensions.getExtension('hassanm0301.easyssh-manager');
    assert.ok(extension, 'extension should be discoverable');
    await extension.activate();
    assert.equal(extension.isActive, true);
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
