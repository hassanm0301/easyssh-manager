import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

const file = process.argv[2];
if (!file) {
  throw new Error('Usage: npm run inspect:vsix -- <path-to-vsix>');
}
const vsix = resolve(file);
if (!existsSync(vsix)) {
  throw new Error(`VSIX does not exist: ${vsix}`);
}

const contents = await listZipEntries(vsix);
const prohibited =
  /(^|\/)(\.env(?:\..*)?|coverage|test|tests|fixtures|\.github)(\/|$)|\.(pem|key)$/i;
const unsafe = contents.filter((entry) => prohibited.test(entry));
if (unsafe.length > 0) {
  throw new Error(`VSIX contains prohibited files:\n${unsafe.join('\n')}`);
}
const requiredUiAssets = [
  'extension/media/easyssh-manager.svg',
  'extension/THIRD_PARTY_NOTICES.md',
  'extension/dist/webview/webview-theme.css',
  'extension/dist/webview/connection-editor-style.css',
  'extension/dist/webview/import-preview-style.css',
  'extension/dist/webview/sftp-browser-style.css',
];
const missingUiAssets = requiredUiAssets.filter((entry) => !contents.includes(entry));
if (missingUiAssets.length > 0) {
  throw new Error(`VSIX is missing required UI assets:\n${missingUiAssets.join('\n')}`);
}
const codiconFonts = contents.filter((entry) =>
  /^extension\/dist\/webview\/codicon-[\w-]+\.ttf$/.test(entry),
);
if (codiconFonts.length !== 1) {
  throw new Error(
    `VSIX must contain exactly one packaged Codicon font; found ${codiconFonts.length}.`,
  );
}
console.log(contents.join('\n'));

/** Read only the archive directory: file contents are never unpacked. */
function listZipEntries(zipPath) {
  return new Promise((resolveEntries, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Unable to open VSIX'));
        return;
      }
      const entries = [];
      zipFile.on('error', reject);
      zipFile.on('entry', (entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.on('end', () => resolveEntries(entries));
      zipFile.readEntry();
    });
  });
}
