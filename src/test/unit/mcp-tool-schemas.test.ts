import { describe, expect, it } from 'vitest';

import { mcpToolSchemas } from '../../mcp/toolSchemas';

const id = '11111111-1111-4111-8111-111111111111';

describe('MCP tool input schemas', () => {
  it('requires strict discovery and exec contracts with UTF-8 command bounds', () => {
    expect(mcpToolSchemas.remote_list_connections.safeParse({}).success).toBe(true);
    expect(mcpToolSchemas.remote_list_connections.safeParse({ connectionId: id }).success).toBe(
      false,
    );
    expect(
      mcpToolSchemas.ssh_exec.safeParse({ connectionId: id, command: 'é'.repeat(16385) }).success,
    ).toBe(false);
    expect(mcpToolSchemas.ssh_exec.safeParse({ connectionId: id, command: 'x\0y' }).success).toBe(
      false,
    );
    expect(
      mcpToolSchemas.ssh_exec.safeParse({ connectionId: id, command: 'id', timeoutMs: 300001 })
        .success,
    ).toBe(false);
  });

  it('normalizes validated remote paths and rejects traversal/relative paths', () => {
    expect(mcpToolSchemas.sftp_list.parse({ connectionId: id, path: '/srv/./data' }).path).toBe(
      '/srv/data',
    );
    expect(
      mcpToolSchemas.sftp_list.safeParse({ connectionId: id, path: '/../../etc' }).success,
    ).toBe(false);
    expect(mcpToolSchemas.sftp_list.safeParse({ connectionId: id, path: 'relative' }).success).toBe(
      false,
    );
  });

  it('bounds ranged reads and rejects non-canonical or oversized writes', () => {
    expect(
      mcpToolSchemas.sftp_read.safeParse({ connectionId: id, path: '/', encoding: 'utf8' }).success,
    ).toBe(true);
    expect(
      mcpToolSchemas.sftp_read.safeParse({
        connectionId: id,
        path: '/',
        encoding: 'base64',
        length: 4 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(
      mcpToolSchemas.sftp_write.safeParse({
        connectionId: id,
        path: '/new',
        encoding: 'base64',
        data: 'YQ==',
      }).success,
    ).toBe(true);
    expect(
      mcpToolSchemas.sftp_write.safeParse({
        connectionId: id,
        path: '/new',
        encoding: 'base64',
        data: 'YQ',
      }).success,
    ).toBe(false);
    expect(
      mcpToolSchemas.sftp_write.safeParse({
        connectionId: id,
        path: '/new',
        encoding: 'utf8',
        data: 'x'.repeat(20 * 1024 * 1024 + 1),
      }).success,
    ).toBe(false);
  });
});
