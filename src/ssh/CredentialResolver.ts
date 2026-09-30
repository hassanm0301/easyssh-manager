import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import { utils as ssh2Utils } from 'ssh2';

import { EasySshError } from '../common/errors';
import type { CredentialStore } from '../connections/ports';
import type { RemoteConnection } from '../connections/types';
import type {
  CredentialLease,
  CredentialResolver,
  CredentialScope,
  TransientCredentials,
} from './ports';

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;

export interface CredentialPrompt {
  showInputBox(options: {
    prompt: string;
    password: true;
    ignoreFocusOut: true;
  }): PromiseLike<string | undefined>;
}

export class DefaultCredentialResolver implements CredentialResolver {
  constructor(
    private readonly store: CredentialStore,
    private readonly prompt: CredentialPrompt,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async acquire(
    connection: RemoteConnection,
    _scope: CredentialScope,
    transient: Readonly<TransientCredentials> = {},
  ): Promise<CredentialLease> {
    if (connection.authentication.type === 'password') {
      const password =
        transient.password === null
          ? await this.ask(`Password for ${connection.name}`)
          : (transient.password ??
            (await this.store.getPassword(connection.id)) ??
            (await this.ask(`Password for ${connection.name}`)));
      if (!password)
        throw new EasySshError(
          'MISSING_CREDENTIAL',
          `A password is required for ${connection.name}.`,
        );
      return new MutableCredentialLease({ password });
    }

    if (connection.authentication.type === 'agent') {
      const agentSocket = this.environment.SSH_AUTH_SOCK?.trim();
      if (!agentSocket)
        throw new EasySshError(
          'MISSING_CREDENTIAL',
          `SSH agent authentication is selected for ${connection.name}, but SSH_AUTH_SOCK is not set.`,
        );
      return new MutableCredentialLease({ agentSocket });
    }

    const path = expandPrivateKeyPath(connection.authentication.privateKeyPath);
    let bytes: Buffer;
    try {
      const stat = await lstat(path);
      if (!stat.isFile())
        throw new EasySshError(
          'INVALID_KEY',
          `The private-key path for ${connection.name} is not a file.`,
        );
      if (stat.size > MAX_PRIVATE_KEY_BYTES)
        throw new EasySshError(
          'INVALID_KEY',
          `The private key for ${connection.name} exceeds 1 MiB.`,
        );
      bytes = await readFile(path);
      if (bytes.byteLength > MAX_PRIVATE_KEY_BYTES)
        throw new EasySshError(
          'INVALID_KEY',
          `The private key for ${connection.name} exceeds 1 MiB.`,
        );
    } catch (error) {
      if (error instanceof EasySshError) throw error;
      throw new EasySshError(
        'INVALID_KEY',
        `Unable to read the private key for ${connection.name}.`,
      );
    }

    let passphrase =
      transient.passphrase === null
        ? undefined
        : (transient.passphrase ?? (await this.store.getKeyPassphrase(connection.id)));
    let parsed = ssh2Utils.parseKey(bytes, passphrase);
    if (parsed instanceof Error && passphrase === undefined && isEncryptedKeyError(parsed)) {
      passphrase = await this.ask(`Passphrase for ${connection.name}`);
      if (!passphrase) {
        bytes.fill(0);
        throw new EasySshError(
          'MISSING_CREDENTIAL',
          `A private-key passphrase is required for ${connection.name}.`,
        );
      }
      parsed = ssh2Utils.parseKey(bytes, passphrase);
    }
    if (parsed instanceof Error) {
      bytes.fill(0);
      throw new EasySshError(
        'INVALID_KEY',
        passphrase
          ? `The private key or passphrase for ${connection.name} is invalid.`
          : `The private key for ${connection.name} is invalid.`,
      );
    }
    return new MutableCredentialLease({ privateKey: bytes, ...(passphrase ? { passphrase } : {}) });
  }

  private async ask(prompt: string): Promise<string | undefined> {
    return this.prompt.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  }
}

export function expandPrivateKeyPath(value: string): string {
  const expanded =
    value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
  return normalize(isAbsolute(expanded) ? expanded : resolve(expanded));
}

function isEncryptedKeyError(error: Error): boolean {
  return /encrypted|passphrase/i.test(error.message);
}

class MutableCredentialLease implements CredentialLease {
  readonly password?: string;
  readonly privateKey?: Uint8Array;
  readonly passphrase?: string;
  readonly agentSocket?: string;
  private disposed = false;

  constructor(values: {
    password?: string;
    privateKey?: Uint8Array;
    passphrase?: string;
    agentSocket?: string;
  }) {
    Object.defineProperties(this, {
      password: { value: values.password, enumerable: false, configurable: true },
      privateKey: { value: values.privateKey, enumerable: false, configurable: true },
      passphrase: { value: values.passphrase, enumerable: false, configurable: true },
      agentSocket: { value: values.agentSocket, enumerable: false, configurable: true },
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.privateKey?.fill(0);
    for (const field of ['password', 'privateKey', 'passphrase', 'agentSocket'])
      Reflect.deleteProperty(this, field);
  }
}
