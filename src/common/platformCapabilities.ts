import { EasySshError } from './errors';

export type Platform = NodeJS.Platform;

export const WINDOWS_MCP_UNAVAILABLE_MESSAGE =
  'EasySSH MCP is unavailable on Windows in this release. Use EasySSH Manager on Linux to configure MCP.';

/** Throws before any MCP setup side effects on platforms without the security port. */
export function assertMcpAvailable(platform: Platform = process.platform): void {
  if (platform === 'win32') {
    throw new EasySshError('UNSUPPORTED', WINDOWS_MCP_UNAVAILABLE_MESSAGE);
  }
}
