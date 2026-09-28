import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('OpenSSH integration fixture', () => {
  it('includes a deterministic fixture definition without credentials', () => {
    expect(existsSync(resolve(process.cwd(), 'test/fixtures/openssh/Dockerfile'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'test/fixtures/openssh/sshd_config'))).toBe(true);
  });
});
