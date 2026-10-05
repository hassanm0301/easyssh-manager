import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

export const MCP_COMPANION_NODE_RANGE = '22.x, 24.x, or 26.x';

export function supportedCompanionNode(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major === 22 || major === 24 || major === 26;
}

/** Resolves a user-selected executable without invoking a shell. */
export async function resolveExecutablePath(
  command: string,
  pathValue = process.env.PATH ?? '',
  cwd = process.cwd(),
): Promise<string> {
  const value = command.trim();
  if (!value || value.includes('\0')) throw new Error('Executable path is invalid.');
  const candidates = isAbsolute(value)
    ? [value]
    : value.includes(sep)
      ? [resolve(cwd, value)]
      : pathValue
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, value));
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      await access(candidate, fsConstants.X_OK);
      if (details.isFile()) return await realpath(candidate);
    } catch {
      // Continue through PATH candidates without exposing filesystem details.
    }
  }
  throw new Error('Executable was not found or is not runnable.');
}

export function createMcpClientConfig(
  nodePath: string,
  companionPath: string,
  discoveryPath: string,
): { command: string; args: string[] } {
  if (![nodePath, companionPath, discoveryPath].every(isAbsolute))
    throw new Error('MCP launch configuration paths must be absolute.');
  return { command: nodePath, args: [companionPath, '--discovery', discoveryPath] };
}
