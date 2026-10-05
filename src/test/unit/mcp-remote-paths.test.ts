import { describe, expect, it } from 'vitest';

import {
  isPathWithinRoot,
  normalizeAbsoluteRemotePath,
  normalizeAllowedRoot,
} from '../../mcp/remotePaths';

describe('MCP remote path normalization', () => {
  it('normalizes absolute POSIX paths while rejecting above-root traversal', () => {
    expect(normalizeAbsoluteRemotePath('/srv/data/./folder/../file')).toBe('/srv/data/file');
    expect(normalizeAbsoluteRemotePath('/')).toBe('/');
    expect(() => normalizeAbsoluteRemotePath('../srv')).toThrow();
    expect(() => normalizeAbsoluteRemotePath('/../../srv')).toThrow();
    expect(() => normalizeAbsoluteRemotePath('srv/data')).toThrow();
    expect(() => normalizeAbsoluteRemotePath('/srv/\0data')).toThrow();
    expect(() => normalizeAllowedRoot('relative')).toThrow();
  });

  it('uses equality or segment containment instead of lexical prefixes', () => {
    expect(isPathWithinRoot('/app', '/app')).toBe(true);
    expect(isPathWithinRoot('/app/file', '/app')).toBe(true);
    expect(isPathWithinRoot('/application/file', '/app')).toBe(false);
  });
});
