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
