import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, '../../../dist/test/extension/suite/index.js');
  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
