import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MCP_COMPANION_NODE_RANGE,
  createMcpClientConfig,
  resolveExecutablePath,
  supportedCompanionNode,
} from '../../mcp/runtime';

describe('MCP companion runtime range', () => {
  it('pins the supported Node major range and rejects malformed/unsupported versions', () => {
    expect(MCP_COMPANION_NODE_RANGE).toBe('22.x, 24.x, or 26.x');
    expect(supportedCompanionNode('22.0.0')).toBe(true);
    expect(supportedCompanionNode('24.99.0')).toBe(true);
    expect(supportedCompanionNode('26.0.0')).toBe(true);
    expect(supportedCompanionNode('20.0.0')).toBe(false);
    expect(supportedCompanionNode('23.0.0')).toBe(false);
    expect(supportedCompanionNode('24.0.0-rc.1')).toBe(false);
    expect(supportedCompanionNode('v24')).toBe(false);
  });

  it('resolves executable names to absolute real paths without shell lookup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easyssh-node-path-'));
    try {
      const executable = join(directory, 'node');
      const alias = join(directory, 'node-alias');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o700);
      await symlink(executable, alias);
      await expect(resolveExecutablePath('node-alias', directory)).resolves.toBe(executable);
      await expect(resolveExecutablePath('missing-node', directory)).rejects.toThrow(
        'Executable was not found',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates a generic absolute-path client config without discovery credentials', () => {
    const config = createMcpClientConfig(
      '/usr/bin/node',
      '/opt/easyssh/dist/mcp/companion.js',
      '/home/user/.config/easyssh/mcp-discovery.json',
    );
    expect(config).toEqual({
      command: '/usr/bin/node',
      args: [
        '/opt/easyssh/dist/mcp/companion.js',
        '--discovery',
        '/home/user/.config/easyssh/mcp-discovery.json',
      ],
    });
    expect(JSON.stringify(config)).not.toMatch(/token|password|private.?key/i);
    expect(() => createMcpClientConfig('node', '/companion.js', '/discovery.json')).toThrow(
      'paths must be absolute',
    );
  });
});
