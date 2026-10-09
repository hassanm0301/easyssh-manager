import { describe, expect, it } from 'vitest';

import { EasySshError } from '../../common/errors';
import {
  assertMcpAvailable,
  WINDOWS_MCP_UNAVAILABLE_MESSAGE,
} from '../../common/platformCapabilities';

describe('platform capabilities', () => {
  it('rejects Windows MCP with the stable unavailable error', () => {
    expect(() => assertMcpAvailable('win32')).toThrowError(
      expect.objectContaining({
        name: 'EasySshError',
        code: 'UNSUPPORTED',
        message: WINDOWS_MCP_UNAVAILABLE_MESSAGE,
      }),
    );
  });

  it('allows MCP setup on Linux', () => {
    expect(() => assertMcpAvailable('linux')).not.toThrow();
  });

  it('uses an actionable unsupported error for Windows audit commands too', () => {
    try {
      assertMcpAvailable('win32');
      throw new Error('expected MCP capability check to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EasySshError);
      expect(error).toMatchObject({
        code: 'UNSUPPORTED',
        message: expect.stringContaining('unavailable on Windows'),
      });
    }
  });
});
