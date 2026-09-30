import { EasySshError, isCancellation } from '../common/errors';
import type { EasySshLogger } from '../common/logger';

export interface CommandDefinition<TArgs extends unknown[], TResult> {
  readonly id: `easysshManager.${string}`;
  execute(...args: TArgs): Promise<TResult>;
}

export interface Disposable {
  dispose(): void;
}

export interface CommandHost {
  registerCommand(id: string, callback: (...args: unknown[]) => Promise<unknown>): Disposable;
  showErrorMessage(message: string): Thenable<unknown>;
  showInformationMessage(message: string): Thenable<unknown>;
}

export class CommandRegistry implements Disposable {
  private readonly registrations: Disposable[] = [];

  constructor(
    private readonly host: CommandHost,
    private readonly logger: EasySshLogger,
    private readonly correlationId: () => string = createCorrelationId,
  ) {}

  register<TArgs extends unknown[], TResult>(definition: CommandDefinition<TArgs, TResult>): void {
    this.registrations.push(
      this.host.registerCommand(definition.id, async (...args: unknown[]) => {
        const reference = this.correlationId();
        try {
          return await definition.execute(...(args as TArgs));
        } catch (error: unknown) {
          this.presentFailure(error, definition.id, reference);
          return undefined;
        }
      }),
    );
  }

  dispose(): void {
    for (const registration of this.registrations.splice(0).reverse()) {
      registration.dispose();
    }
  }

  private presentFailure(error: unknown, command: string, reference: string): void {
    if (isCancellation(error)) {
      this.logger.info('Command cancelled', { operation: command, correlationId: reference });
      void this.host.showInformationMessage(
        `EasySSH Manager: Operation cancelled (reference ${reference}).`,
      );
      return;
    }
    if (error instanceof EasySshError) {
      this.logger.warn('Command failed', {
        operation: command,
        correlationId: reference,
        code: error.code,
      });
      void this.host.showErrorMessage(
        `EasySSH Manager: ${error.message} (reference ${reference}).`,
      );
      return;
    }
    this.logger.error('Unexpected command failure', {
      operation: command,
      correlationId: reference,
      code: 'UNKNOWN',
    });
    void this.host.showErrorMessage(
      `EasySSH Manager: An unexpected error occurred. Review the EasySSH Manager output (reference ${reference}).`,
    );
  }
}

function createCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
