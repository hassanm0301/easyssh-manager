import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';

import { EasySshError } from '../common/errors';
import type { CancellationTokenLike, ExecOptions, PtyOptions } from './ports';

interface OperationOptions<T> {
  timeoutMs: number;
  cancellation?: CancellationTokenLike;
  disposeLateValue(value: T): void;
}

export function openShell(
  client: Client,
  options: PtyOptions,
  operation?: OperationOptions<ClientChannel>,
): Promise<ClientChannel> {
  return callbackOnce<ClientChannel>(
    (done) =>
      client.shell(
        {
          term: options.terminal ?? 'xterm-256color',
          cols: options.columns,
          rows: options.rows,
          width: 0,
          height: 0,
        },
        done,
      ),
    operation,
  );
}

export function openSftp(
  client: Client,
  operation?: OperationOptions<SFTPWrapper>,
): Promise<SFTPWrapper> {
  return callbackOnce<SFTPWrapper>((done) => client.sftp(done), operation);
}

export function openExec(
  client: Client,
  options: ExecOptions,
  operation?: OperationOptions<ClientChannel>,
): Promise<ClientChannel> {
  return callbackOnce<ClientChannel>((done) => client.exec(options.command, done), operation);
}

export function callbackOnce<T>(
  register: (callback: (error: Error | undefined, value: T) => void) => unknown,
  options?: OperationOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let cancellationSubscription: { dispose(): void } | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      cancellationSubscription?.dispose();
    };
    const fail = (error: EasySshError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const settle = (error: Error | undefined, value: T): void => {
      if (settled) {
        if (!error) options?.disposeLateValue(value);
        return;
      }
      settled = true;
      cleanup();
      if (error)
        reject(
          new EasySshError('CHANNEL_REJECTED', 'The SSH server rejected the requested channel.'),
        );
      else resolve(value);
    };
    if (options?.cancellation?.isCancellationRequested) {
      fail(new EasySshError('CANCELLED', 'SSH channel request cancelled.'));
      return;
    }
    if (options) {
      timer = setTimeout(
        () => fail(new EasySshError('TIMEOUT', 'The SSH channel request timed out.')),
        options.timeoutMs,
      );
      cancellationSubscription = options.cancellation?.onCancellationRequested(() =>
        fail(new EasySshError('CANCELLED', 'SSH channel request cancelled.')),
      );
    }
    try {
      register(settle);
    } catch {
      settle(new Error('channel setup failed'), undefined as T);
    }
  });
}
