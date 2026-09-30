import { describe, expect, it, vi } from 'vitest';

import { EasySshError } from '../../common/errors';
import type { StateChange, StateRepository } from '../../connections/ports';
import { emptyPersistedState, type PersistedStateV1 } from '../../connections/types';
import {
  HostKeyVerifier,
  hostKeyAlgorithm,
  normalizeHostIdentity,
  sha256Fingerprint,
  type HostTrustPrompt,
} from '../../ssh/HostKeyVerifier';

class MemoryState implements StateRepository {
  value = emptyPersistedState();
  failWrites = false;
  readonly onDidChange = (listener: (change: StateChange) => unknown) => {
    void listener;
    return { dispose: () => undefined };
  };
  async load(): Promise<Readonly<PersistedStateV1>> {
    return structuredClone(this.value);
  }
  async update(mutator: (draft: PersistedStateV1) => void): Promise<void> {
    const draft = structuredClone(this.value);
    mutator(draft);
    if (this.failWrites) throw new Error('persistence failed');
    this.value = draft;
  }
}

const rawKey = (algorithm = 'ssh-ed25519', marker = 1): Buffer => {
  const name = Buffer.from(algorithm);
  const result = Buffer.alloc(4 + name.length + 4);
  result.writeUInt32BE(name.length, 0);
  name.copy(result, 4);
  result.writeUInt32BE(marker, 4 + name.length);
  return result;
};

describe('host-key verification', () => {
  it('normalizes DNS, IPv4, bracketed IPv6, and ports unambiguously', () => {
    expect(normalizeHostIdentity('EXAMPLE.COM.', 22)).toBe('example.com:22');
    expect(normalizeHostIdentity('127.0.0.1', 2222)).toBe('127.0.0.1:2222');
    expect(normalizeHostIdentity('[2001:DB8::1]', 22)).toBe('[2001:db8::1]:22');
    expect(normalizeHostIdentity('2001:0db8:0:0::1', 22)).toBe('[2001:db8::1]:22');
  });

  it('derives the algorithm and OpenSSH SHA-256 fingerprint from raw bytes', () => {
    const key = rawKey();
    expect(hostKeyAlgorithm(key)).toBe('ssh-ed25519');
    expect(sha256Fingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(sha256Fingerprint(key)).not.toContain('=');
  });

  it('persists first trust, updates a match, and requires destructive replacement', async () => {
    const state = new MemoryState();
    const first = vi.fn(async () => true);
    const replace = vi.fn(async () => false);
    let now = 10;
    const verifier = new HostKeyVerifier(
      state,
      { confirmFirstUse: first, confirmReplacement: replace },
      () => now,
    );
    const original = rawKey('ssh-ed25519', 1);
    await verifier.verify('Host.Example', 22, original);
    expect(first).toHaveBeenCalledOnce();
    expect(state.value.hostKeys[0]).toEqual({
      hostIdentity: 'host.example:22',
      algorithm: 'ssh-ed25519',
      sha256Fingerprint: sha256Fingerprint(original),
      firstTrustedAt: 10,
      lastSeenAt: 10,
    });
    now = 20;
    await verifier.verify('host.example', 22, original);
    expect(first).toHaveBeenCalledOnce();
    expect(state.value.hostKeys[0]?.lastSeenAt).toBe(20);

    const changed = rawKey('ssh-rsa', 2);
    await expect(verifier.verify('host.example', 22, changed)).rejects.toMatchObject({
      code: 'HOST_KEY_MISMATCH',
    });
    replace.mockResolvedValueOnce(true);
    now = 30;
    await verifier.verify('host.example', 22, changed);
    expect(state.value.hostKeys).toEqual([
      expect.objectContaining({
        algorithm: 'ssh-rsa',
        sha256Fingerprint: sha256Fingerprint(changed),
        firstTrustedAt: 30,
      }),
    ]);
  });

  it('coalesces concurrent first-use prompts and does not accept failed persistence', async () => {
    const state = new MemoryState();
    let release!: (accepted: boolean) => void;
    const decision = new Promise<boolean>((resolve) => (release = resolve));
    const prompt: HostTrustPrompt = {
      confirmFirstUse: vi.fn(() => decision),
      confirmReplacement: vi.fn(async () => false),
    };
    const verifier = new HostKeyVerifier(state, prompt);
    const key = rawKey();
    const attempts = [
      verifier.verify('same.example', 22, key),
      verifier.verify('same.example', 22, key),
    ];
    await Promise.resolve();
    release(true);
    await Promise.all(attempts);
    expect(prompt.confirmFirstUse).toHaveBeenCalledOnce();

    const failing = new MemoryState();
    failing.failWrites = true;
    const cannotPersist = new HostKeyVerifier(failing, {
      confirmFirstUse: async () => true,
      confirmReplacement: async () => true,
    });
    await expect(cannotPersist.verify('new.example', 22, key)).rejects.toThrow(
      'persistence failed',
    );
    expect(failing.value.hostKeys).toEqual([]);
  });

  it('maps a cancelled first-use decision to a stable domain failure', async () => {
    const verifier = new HostKeyVerifier(new MemoryState(), {
      confirmFirstUse: async () => false,
      confirmReplacement: async () => false,
    });
    await expect(verifier.verify('cancel.example', 22, rawKey())).rejects.toEqual(
      expect.objectContaining<Partial<EasySshError>>({ code: 'HOST_KEY_REJECTED' }),
    );
  });
});
