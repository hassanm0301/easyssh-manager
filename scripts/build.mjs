import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const outdir = resolve(root, 'dist');

const base = {
  bundle: true,
  alias: {
    // ssh2 treats this native accelerator as optional. A deterministic stub
    // keeps the VSIX portable and lets ssh2 use its built-in JS/Node crypto path.
    'cpu-features': resolve(root, 'src/ssh/cpuFeaturesStub.ts'),
  },
  sourcemap: production ? false : 'inline',
  minify: production,
  legalComments: 'none',
  logLevel: 'info',
  target: 'node20',
};

const extensionHost = {
  ...base,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', 'mocha'],
  entryPoints: {
    extension: resolve(root, 'src/extension.ts'),
    'test/extension/suite/index': resolve(root, 'src/test/extension/suite/index.ts'),
    'test/extension/suite/extension.test': resolve(
      root,
      'src/test/extension/suite/extension.test.ts',
    ),
  },
  outdir,
};

const webview = {
  ...base,
  platform: 'browser',
  format: 'iife',
  entryPoints: {
    'webview/main': resolve(root, 'src/views/shared/webview/main.ts'),
  },
  outdir,
};

await rm(outdir, { recursive: true, force: true });
if (watch) {
  const extensionContext = await context(extensionHost);
  const webviewContext = await context(webview);
  await Promise.all([extensionContext.watch(), webviewContext.watch()]);
  console.log('Watching EasySSH Manager bundles.');
} else {
  await Promise.all([build(extensionHost), build(webview)]);
}
