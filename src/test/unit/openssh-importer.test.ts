import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenSshImporter } from '../../connections/OpenSshImporter';

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
});
