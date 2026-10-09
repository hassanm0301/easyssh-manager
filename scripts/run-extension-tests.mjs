import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const acceptance = process.argv.includes('--acceptance');
const testRunner = fileURLToPath(import.meta.resolve('tsx/cli'));
const environment = { ...process.env };

delete environment.ELECTRON_RUN_AS_NODE;
if (acceptance) environment.EASYSSH_RUN_DOCKER = '1';

const child = spawn(process.execPath, [testRunner, 'src/test/extension/runTest.ts'], {
  env: environment,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Could not start extension tests: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
