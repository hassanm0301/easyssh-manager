import { createHmac, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface McpAuditRecord {
  timestamp: number;
  requestId: string;
  connectionId?: string;
  connectionNameSnapshot?: string;
  tool: string;
  operationTarget?: string;
  commandFingerprint?: string;
  confirmation: 'always' | 'destructive' | 'never' | 'not-applicable';
  outcome: 'success' | 'denied' | 'error';
  errorCode?: string;
  durationMs: number;
}

/** Bounded metadata-only JSONL audit storage. */
export class McpAuditLog {
  private queue: Promise<void> = Promise.resolve();
  private readonly key = randomBytes(32);
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  fingerprint(command: string): string {
    return createHmac('sha256', this.key).update(command).digest('hex');
  }

  append(record: McpAuditRecord): Promise<void> {
    const safe = sanitizeRecord(record);
    const operation = this.queue.then(async () => {
      const parent = dirname(this.path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await this.prune();
      const handle = await open(
        this.path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          (info.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())
        )
          throw new Error('MCP audit file permissions are unsafe.');
        await handle.writeFile(`${JSON.stringify(safe)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async page(offset = 0, limit = 100): Promise<readonly McpAuditRecord[]> {
    await this.queue;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Invalid audit page.');
    let text: string;
    try {
      text = (await readAuditBytes(this.path)).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) text = text.slice(-10 * 1024 * 1024);
    const rows: McpAuditRecord[] = [];
    for (const line of text.split('\n').slice(0, -1)) {
      try {
        rows.push(sanitizeRecord(JSON.parse(line) as McpAuditRecord));
      } catch {
        /* skip malformed/partial records */
      }
    }
    return rows.reverse().slice(offset, offset + limit);
  }

  async clear(): Promise<void> {
    await this.queue;
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async close(): Promise<void> {
    await this.queue;
    this.key.fill(0);
  }

  private async prune(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readAuditBytes(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const cutoff = this.now() - 30 * 24 * 60 * 60 * 1000;
    const rows: string[] = [];
    for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
      try {
        const record = sanitizeRecord(JSON.parse(line) as McpAuditRecord);
        if (record.timestamp >= cutoff) rows.push(JSON.stringify(record));
      } catch {
        /* discard malformed records */
      }
    }
    let result = Buffer.from(rows.length ? `${rows.join('\n')}\n` : '', 'utf8');
    const retainedLimit = 10 * 1024 * 1024 - 32 * 1024;
    if (result.length > retainedLimit) result = result.subarray(result.length - retainedLimit);
    const temp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(result);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, this.path).catch(async (error: unknown) => {
      await unlink(temp).catch(() => undefined);
      throw error;
    });
  }
}

async function readAuditBytes(path: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 10 * 1024 * 1024 + 32 * 1024 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw new Error('MCP audit file is unsafe or exceeds its size limit.');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sanitizeRecord(input: McpAuditRecord): McpAuditRecord {
  const record: McpAuditRecord = {
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
    requestId: safeString(input.requestId, 128),
    tool: safeString(input.tool, 64),
    confirmation: ['always', 'destructive', 'never', 'not-applicable'].includes(input.confirmation)
      ? input.confirmation
      : 'not-applicable',
    outcome: ['success', 'denied', 'error'].includes(input.outcome) ? input.outcome : 'error',
    durationMs: Math.max(0, Math.min(86_400_000, Math.trunc(input.durationMs || 0))),
  };
  if (input.connectionId && /^[0-9a-f-]{36}$/i.test(input.connectionId))
    record.connectionId = input.connectionId;
  if (input.connectionNameSnapshot)
    record.connectionNameSnapshot = safeString(input.connectionNameSnapshot, 128);
  if (input.operationTarget?.startsWith('/'))
    record.operationTarget = safeString(input.operationTarget, 4096);
  if (input.commandFingerprint && /^[0-9a-f]{64}$/.test(input.commandFingerprint))
    record.commandFingerprint = input.commandFingerprint;
  if (input.errorCode && /^[A-Z_]{1,64}$/.test(input.errorCode)) record.errorCode = input.errorCode;
  return record;
}
function safeString(value: string, max: number): string {
  return [...String(value ?? '')]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('')
    .slice(0, max);
}
