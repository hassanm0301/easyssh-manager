import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('OpenSSH integration fixture', () => {
  it('includes a deterministic fixture definition without credentials', () => {
    const dockerfile = resolve(process.cwd(), 'test/fixtures/openssh/Dockerfile');
    const configuration = resolve(process.cwd(), 'test/fixtures/openssh/sshd_config');
    expect(existsSync(dockerfile)).toBe(true);
    expect(existsSync(configuration)).toBe(true);
    const dockerText = readFileSync(dockerfile, 'utf8');
    const configText = readFileSync(configuration, 'utf8');
    expect(dockerText).toContain('FROM ubuntu:24.04');
    expect(dockerText).not.toMatch(/COPY\s+.*\.(?:pem|key)/i);
    expect(configText).toMatch(/^Port 2222$/m);
    expect(configText).toMatch(/^PasswordAuthentication yes$/m);
    expect(configText).toMatch(/^KbdInteractiveAuthentication no$/m);
    expect(configText).toMatch(/^PubkeyAuthentication yes$/m);
    expect(configText).toMatch(/^Subsystem sftp internal-sftp$/m);
    expect(configText).toMatch(/^PermitRootLogin no$/m);
  });
});
