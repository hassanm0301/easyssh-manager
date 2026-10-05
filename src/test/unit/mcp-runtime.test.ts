import { describe, expect, it } from 'vitest';

import { MCP_COMPANION_NODE_RANGE, supportedCompanionNode } from '../../mcp/runtime';

describe('MCP companion runtime range', () => {
  it('pins the supported Node major range and rejects malformed/unsupported versions', () => {
    expect(MCP_COMPANION_NODE_RANGE).toBe('>=20 <24');
    expect(supportedCompanionNode('20.0.0')).toBe(true);
    expect(supportedCompanionNode('23.99.0')).toBe(true);
    expect(supportedCompanionNode('19.9.9')).toBe(false);
    expect(supportedCompanionNode('24.0.0')).toBe(false);
    expect(supportedCompanionNode('v20')).toBe(false);
  });
});
