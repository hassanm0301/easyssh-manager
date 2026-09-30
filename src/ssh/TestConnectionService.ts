import { performance } from 'node:perf_hooks';

import { EasySshError } from '../common/errors';
import type { RemoteConnection } from '../connections/types';
import type {
  ConnectionPurpose,
  ConnectionResolver,
  SftpSubsystemHandle,
  SshSessionManager,
} from './ports';

export interface TestConnectionResult {
  stages: readonly string[];
  durationMs: number;
}

export class TestConnectionService {
  constructor(
    private readonly sessions: SshSessionManager,
    private readonly connections: ConnectionResolver,
    private readonly operationTimeoutMs = 30_000,
  ) {}

  async testSaved(connectionId: string, scopeId: string): Promise<TestConnectionResult> {
    const connection = await this.connections.resolve(connectionId);
    return this.run(connection.defaultRemotePath, () =>
      this.sessions.connect(connectionId, { kind: 'test', scopeId }),
    );
  }

  async testCandidate(
    connection: RemoteConnection,
    purpose: ConnectionPurpose,
  ): Promise<TestConnectionResult> {
    return this.run(connection.defaultRemotePath, () =>
      this.sessions.connectCandidate(connection, purpose),
    );
  }

  private async run(
    remotePath: string,
    connect: () => ReturnType<SshSessionManager['connect']>,
  ): Promise<TestConnectionResult> {
    const started = performance.now();
    const stages: string[] = ['Metadata and credentials validated'];
    let handle: Awaited<ReturnType<SshSessionManager['connect']>> | undefined;
    let subsystem: SftpSubsystemHandle | undefined;
    try {
      handle = await connect();
      stages.push('SSH host trust and authentication succeeded');
      subsystem = await handle.openSftp();
      stages.push('SFTP subsystem opened');
      const connectionPath = await realpath(subsystem, remotePath, this.operationTimeoutMs);
      await readdir(subsystem, connectionPath, this.operationTimeoutMs);
      stages.push(`Default remote path is accessible`);
      return { stages, durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      const stage = stageName(stages);
      if (error instanceof EasySshError)
        throw new EasySshError(
          error.code,
          `Connection test failed during ${stage}: ${error.message}`,
        );
      throw new EasySshError('CHANNEL_REJECTED', `Connection test failed during ${stage}.`);
    } finally {
      if (subsystem) await Promise.resolve(subsystem[Symbol.asyncDispose]()).catch(() => undefined);
      if (handle) await Promise.resolve(handle[Symbol.asyncDispose]()).catch(() => undefined);
    }
  }
}

function realpath(handle: SftpSubsystemHandle, path: string, timeoutMs: number): Promise<string> {
  return sftpOperation(
    (done) => handle.sftp.realpath(path, done),
    timeoutMs,
    'Unable to resolve the default remote path.',
  );
}

function readdir(handle: SftpSubsystemHandle, path: string, timeoutMs: number): Promise<void> {
  return sftpOperation(
    (done) =>
      handle.sftp.readdir(path, (error) => {
        done(error, undefined);
      }),
    timeoutMs,
    'Unable to list the default remote path.',
  );
}

function sftpOperation<T>(
  register: (done: (error: Error | undefined, result: T) => void) => void,
  timeoutMs: number,
  failureMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new EasySshError('TIMEOUT', 'The SFTP operation timed out.'));
    }, timeoutMs);
    const done = (error: Error | undefined, result: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new EasySshError('CHANNEL_REJECTED', failureMessage));
      else resolve(result);
    };
    try {
      register(done);
    } catch {
      done(new Error('SFTP operation failed.'), undefined as T);
    }
  });
}

function stageName(stages: readonly string[]): string {
  if (stages.length < 2) return 'connection setup';
  if (stages.length < 3) return 'SFTP startup';
  return 'remote path validation';
}
