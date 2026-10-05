import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const outdir = resolve(root, 'dist');

const sshCryptoStubPlugin = {
  name: 'ssh2-native-crypto-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/crypto\/build\/Release\/sshcrypto\.node$/ }, () => ({
      path: resolve(root, 'src/ssh/sshCryptoStub.ts'),
    }));
  },
};

const base = {
  bundle: true,
  alias: {
    // ssh2 treats this native accelerator as optional. A deterministic stub
    // keeps the VSIX portable and selects ssh2's built-in JS fallback.
    'cpu-features': resolve(root, 'src/ssh/cpuFeaturesStub.ts'),
  },
  plugins: [sshCryptoStubPlugin],
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
    'test/extension/suite/sftp-acceptance.test': resolve(
      root,
      'src/test/extension/suite/sftp-acceptance.test.ts',
    ),
  },
  outdir,
};

const webview = {
  ...base,
  platform: 'browser',
  format: 'iife',
  assetNames: 'webview/[name]-[hash]',
  loader: { '.ttf': 'file' },
  entryPoints: {
    'webview/main': resolve(root, 'src/views/shared/webview/main.ts'),
    'webview/webview-theme': resolve(root, 'src/views/shared/webview/webview-theme.css'),
    'webview/sftp-browser': resolve(root, 'src/views/sftp/webview/main.ts'),
    'webview/sftp-browser-style': resolve(root, 'src/views/sftp/webview/sftp-browser.css'),
    'webview/connection-editor-style': resolve(
      root,
      'src/views/connections/webview/connection-editor.css',
    ),
    'webview/import-preview-style': resolve(
      root,
      'src/views/connections/webview/import-preview.css',
    ),
  },
  outdir,
};

const mcpCompanion = {
  ...base,
  platform: 'node',
  format: 'cjs',
  entryPoints: { 'mcp/companion': resolve(root, 'src/mcp/companion.ts') },
  outdir,
};

await rm(outdir, { recursive: true, force: true });
if (watch) {
  const extensionContext = await context(extensionHost);
  const webviewContext = await context(webview);
  const mcpContext = await context(mcpCompanion);
  await Promise.all([extensionContext.watch(), webviewContext.watch(), mcpContext.watch()]);
  console.log('Watching EasySSH Manager bundles.');
} else {
  await Promise.all([build(extensionHost), build(webview), build(mcpCompanion)]);
}
