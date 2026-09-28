import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  validateEditorInput,
  validateEditorMessage,
} from '../../views/connections/ConnectionEditor';
import { validateImportMessage } from '../../views/connections/ImportPreview';
import { defaultAgentAccessPolicy } from '../../connections/types';

const baseInput = {
  name: 'server',
  folderId: null,
  host: '2001:db8::1',
  port: 22,
  username: 'user',
  defaultRemotePath: '/',
  authentication: { type: 'agent' },
  agentAccess: defaultAgentAccessPolicy(),
  options: {},
};

describe('connection editor runtime validation', () => {
  it('accepts IPv6-shaped form data and rejects mass-assignment fields', () => {
    expect(validateEditorInput(baseInput)).toMatchObject({ host: '2001:db8::1', port: 22 });
    expect(() => validateEditorInput({ ...baseInput, createdAt: 0 })).toThrow(
      'Unsupported connection form field',
    );
  });

  it('requires exact correlated operations and non-empty replacement secrets', () => {
    expect(() =>
      validateEditorMessage({
        requestId: '1',
        type: 'save',
        value: baseInput,
        password: { action: 'keep', value: 'smuggled' },
        passphrase: { action: 'keep' },
      }),
    ).toThrow('Invalid credential operation');
    expect(() => validateEditorMessage({ requestId: '1', type: 'test', privileged: true })).toThrow(
      'Invalid editor operation',
    );
  });
});

describe('import preview runtime validation', () => {
  const candidate = {
    candidateId: 'candidate',
    sourcePath: '/home/user/.ssh/config',
    hostPattern: 'server',
    name: 'server',
    host: 'server.local',
    port: 22,
    username: 'user',
    identityFiles: ['/home/user/.ssh/id_ed25519'],
    selectedIdentityFile: '/home/user/.ssh/id_ed25519',
    selectedAuthentication: 'privateKey' as const,
    blockingIssues: [],
    warnings: [],
  };

  it('accepts only importable ids, existing folders, and resolved keys', () => {
    expect(
      validateImportMessage(
        {
          requestId: '1',
          type: 'import',
          selections: [
            {
              candidateId: 'candidate',
              name: 'renamed',
              folderId: null,
              authentication: 'privateKey',
              selectedIdentityFile: '/home/user/.ssh/id_ed25519',
            },
          ],
        },
        [candidate],
        [],
      ),
    ).toEqual([
      {
        candidateId: 'candidate',
        name: 'renamed',
        folderId: null,
        authentication: 'privateKey',
        selectedIdentityFile: '/home/user/.ssh/id_ed25519',
      },
    ]);
    expect(() =>
      validateImportMessage(
        {
          requestId: '1',
          type: 'import',
          selections: [
            {
              candidateId: 'candidate',
              name: 'server',
              folderId: null,
              authentication: 'privateKey',
              selectedIdentityFile: '/tmp/untrusted',
            },
          ],
        },
        [candidate],
        [],
      ),
    ).toThrow('Select one of the resolved identity files');
  });
});
