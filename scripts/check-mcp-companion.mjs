import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const pinned = {
  '@modelcontextprotocol/server': '2.3.1',
  zod: '4.6.5',
};
for (const [name, version] of Object.entries(pinned)) {
  if (packageJson.dependencies?.[name] !== version)
    throw new Error(`MCP runtime dependency ${name} must remain exactly pinned to ${version}.`);
}

const sourceRoot = resolve(root, 'src/mcp');
const sourceFiles = (await readdir(sourceRoot)).filter((file) => file.endsWith('.ts'));
const forbiddenImport =
  /(?:from\s*|import\s*\()\s*['"](?:vscode|ssh2|node:(?:http|https|dgram)|(?:node:)?(?:http|https|ssh2)(?:\/[^'"]*)?)['"]/;
const forbiddenAuthority = /\b(?:createServer|createHttpServer|listen)\s*\(/;
for (const file of sourceFiles) {
  const source = await readFile(resolve(sourceRoot, file), 'utf8');
  if (forbiddenImport.test(source)) throw new Error(`Forbidden companion import in ${file}.`);
  if (file === 'companion.ts' && forbiddenAuthority.test(source))
    throw new Error('The MCP companion cannot listen for inbound network connections.');
}

const bundlePath = resolve(root, 'dist/mcp/companion.js');
await readFile(bundlePath);
const selfTest = spawnSync(process.execPath, [bundlePath, '--self-test'], {
  encoding: 'utf8',
  timeout: 5000,
  windowsHide: true,
});
if (
  selfTest.status !== 0 ||
  selfTest.stdout !== 'EasySSH MCP companion ready.\n' ||
  selfTest.stderr
)
  throw new Error('The bundled MCP companion self-test failed.');
