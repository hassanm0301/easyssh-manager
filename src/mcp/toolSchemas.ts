import { z } from 'zod';

import { normalizeAbsoluteRemotePath } from './remotePaths';

const connectionId = z.string().uuid();
const remotePath = z
  .string()
  .min(1)
  .max(4096)
  .transform((value, context) => {
    try {
      return normalizeAbsoluteRemotePath(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected a valid absolute POSIX path.' });
      return z.NEVER;
    }
  });
const maxWriteBytes = 20 * 1024 * 1024;

export const remoteListConnectionsSchema = z.object({}).strict();

export const sshExecSchema = z
  .object({
    connectionId,
    command: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= 32768 && !value.includes('\0')),
    cwd: remotePath.optional(),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  })
  .strict();

export const sftpListSchema = z.object({ connectionId, path: remotePath }).strict();
export const sftpStatSchema = z.object({ connectionId, path: remotePath }).strict();
export const sftpReadSchema = z
  .object({
    connectionId,
    path: remotePath,
    encoding: z.enum(['utf8', 'base64']),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    length: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  })
  .strict();

export const sftpWriteInputSchema = z
  .object({
    connectionId,
    path: remotePath,
    encoding: z.enum(['utf8', 'base64']),
    data: z.string().max(Math.ceil(maxWriteBytes / 3) * 4),
    expectedVersion: z.string().min(1).max(256).optional(),
    force: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.encoding === 'utf8') {
      if (Buffer.byteLength(value.data, 'utf8') > maxWriteBytes)
        context.addIssue({ code: 'custom', path: ['data'], message: 'Write exceeds 20 MiB.' });
      return;
    }
    if (
      value.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'Expected canonical base64 data.',
      });
      return;
    }
    const decodedLength =
      value.data.length === 0
        ? 0
        : (value.data.length / 4) * 3 -
          (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0);
    if (
      decodedLength > maxWriteBytes ||
      Buffer.from(value.data, 'base64').toString('base64') !== value.data
    )
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'Write exceeds 20 MiB or is not canonical base64.',
      });
  });

export const sftpMkdirSchema = z.object({ connectionId, path: remotePath }).strict();
export const sftpRenameSchema = z
  .object({ connectionId, source: remotePath, destination: remotePath })
  .strict();
export const sftpDeleteSchema = z
  .object({ connectionId, path: remotePath, recursive: z.boolean().default(false) })
  .strict();

export const mcpToolSchemas = {
  remote_list_connections: remoteListConnectionsSchema,
  ssh_exec: sshExecSchema,
  sftp_list: sftpListSchema,
  sftp_stat: sftpStatSchema,
  sftp_read: sftpReadSchema,
  sftp_write: sftpWriteInputSchema,
  sftp_mkdir: sftpMkdirSchema,
  sftp_rename: sftpRenameSchema,
  sftp_delete: sftpDeleteSchema,
} as const;

export type McpToolName = keyof typeof mcpToolSchemas;
