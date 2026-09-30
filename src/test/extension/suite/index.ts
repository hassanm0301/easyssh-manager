import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const acceptancePause = Number(process.env.EASYSSH_ACCEPTANCE_PAUSE_MS ?? 0);
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout:
      Number.isFinite(acceptancePause) && acceptancePause > 0 ? acceptancePause + 2_000 : 2_000,
  });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} extension-host test(s) failed.`));
          return;
        }
        resolve();
      });
    } catch (error: unknown) {
      reject(error);
    }
  });
}
