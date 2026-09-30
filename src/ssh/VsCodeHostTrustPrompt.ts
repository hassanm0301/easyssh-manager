import type * as vscode from 'vscode';

import type { TrustedHostKey } from '../connections/types';
import type { HostKeyDetails, HostTrustPrompt } from './HostKeyVerifier';

export class VsCodeHostTrustPrompt implements HostTrustPrompt {
  constructor(private readonly vscodeApi: typeof vscode) {}

  async confirmFirstUse(details: HostKeyDetails): Promise<boolean> {
    const choice = await this.vscodeApi.window.showWarningMessage(
      `First connection to ${details.host}:${details.port}. Host key ${details.algorithm} ${details.sha256Fingerprint}`,
      {
        modal: true,
        detail: 'Verify this fingerprint with the server administrator before continuing.',
      },
      'Trust and Continue',
    );
    return choice === 'Trust and Continue';
  }

  async confirmReplacement(expected: TrustedHostKey, received: HostKeyDetails): Promise<boolean> {
    const review = await this.vscodeApi.window.showErrorMessage(
      `WARNING: The host key for ${received.hostIdentity} has changed.`,
      {
        modal: true,
        detail: `Expected ${expected.algorithm} ${expected.sha256Fingerprint}\nReceived ${received.algorithm} ${received.sha256Fingerprint}`,
      },
      'Review Trust New Key',
    );
    if (review !== 'Review Trust New Key') return false;
    const confirmation = await this.vscodeApi.window.showWarningMessage(
      `Replace the trusted host key for ${received.hostIdentity}?`,
      {
        modal: true,
        detail: 'Only continue if the server administrator confirmed this host-key change.',
      },
      'Trust New Key',
    );
    return confirmation === 'Trust New Key';
  }
}
