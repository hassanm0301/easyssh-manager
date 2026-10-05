export const MCP_COMPANION_NODE_RANGE = '>=20 <24';

export function supportedCompanionNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major >= 20 && major < 24;
}
