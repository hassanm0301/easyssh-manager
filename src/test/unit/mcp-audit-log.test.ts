import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { McpAuditLog } from '../../mcp/McpAuditLog';

describe.runIf(process.platform === 'linux')('metadata-only MCP audit log', () => {
  let directory = '';
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  it('persists only whitelisted metadata and paginates newest first', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-audit-'));
    const path = join(directory, 'audit.jsonl');
    const audit = new McpAuditLog(path, () => 2000);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        audit.append({
          timestamp: 1000 + index,
          requestId: `request-${index}`,
          tool: 'ssh_exec',
          confirmation: 'always',
          outcome: 'success',
          durationMs: 2,
          commandFingerprint: audit.fingerprint(`SECRET_COMMAND_${index}`),
        }),
      ),
    );
    const bytes = await readFile(path, 'utf8');
    expect(bytes).not.toContain('SECRET_COMMAND');
    expect(await audit.page(0, 2)).toHaveLength(2);
    expect((await audit.page(0, 2))[0]?.requestId).toBe('request-7');
    await audit.close();
  });

  it('recovers from a partial final line and prunes expired records', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-audit-'));
    const path = join(directory, 'audit.jsonl');
    let now = 40 * 24 * 60 * 60 * 1000;
    const audit = new McpAuditLog(path, () => now);
    const record = (timestamp: number, requestId: string) => ({
      timestamp,
      requestId,
      tool: 'sftp_stat',
      confirmation: 'not-applicable' as const,
      outcome: 'success' as const,
      durationMs: 1,
    });
    await audit.append(record(now, 'kept-1'));
    await appendFile(path, '{"partial":');
    expect(await audit.page()).toHaveLength(1);
    now += 31 * 24 * 60 * 60 * 1000;
    await audit.append(record(now, 'kept-2'));
    expect((await audit.page()).map((row) => row.requestId)).toEqual(['kept-2']);
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
    await audit.close();
  });

  it('requires private regular files and never follows an audit symlink', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-audit-'));
    const target = join(directory, 'target.jsonl');
    const path = join(directory, 'audit.jsonl');
    await writeFile(target, 'sentinel\n', { mode: 0o600 });
    await chmod(target, 0o600);
    await symlink(target, path);
    const audit = new McpAuditLog(path);
    await expect(
      audit.append({
        timestamp: Date.now(),
        requestId: 'blocked',
        tool: 'sftp_stat',
        confirmation: 'not-applicable',
        outcome: 'success',
        durationMs: 1,
      }),
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('sentinel\n');
    await audit.close();
  });

  it('caps retained JSONL bytes at ten MiB when pruning', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-audit-'));
    const path = join(directory, 'audit.jsonl');
    const oversizedRecord = `${JSON.stringify({
      timestamp: Date.now(),
      requestId: 'old',
      tool: 'sftp_stat',
      operationTarget: `/${'x'.repeat(4090)}`,
      confirmation: 'not-applicable',
      outcome: 'success',
      durationMs: 1,
    })}\n`;
    const targetBytes = 10 * 1024 * 1024 + 16 * 1024;
    const count = Math.floor(targetBytes / Buffer.byteLength(oversizedRecord));
    await writeFile(path, oversizedRecord.repeat(count), { mode: 0o600 });
    await chmod(path, 0o600);
    const audit = new McpAuditLog(path);
    await audit.append({
      timestamp: Date.now(),
      requestId: 'new',
      tool: 'sftp_stat',
      confirmation: 'not-applicable',
      outcome: 'success',
      durationMs: 1,
    });
    expect((await stat(path)).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect((await audit.page()).at(0)?.requestId).toBe('new');
    await audit.close();
  });

  it('clears the audit file after its queue has drained', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easyssh-audit-'));
    const path = join(directory, 'audit.jsonl');
    const audit = new McpAuditLog(path);
    await audit.append({
      timestamp: Date.now(),
      requestId: 'clear-me',
      tool: 'sftp_stat',
      confirmation: 'not-applicable',
      outcome: 'success',
      durationMs: 1,
    });
    await audit.clear();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await audit.close();
  });
});
