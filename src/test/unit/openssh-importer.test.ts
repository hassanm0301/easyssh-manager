import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenSshImporter } from '../../connections/OpenSshImporter';
import type { ImportFileSystem } from '../../connections/OpenSshImporter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ root: string; home: string; config: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'easyssh-import-'));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  const config = join(home, '.ssh', 'config');
  await fs.mkdir(join(home, '.ssh', 'conf.d'), { recursive: true });
  return { root, home, config };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('OpenSshImporter', () => {
  it('computes first-value wildcard inheritance, keys, tokens, and deterministic includes read-only', async () => {
    const { home, config } = await fixture();
    await fs.writeFile(
      config,
      `Include conf.d/*.conf\nHost prod.internal\n  HostName server.internal\n  Port 2200\n  IdentityFile ~/.ssh/id_a\n  IdentityFile %d/.ssh/id_b\n  PreferredAuthentications publickey,password\nHost *.internal !prod.internal\n  User wrong\nHost *\n  User local-user\n`,
    );
    await fs.writeFile(join(home, '.ssh', 'conf.d', 'b.conf'), 'Host db\n  HostName db.local\n');
    await fs.writeFile(
      join(home, '.ssh', 'conf.d', 'a.conf'),
      'Host cache\n  HostName cache.local\n',
    );
    const before = await fs.readFile(config);

    const candidates = await new OpenSshImporter(
      undefined,
      () => home,
      () => 'fallback',
    ).discover();
    expect(candidates.map((candidate) => candidate.name)).toEqual(['cache', 'db', 'prod.internal']);
    const prod = candidates.find((candidate) => candidate.name === 'prod.internal')!;
    expect(prod).toMatchObject({
      host: 'server.internal',
      port: 2200,
      username: 'local-user',
      selectedAuthentication: 'privateKey',
    });
    expect(prod.identityFiles).toEqual([join(home, '.ssh', 'id_a'), join(home, '.ssh', 'id_b')]);
    expect(prod.warnings).toContainEqual(expect.objectContaining({ code: 'MULTIPLE_IDENTITIES' }));
    expect(digest(await fs.readFile(config))).toBe(digest(before));
  });

  it('scopes unresolved includes and blocks proxy and Match exec without executing it', async () => {
    const { root, home, config } = await fixture();
    const sentinel = join(root, 'must-not-exist');
    await fs.writeFile(
      config,
      `Host safe\n  HostName safe.local\nHost missing\n  Include absent.conf\nHost proxied\n  ProxyJump bastion\nMatch exec "touch ${sentinel}"\n  User attacker\n`,
    );
    const candidates = await new OpenSshImporter(
      undefined,
      () => home,
      () => 'local',
    ).discover();
    expect(candidates.find((candidate) => candidate.name === 'safe')?.blockingIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'MATCH_EXEC' })]),
    );
    expect(
      candidates
        .find((candidate) => candidate.name === 'safe')
        ?.blockingIssues.some((issue) => issue.code === 'INCLUDE_MISSING'),
    ).toBe(false);
    expect(candidates.find((candidate) => candidate.name === 'missing')?.blockingIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INCLUDE_MISSING' })]),
    );
    expect(candidates.find((candidate) => candidate.name === 'proxied')?.blockingIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROXYJUMP' })]),
    );
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails clearly for invalid UTF-8', async () => {
    const { home, config } = await fixture();
    await fs.writeFile(config, Uint8Array.from([0xff, 0xfe, 0xfd]));
    await expect(
      new OpenSshImporter(
        undefined,
        () => home,
        () => 'local',
      ).discover(),
    ).rejects.toThrow('not valid UTF-8');
  });

  it('contains canonical include loops and enforces depth and file-count limits', async () => {
    const loopFiles = new MemoryFiles({
      '/config': 'Host loop\n  Include alias\n',
      '/alias': '',
    });
    loopFiles.canonical.set('/alias', '/config');
    const loop = await new OpenSshImporter(
      loopFiles,
      () => '/home',
      () => 'user',
      { platform: 'posix' },
    ).discover('/config');
    expect(loop[0]?.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'INCLUDE_LOOP' }),
    );

    const depthEntries: Record<string, string> = {
      '/config': 'Host deep\n  Include f1\n',
    };
    for (let index = 1; index <= 17; index += 1)
      depthEntries[`/f${index}`] = index === 17 ? '' : `Include f${index + 1}\n`;
    const depth = await new OpenSshImporter(
      new MemoryFiles(depthEntries),
      () => '/home',
      () => 'user',
      { platform: 'posix' },
    ).discover('/config');
    expect(depth[0]?.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'INCLUDE_DEPTH' }),
    );

    const countEntries: Record<string, string> = {
      '/config': 'Host many\n  Include parts/*.conf\n',
    };
    for (let index = 0; index < 256; index += 1)
      countEntries[`/parts/${String(index).padStart(3, '0')}.conf`] = '';
    const count = await new OpenSshImporter(
      new MemoryFiles(countEntries),
      () => '/home',
      () => 'user',
      { platform: 'posix' },
    ).discover('/config');
    expect(count[0]?.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'INCLUDE_FILES' }),
    );
  });

  it('enforces the aggregate byte limit and blocks unsupported tokens', async () => {
    const oversized = new MemoryFiles({
      '/config': `Host large\n#${'x'.repeat(8 * 1024 * 1024)}\n`,
    });
    await expect(
      new OpenSshImporter(
        oversized,
        () => '/home',
        () => 'user',
        { platform: 'posix' },
      ).discover('/config'),
    ).rejects.toThrow('safe 8 MiB limit');

    const tokens = new MemoryFiles({
      '/config': 'Host token\n  HostName %x.example\n  IdentityFile %d/.ssh/%n\n',
    });
    const candidates = await new OpenSshImporter(
      tokens,
      () => '/home/user',
      () => 'local',
      { platform: 'posix' },
    ).discover('/config');
    expect(candidates[0]?.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_TOKEN' }),
    );
  });

  it('uses Windows homes, quoted identity paths, CRLF, and drive or UNC include globs', async () => {
    const entries = {
      'C:\\Users\\Test\\.ssh\\config':
        'Include "conf.d\\*.conf"\r\nHost drive\r\n  IdentityFile "~\\.ssh\\keys\\my key"\r\nHost unc\r\n  HostName unc.example\r\n',
      'C:\\Users\\Test\\.ssh\\conf.d\\child.conf': 'Host child\r\n  HostName child.example\r\n',
      '\\\\server\\share\\ssh\\config':
        'Host shared\r\n  IdentityFile "\\\\server\\share\\keys\\id key"\r\n',
    };
    const files = new MemoryFiles(entries, '\\');
    const importer = new OpenSshImporter(
      files,
      () => 'C:\\Users\\Test',
      () => 'tester',
      { platform: 'win32' },
    );

    expect(importer.defaultConfigPath()).toBe('C:\\Users\\Test\\.ssh\\config');
    const candidates = await importer.discover();
    expect(candidates.map(({ name }) => name)).toEqual(['child', 'drive', 'unc']);
    expect(candidates.find(({ name }) => name === 'drive')?.identityFiles).toEqual([
      'C:\\Users\\Test\\.ssh\\keys\\my key',
    ]);

    const unc = await importer.discover('\\\\server\\share\\ssh\\config');
    expect(unc[0]?.identityFiles).toEqual(['\\\\server\\share\\keys\\id key']);
  });

  it('resolves Windows relative includes and contains Windows include recursion', async () => {
    const root = 'D:\\ssh';
    const files = new MemoryFiles(
      {
        [`${root}\\config`]: 'Host relative\r\n  Include "parts\\*.conf"\r\n',
        [`${root}\\parts\\a.conf`]:
          'Host included\r\n  HostName included.example\r\n  Include "..\\config"\r\n',
      },
      '\\',
    );
    const candidates = await new OpenSshImporter(
      files,
      () => 'C:\\Users\\Test',
      () => 'tester',
      { platform: 'win32' },
    ).discover(`${root}\\config`);

    expect(candidates.map(({ name }) => name)).toEqual(['relative', 'included']);
    expect(candidates.find(({ name }) => name === 'included')?.blockingIssues).toContainEqual(
      expect.objectContaining({ code: 'INCLUDE_LOOP' }),
    );
  });

  it('expands absolute forward-slash drive and UNC include globs on Windows', async () => {
    const entries = {
      'C:\\Users\\Test\\.ssh\\config': 'Include C:/Users/Test/.ssh/conf.d/*.conf\r\n',
      'C:\\Users\\Test\\.ssh\\conf.d\\drive.conf': 'Host drive\r\n  HostName drive.example\r\n',
      '\\\\server\\share\\ssh\\config': 'Include //server/share/ssh/conf.d/*.conf\r\n',
      '\\\\server\\share\\ssh\\conf.d\\unc.conf': 'Host unc\r\n  HostName unc.example\r\n',
    };
    const importer = new OpenSshImporter(
      new MemoryFiles(entries, '\\'),
      () => 'C:\\Users\\Test',
      () => 'tester',
      { platform: 'win32' },
    );

    expect((await importer.discover()).map(({ name }) => name)).toEqual(['drive']);
    expect(
      (await importer.discover('\\\\server\\share\\ssh\\config')).map(({ name }) => name),
    ).toEqual(['unc']);
  });
});

class MemoryFiles implements ImportFileSystem {
  readonly canonical = new Map<string, string>();
  private readonly values = new Map<string, Uint8Array>();

  constructor(
    entries: Record<string, string>,
    private readonly separator = '/',
  ) {
    for (const [file, value] of Object.entries(entries)) {
      this.values.set(file, new TextEncoder().encode(value));
      this.canonical.set(file, file);
    }
  }

  async readFile(file: string): Promise<Uint8Array> {
    const value = this.values.get(file);
    if (!value) throw new Error('missing');
    return value;
  }

  async realpath(file: string): Promise<string> {
    const canonical = this.canonical.get(file);
    if (!canonical) throw new Error('missing');
    return canonical;
  }

  async readdir(directory: string): Promise<string[]> {
    const prefix = `${directory.replace(new RegExp(`${escapeRegExp(this.separator)}$`), '')}${this.separator}`;
    return [...this.values.keys()]
      .filter(
        (file) => file.startsWith(prefix) && !file.slice(prefix.length).includes(this.separator),
      )
      .map((file) => file.slice(prefix.length));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
