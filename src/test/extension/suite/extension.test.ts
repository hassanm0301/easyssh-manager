import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('EasySSH Manager extension', () => {
  test('activates from its contributed view without errors', async () => {
    const extension = vscode.extensions.getExtension('hassanm0301.easyssh-manager');
    assert.ok(extension, 'extension should be discoverable');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });
});
