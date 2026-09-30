import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { EasySshError } from '../common/errors';
import type { StateRepository } from '../connections/ports';
import type { TrustedHostKey } from '../connections/types';

export interface HostTrustPrompt {
  confirmFirstUse(details: HostKeyDetails): Promise<boolean>;
  confirmReplacement(expected: TrustedHostKey, received: HostKeyDetails): Promise<boolean>;
}

export interface HostKeyDetails {
  hostIdentity: string;
  host: string;
  port: number;
  algorithm: string;
  sha256Fingerprint: string;
}

export class HostKeyVerifier {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly state: StateRepository,
    private readonly prompt: HostTrustPrompt,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(host: string, port: number, rawKey: Uint8Array): Promise<void> {
    const details = describeHostKey(host, port, rawKey);
    const active = this.pending.get(details.hostIdentity);
    if (active) {
      await active;
      return this.verify(host, port, rawKey);
    }
    const operation = this.verifySerialized(details);
    this.pending.set(details.hostIdentity, operation);
    try {
      await operation;
    } finally {
      if (this.pending.get(details.hostIdentity) === operation)
        this.pending.delete(details.hostIdentity);
    }
  }

  private async verifySerialized(details: HostKeyDetails): Promise<void> {
    const existing = (await this.state.load()).hostKeys.find(
      (item) => item.hostIdentity === details.hostIdentity,
    );
    if (
      existing?.algorithm === details.algorithm &&
      existing.sha256Fingerprint === details.sha256Fingerprint
    ) {
      await this.state.update((draft) => {
        const record = draft.hostKeys.find((item) => item.hostIdentity === details.hostIdentity);
        if (record) record.lastSeenAt = this.now();
      });
      return;
    }
    if (!existing) {
      if (!(await this.prompt.confirmFirstUse(details))) {
        throw new EasySshError(
          'HOST_KEY_REJECTED',
          `Host-key trust was not granted for ${details.hostIdentity}.`,
        );
      }
      const timestamp = this.now();
      await this.state.update((draft) => {
        draft.hostKeys = draft.hostKeys.filter(
          (item) => item.hostIdentity !== details.hostIdentity,
        );
        draft.hostKeys.push({
          hostIdentity: details.hostIdentity,
          algorithm: details.algorithm,
          sha256Fingerprint: details.sha256Fingerprint,
          firstTrustedAt: timestamp,
          lastSeenAt: timestamp,
        });
      });
      return;
    }
    if (!(await this.prompt.confirmReplacement(existing, details))) {
      throw new EasySshError(
        'HOST_KEY_MISMATCH',
        `The host key for ${details.hostIdentity} changed. Expected ${existing.sha256Fingerprint}; received ${details.sha256Fingerprint}.`,
      );
    }
    const timestamp = this.now();
    await this.state.update((draft) => {
      const replacement = {
        hostIdentity: details.hostIdentity,
        algorithm: details.algorithm,
        sha256Fingerprint: details.sha256Fingerprint,
        firstTrustedAt: timestamp,
        lastSeenAt: timestamp,
      };
      const index = draft.hostKeys.findIndex((item) => item.hostIdentity === details.hostIdentity);
      if (index < 0) draft.hostKeys.push(replacement);
      else draft.hostKeys.splice(index, 1, replacement);
    });
  }
}

export function normalizeHostIdentity(host: string, port: number): string {
  let normalized = host.trim();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  normalized = normalized.toLowerCase();
  if (isIP(normalized) === 6) {
    const canonical = new URL(`http://[${normalized}]/`).hostname;
    return `${canonical}:${port}`;
  }
  if (isIP(normalized) === 4)
    normalized = normalized
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  else normalized = normalized.replace(/\.$/, '');
  return `${normalized}:${port}`;
}

export function sha256Fingerprint(rawKey: Uint8Array): string {
  return `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`;
}

export function hostKeyAlgorithm(rawKey: Uint8Array): string {
  const bytes = Buffer.from(rawKey.buffer, rawKey.byteOffset, rawKey.byteLength);
  if (bytes.byteLength < 5)
    throw new EasySshError('HOST_KEY_MISMATCH', 'The server presented an invalid host key.');
  const length = bytes.readUInt32BE(0);
  if (length < 1 || length > bytes.byteLength - 4 || length > 255)
    throw new EasySshError('HOST_KEY_MISMATCH', 'The server presented an invalid host key.');
  const algorithm = bytes.subarray(4, 4 + length).toString('ascii');
  if (!/^[a-z0-9@._+-]+$/i.test(algorithm))
    throw new EasySshError('HOST_KEY_MISMATCH', 'The server presented an invalid host key.');
  return algorithm;
}

function describeHostKey(host: string, port: number, rawKey: Uint8Array): HostKeyDetails {
  return {
    hostIdentity: normalizeHostIdentity(host, port),
    host,
    port,
    algorithm: hostKeyAlgorithm(rawKey),
    sha256Fingerprint: sha256Fingerprint(rawKey),
  };
}
