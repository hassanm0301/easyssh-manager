import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, '../../../dist/test/extension/suite/index.js');
  const vscodeExecutablePath = process.env.EASYSSH_TEST_EXECUTABLE;
  const launchArgs = process.env.EASYSSH_TEST_X11 === '1' ? ['--ozone-platform=x11'] : undefined;
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(vscodeExecutablePath === undefined ? {} : { vscodeExecutablePath }),
    ...(launchArgs === undefined ? {} : { launchArgs }),
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
