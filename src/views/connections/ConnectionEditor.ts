import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import { EasySshError } from '../../common/errors';
import {
  type ConnectionInput,
  type ConnectionService,
  type CredentialChange,
  makeConnection,
} from '../../connections/ConnectionService';
import type { ConnectionFolder, RemoteConnection } from '../../connections/types';
import type { TestConnectionService } from '../../ssh/TestConnectionService';
import { webviewPanelOptions, webviewStylesheets } from '../shared/WebviewAssets';

type SaveRequest = {
  requestId: string;
  type: 'save';
  value: unknown;
  password: CredentialChange;
  passphrase: CredentialChange;
};
type TestRequest = Omit<SaveRequest, 'type'> & { type: 'test' };
type EditorMessage = SaveRequest | TestRequest;

/** Connection metadata and newly typed credentials cross this boundary separately. */
export class ConnectionEditor implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(
    private readonly vscodeApi: typeof vscode,
    private readonly extensionUri: vscode.Uri,
    private readonly connections: ConnectionService,
    private readonly connectionTester?: TestConnectionService,
  ) {}

  open(
    connection?: RemoteConnection,
    folders: readonly ConnectionFolder[] = [],
    initialFolderId: string | null = null,
  ): void {
    const panel = this.vscodeApi.window.createWebviewPanel(
      'easysshManager.connectionEditor',
      connection ? `Edit ${connection.name}` : 'New Connection',
      this.vscodeApi.ViewColumn.One,
      webviewPanelOptions(this.vscodeApi, this.extensionUri),
    );
    const nonce = crypto.randomBytes(18).toString('base64');
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
    panel.webview.html = editorHtml(
      panel.webview,
      this.vscodeApi,
      this.extensionUri,
      nonce,
      connection,
      folders,
      initialFolderId,
    );
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      const requestId = requestIdOf(message);
      try {
        const request = validateMessage(message);
        if (request.type === 'test') {
          if (!this.connectionTester)
            throw new EasySshError('CONFLICT', 'SSH connection testing is not available.');
          const input = validateInput(request.value);
          const candidate = makeConnection(
            connection?.id ?? crypto.randomUUID(),
            input,
            connection?.order ?? 0,
            connection?.createdAt ?? Date.now(),
            connection,
          );
          const result = await this.connectionTester.testCandidate(candidate, {
            kind: 'test',
            scopeId: `editor-${requestId}`,
            transientCredentials: {
              ...(request.password.action === 'set'
                ? { password: request.password.value }
                : request.password.action === 'clear'
                  ? { password: null }
                  : {}),
              ...(request.passphrase.action === 'set'
                ? { passphrase: request.passphrase.value }
                : request.passphrase.action === 'clear'
                  ? { passphrase: null }
                  : {}),
            },
          });
          await panel.webview.postMessage({
            requestId,
            ok: true,
            message: `${result.stages.join(' · ')} · ${result.durationMs} ms`,
          });
          return;
        }
        const input = validateInput(request.value);
        requireExplicitObsoleteSecretClear(connection, input, request);
        const isNew = connection === undefined;
        const saved = isNew
          ? (await this.connections.addConnection(input)).id
          : (await this.connections.editConnection(connection.id, input), connection.id);
        try {
          await this.applyCredentials(saved, input, request);
        } catch (error) {
          if (isNew) await this.connections.deleteConnection(saved).catch(() => undefined);
          throw error;
        }
        await panel.webview.postMessage({ requestId, ok: true });
        panel.dispose();
      } catch (error) {
        await panel.webview.postMessage({
          requestId,
          ok: false,
          error: error instanceof EasySshError ? error.message : 'Unable to save connection.',
        });
      }
    });
  }

  dispose(): void {
    for (const panel of this.panels) panel.dispose();
    this.panels.clear();
  }

  private async applyCredentials(
    id: string,
    input: ConnectionInput,
    request: SaveRequest,
  ): Promise<void> {
    if (input.authentication.type === 'password') {
      await this.connections.changeCredential(id, 'password', request.password);
      if (request.passphrase.action !== 'keep')
        await this.connections.changeCredential(id, 'keyPassphrase', request.passphrase);
      return;
    }
    if (input.authentication.type === 'privateKey') {
      await this.connections.changeCredential(id, 'keyPassphrase', request.passphrase);
      if (request.password.action !== 'keep')
        await this.connections.changeCredential(id, 'password', request.password);
      return;
    }
    // Agent authentication has no usable stored secret. Explicitly clear only after host-side validation.
    if (request.password.action !== 'keep')
      await this.connections.changeCredential(id, 'password', request.password);
    if (request.passphrase.action !== 'keep')
      await this.connections.changeCredential(id, 'keyPassphrase', request.passphrase);
  }
}

export function validateEditorMessage(value: unknown): EditorMessage {
  if (
    !plain(value) ||
    typeof value.requestId !== 'string' ||
    !/^[\w-]{1,80}$/.test(value.requestId)
  ) {
    throw new EasySshError('VALIDATION', 'Invalid editor request.');
  }
  if (
    (value.type === 'save' || value.type === 'test') &&
    Object.keys(value).every((key) =>
      ['requestId', 'type', 'value', 'password', 'passphrase'].includes(key),
    )
  ) {
    const request = {
      requestId: value.requestId,
      type: value.type,
      value: value.value,
      password: credentialChange(value.password),
      passphrase: credentialChange(value.passphrase),
    };
    return request as EditorMessage;
  }
  throw new EasySshError('VALIDATION', 'Invalid editor operation.');
}

function validateMessage(value: unknown): EditorMessage {
  return validateEditorMessage(value);
}
export function validateEditorInput(value: unknown): ConnectionInput {
  return validateInput(value);
}
function validateInput(value: unknown): ConnectionInput {
  if (!plain(value)) throw new EasySshError('VALIDATION', 'Invalid connection form.');
  const allowed = [
    'name',
    'folderId',
    'host',
    'port',
    'username',
    'defaultRemotePath',
    'authentication',
    'options',
    'agentAccess',
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key)))
    throw new EasySshError('VALIDATION', 'Unsupported connection form field.');
  if (
    typeof value.name !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.username !== 'string'
  )
    throw new EasySshError('VALIDATION', 'Name, host, and username are required.');
  if (value.folderId !== undefined && value.folderId !== null && typeof value.folderId !== 'string')
    throw new EasySshError('VALIDATION', 'Invalid folder.');
  if (value.port !== undefined && (typeof value.port !== 'number' || !Number.isInteger(value.port)))
    throw new EasySshError('VALIDATION', 'Port must be an integer.');
  if (value.defaultRemotePath !== undefined && typeof value.defaultRemotePath !== 'string')
    throw new EasySshError('VALIDATION', 'Remote path must be text.');
  const authentication = authenticationFrom(value.authentication);
  const agentAccess = agentPolicy(value.agentAccess);
  const options = connectionOptions(value.options);
  return {
    name: value.name,
    host: value.host,
    username: value.username,
    authentication,
    ...(value.folderId === undefined ? {} : { folderId: value.folderId as string | null }),
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.defaultRemotePath === undefined
      ? {}
      : { defaultRemotePath: value.defaultRemotePath }),
    ...(agentAccess === undefined ? {} : { agentAccess }),
    ...(options === undefined ? {} : { options }),
  };
}
function connectionOptions(value: unknown): ConnectionInput['options'] | undefined {
  if (value === undefined) return undefined;
  if (
    !plain(value) ||
    !Object.keys(value).every((key) =>
      ['keepAliveIntervalMs', 'keepAliveCountMax', 'readyTimeoutMs'].includes(key),
    )
  )
    throw new EasySshError('VALIDATION', 'Invalid connection options.');
  const keepAliveIntervalMs = value.keepAliveIntervalMs;
  const keepAliveCountMax = value.keepAliveCountMax;
  const readyTimeoutMs = value.readyTimeoutMs;
  if (
    keepAliveIntervalMs !== undefined &&
    (!Number.isInteger(keepAliveIntervalMs) ||
      (keepAliveIntervalMs as number) < 0 ||
      (keepAliveIntervalMs as number) > 300000)
  )
    throw new EasySshError('VALIDATION', 'Keepalive must be between 0 and 300000 milliseconds.');
  if (
    keepAliveCountMax !== undefined &&
    (!Number.isInteger(keepAliveCountMax) ||
      (keepAliveCountMax as number) < 1 ||
      (keepAliveCountMax as number) > 20)
  )
    throw new EasySshError('VALIDATION', 'Keepalive retry count must be between 1 and 20.');
  if (
    readyTimeoutMs !== undefined &&
    (!Number.isInteger(readyTimeoutMs) ||
      (readyTimeoutMs as number) < 1000 ||
      (readyTimeoutMs as number) > 120000)
  )
    throw new EasySshError(
      'VALIDATION',
      'Ready timeout must be between 1000 and 120000 milliseconds.',
    );
  return {
    ...(keepAliveIntervalMs === undefined
      ? {}
      : { keepAliveIntervalMs: keepAliveIntervalMs as number }),
    ...(keepAliveCountMax === undefined ? {} : { keepAliveCountMax: keepAliveCountMax as number }),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs: readyTimeoutMs as number }),
  };
}
function authenticationFrom(value: unknown): ConnectionInput['authentication'] {
  if (!plain(value) || typeof value.type !== 'string')
    throw new EasySshError('VALIDATION', 'Choose an authentication method.');
  if (value.type === 'agent' && Object.keys(value).length === 1) return { type: 'agent' };
  if (
    value.type === 'password' &&
    typeof value.hasStoredPassword === 'boolean' &&
    Object.keys(value).every((key) => ['type', 'hasStoredPassword'].includes(key))
  )
    return { type: 'password', hasStoredPassword: Boolean(value.hasStoredPassword) };
  if (
    value.type === 'privateKey' &&
    typeof value.privateKeyPath === 'string' &&
    typeof value.hasStoredPassphrase === 'boolean' &&
    Object.keys(value).every((key) =>
      ['type', 'privateKeyPath', 'hasStoredPassphrase'].includes(key),
    )
  )
    return {
      type: 'privateKey',
      privateKeyPath: value.privateKeyPath,
      hasStoredPassphrase: Boolean(value.hasStoredPassphrase),
    };
  throw new EasySshError('VALIDATION', 'Invalid authentication form.');
}
function agentPolicy(value: unknown): ConnectionInput['agentAccess'] | undefined {
  if (value === undefined) return undefined;
  if (
    !plain(value) ||
    !Object.keys(value).every((key) =>
      [
        'enabled',
        'allowReadFiles',
        'allowWriteFiles',
        'allowExec',
        'allowInteractiveShell',
        'confirmationMode',
        'allowedRoots',
      ].includes(key),
    ) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.allowReadFiles !== 'boolean' ||
    typeof value.allowWriteFiles !== 'boolean' ||
    typeof value.allowExec !== 'boolean' ||
    value.allowInteractiveShell !== false ||
    !['always', 'destructive', 'never'].includes(String(value.confirmationMode)) ||
    !Array.isArray(value.allowedRoots) ||
    !value.allowedRoots.every((item) => typeof item === 'string')
  )
    throw new EasySshError('VALIDATION', 'Invalid agent access policy.');
  const roots = [...new Set(value.allowedRoots.map((root) => root.replace(/\/+$/, '') || '/'))];
  if (roots.some((root) => !root.startsWith('/') || root.includes('\0')))
    throw new EasySshError('VALIDATION', 'Agent roots must be absolute POSIX paths.');
  if (value.enabled && (value.allowReadFiles || value.allowWriteFiles) && roots.length === 0)
    throw new EasySshError('VALIDATION', 'File access requires at least one allowed root.');
  return {
    enabled: value.enabled,
    allowReadFiles: value.allowReadFiles,
    allowWriteFiles: value.allowWriteFiles,
    allowExec: value.allowExec,
    allowInteractiveShell: false,
    confirmationMode: value.confirmationMode as 'always' | 'destructive' | 'never',
    allowedRoots: roots,
  };
}
function credentialChange(value: unknown): CredentialChange {
  if (
    !plain(value) ||
    typeof value.action !== 'string' ||
    !Object.keys(value).every((key) => ['action', 'value'].includes(key))
  )
    throw new EasySshError('VALIDATION', 'Invalid credential operation.');
  if ((value.action === 'keep' || value.action === 'clear') && Object.keys(value).length === 1)
    return { action: value.action };
  if (value.action === 'set') {
    if (
      Object.keys(value).length === 2 &&
      typeof value.value === 'string' &&
      value.value.length > 0
    )
      return { action: 'set', value: value.value };
    throw new EasySshError('VALIDATION', 'A replacement credential cannot be empty.');
  }
  throw new EasySshError('VALIDATION', 'Invalid credential operation.');
}
function requireExplicitObsoleteSecretClear(
  previous: RemoteConnection | undefined,
  input: ConnectionInput,
  request: SaveRequest,
): void {
  if (input.authentication.type !== 'password' && request.password.action === 'set')
    throw new EasySshError(
      'VALIDATION',
      'A password can only be stored with password authentication.',
    );
  if (input.authentication.type !== 'privateKey' && request.passphrase.action === 'set')
    throw new EasySshError(
      'VALIDATION',
      'A key passphrase can only be stored with private-key authentication.',
    );
  if (
    previous?.authentication.type === 'password' &&
    previous.authentication.hasStoredPassword &&
    input.authentication.type !== 'password' &&
    request.password.action !== 'clear'
  ) {
    throw new EasySshError(
      'VALIDATION',
      'Confirm deletion of the stored password before changing authentication methods.',
    );
  }
  if (
    previous?.authentication.type === 'privateKey' &&
    previous.authentication.hasStoredPassphrase &&
    input.authentication.type !== 'privateKey' &&
    request.passphrase.action !== 'clear'
  ) {
    throw new EasySshError(
      'VALIDATION',
      'Confirm deletion of the stored key passphrase before changing authentication methods.',
    );
  }
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function requestIdOf(value: unknown): string {
  return plain(value) && typeof value.requestId === 'string' ? value.requestId : '';
}

export function editorHtml(
  webview: vscode.Webview,
  api: typeof vscode,
  extensionUri: vscode.Uri,
  nonce: string,
  connection?: RemoteConnection,
  folders: readonly ConnectionFolder[] = [],
  initialFolderId: string | null = null,
): string {
  return renderEditorHtml(webview, api, extensionUri, nonce, connection, folders, initialFolderId);
}

function renderEditorHtml(
  webview: vscode.Webview,
  api: typeof vscode,
  extensionUri: vscode.Uri,
  nonce: string,
  connection?: RemoteConnection,
  folders: readonly ConnectionFolder[] = [],
  initialFolderId: string | null = null,
): string {
  const initial = JSON.stringify(
    connection
      ? {
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          defaultRemotePath: connection.defaultRemotePath,
          folderId: connection.folderId,
          authentication: connection.authentication,
          agentAccess: connection.agentAccess,
          options: connection.options,
        }
      : {
          name: '',
          host: '',
          port: 22,
          username: '',
          defaultRemotePath: '/',
          folderId: initialFolderId,
          authentication: { type: 'agent' },
          agentAccess: {
            enabled: false,
            allowReadFiles: false,
            allowWriteFiles: false,
            allowExec: false,
            allowInteractiveShell: false,
            confirmationMode: 'always',
            allowedRoots: [],
          },
          options: {},
        },
  ).replace(/</g, '\\u003c');
  const folderData = JSON.stringify(
    folders.map((folder) => ({ id: folder.id, name: folder.name })),
  ).replace(/</g, '\\u003c');
  const styles = webviewStylesheets(webview, api, extensionUri, 'connection-editor-style.css');
  const heading = connection ? 'Edit connection' : 'New connection';
  const description = connection
    ? 'Update how this profile connects. Stored secrets are never returned to this page.'
    : 'Create a reusable SSH and SFTP profile. Credentials are stored separately from connection metadata.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'">
${styles}<title>${heading}</title></head><body>
<main class="page-shell connection-page">
  <header class="page-header"><div class="eyebrow"><span class="codicon codicon-server" aria-hidden="true"></span>EasySSH Manager</div><h1>${heading}</h1><p>${description}</p></header>
  <form id="form" class="connection-form">
    <section class="surface-card form-card" aria-labelledby="basics-heading">
      <div class="card-header"><div><h2 id="basics-heading">Connection details</h2><p>Name the profile and provide the remote endpoint.</p></div><span class="codicon codicon-plug" aria-hidden="true"></span></div>
      <div class="form-grid">
        <label class="field"><span class="field-label">Name</span><input id="name" required maxlength="200" autocomplete="off"><span class="field-help">A recognizable name shown in the Connections view.</span></label>
        <label class="field"><span class="field-label">Folder</span><select id="folder"><option value="">Root</option></select><span class="field-help">Optional organization within the sidebar.</span></label>
        <label class="field span-2"><span class="field-label">Host</span><input id="host" required autocomplete="off" spellcheck="false" placeholder="server.example.com"><span class="field-help">Hostname or IP address of the SSH server.</span></label>
        <label class="field"><span class="field-label">Port</span><input id="port" type="number" min="1" max="65535" required inputmode="numeric"></label>
        <label class="field"><span class="field-label">Username</span><input id="username" required maxlength="255" autocomplete="username"></label>
        <label class="field span-2"><span class="field-label">Default remote path</span><input id="path" required spellcheck="false" placeholder="/"><span class="field-help">The directory opened first in the SFTP browser.</span></label>
      </div>
    </section>
    <section class="surface-card form-card" aria-labelledby="authentication-heading">
      <div class="card-header"><div><h2 id="authentication-heading">Authentication</h2><p>Choose how EasySSH should authenticate this connection.</p></div><span class="codicon codicon-shield" aria-hidden="true"></span></div>
      <div class="form-grid">
        <label class="field span-2"><span class="field-label">Method</span><select id="auth"><option value="agent">SSH agent</option><option value="password">Password</option><option value="privateKey">Private key</option></select></label>
        <label id="keyRow" class="field span-2"><span class="field-label">Private-key path</span><input id="keyPath" autocomplete="off" spellcheck="false" placeholder="/home/user/.ssh/id_ed25519"><span class="field-help">The key stays on disk and is read only when connecting.</span></label>
        <label id="passwordRow" class="field span-2"><span class="label-line"><span class="field-label">Password</span><span id="passwordStatus" class="badge success" hidden><span class="codicon codicon-lock" aria-hidden="true"></span>Stored</span></span><input id="password" type="password" autocomplete="new-password" placeholder="Leave blank to keep the stored password"></label>
        <label id="phraseRow" class="field span-2"><span class="label-line"><span class="field-label">Key passphrase</span><span id="phraseStatus" class="badge success" hidden><span class="codicon codicon-lock" aria-hidden="true"></span>Stored</span></span><input id="passphrase" type="password" autocomplete="new-password" placeholder="Leave blank to keep the stored passphrase"></label>
        <label id="clearPasswordRow" class="checkbox-field secret-clear"><input id="clearPassword" type="checkbox"><span>Delete the stored password when saving</span></label>
        <label id="clearPhraseRow" class="checkbox-field secret-clear"><input id="clearPhrase" type="checkbox"><span>Delete the stored key passphrase when saving</span></label>
      </div>
    </section>
    <details id="connectionOptions" class="surface-card disclosure-card"><summary><span class="codicon codicon-chevron-right disclosure-icon" aria-hidden="true"></span><span class="disclosure-title"><strong>Connection options</strong><span>Override keepalive and timeout defaults for this profile.</span></span></summary><div class="disclosure-content"><div class="form-grid">
      <label class="field"><span class="field-label">Keepalive interval (ms)</span><input id="keepAlive" type="number" min="0" max="300000"><span class="field-help">Leave blank to use the extension default.</span></label>
      <label class="field"><span class="field-label">Keepalive retry count</span><input id="keepAliveCount" type="number" min="1" max="20"></label>
      <label class="field"><span class="field-label">Ready timeout (ms)</span><input id="readyTimeout" type="number" min="1000" max="120000"></label>
    </div></div></details>
    <details id="agentPolicy" class="surface-card disclosure-card"><summary><span class="codicon codicon-chevron-right disclosure-icon" aria-hidden="true"></span><span class="disclosure-title"><strong>Agent access</strong><span>Control whether automated tools may use this connection.</span></span></summary><div class="disclosure-content"><div class="form-grid">
      <label class="checkbox-field span-2"><input id="agentEnabled" type="checkbox"><span><strong>Enable agent access</strong><br><span class="field-help">This connection remains unavailable to agents until enabled.</span></span></label>
      <div class="agent-grants" role="group" aria-label="Agent permissions"><label class="checkbox-field"><input id="agentRead" type="checkbox"><span>Read files</span></label><label class="checkbox-field"><input id="agentWrite" type="checkbox"><span>Write files</span></label><label class="checkbox-field"><input id="agentExec" type="checkbox"><span>Execute commands</span></label></div>
      <label class="field"><span class="field-label">Confirmation</span><select id="agentConfirm"><option value="always">Always</option><option value="destructive">Destructive only</option><option value="never">Never</option></select></label>
      <label class="field span-2"><span class="field-label">Allowed POSIX roots</span><textarea id="agentRoots" spellcheck="false" placeholder="One absolute path per line"></textarea></label>
    </div></div></details>
    <footer class="action-bar connection-actions"><p id="status" class="status-message" role="status" aria-live="polite"></p><div class="actions"><button id="test" class="secondary" type="button"><span class="codicon codicon-debug-alt" aria-hidden="true"></span>Test Connection</button><button id="save" type="submit"><span class="codicon codicon-save" aria-hidden="true"></span>Save Connection</button></div></footer>
  </form>
</main>
<script nonce="${nonce}">const vscode=acquireVsCodeApi(),initial=${initial},folders=${folderData},$=id=>document.getElementById(id),set=(id,v)=>$(id).value=v??'';for(const folder of folders){const option=document.createElement('option');option.value=folder.id;option.textContent=folder.name;$('folder').append(option)}set('name',initial.name);set('host',initial.host);set('port',initial.port);set('username',initial.username);set('path',initial.defaultRemotePath);set('folder',initial.folderId);set('keepAlive',initial.options.keepAliveIntervalMs);set('keepAliveCount',initial.options.keepAliveCountMax);set('readyTimeout',initial.options.readyTimeoutMs);$('auth').value=initial.authentication.type;set('keyPath',initial.authentication.privateKeyPath);$('passwordStatus').hidden=!initial.authentication.hasStoredPassword;$('phraseStatus').hidden=!initial.authentication.hasStoredPassphrase;for(const [id,key] of [['agentEnabled','enabled'],['agentRead','allowReadFiles'],['agentWrite','allowWriteFiles'],['agentExec','allowExec']])$(id).checked=initial.agentAccess[key];$('agentConfirm').value=initial.agentAccess.confirmationMode;set('agentRoots',initial.agentAccess.allowedRoots.join('\\n'));if(Object.keys(initial.options).length)$('connectionOptions').open=true;if(initial.agentAccess.enabled||initial.agentAccess.allowedRoots.length)$('agentPolicy').open=true;const render=()=>{$('keyRow').hidden=$('auth').value!=='privateKey';$('passwordRow').hidden=$('auth').value!=='password';$('phraseRow').hidden=$('auth').value!=='privateKey';$('clearPasswordRow').hidden=!initial.authentication.hasStoredPassword;$('clearPhraseRow').hidden=!initial.authentication.hasStoredPassphrase;if($('auth').value!=='password')$('password').value='';if($('auth').value!=='privateKey')$('passphrase').value='';};$('auth').onchange=render;render();let sequence=0,pending=0,dirty=false;document.addEventListener('input',()=>dirty=true);const change=(value,clear)=>clear.checked?{action:'clear'}:value?{action:'set',value}:{action:'keep'};const numberOrUndefined=id=>$(id).value===''?undefined:Number($(id).value);const busy=(value,label='')=>{$('form').setAttribute('aria-busy',String(value));$('save').disabled=value;$('test').disabled=value;if(value){$('status').dataset.tone='';$('status').textContent=label}};const send=(type,payload={})=>{pending=++sequence;busy(true,type==='test'?'Testing connection…':'Saving connection…');vscode.postMessage({requestId:String(pending),type,...payload})};const payload=()=>{const type=$('auth').value,authentication=type==='agent'?{type}:type==='password'?{type,hasStoredPassword:initial.authentication.hasStoredPassword===true}:{type,privateKeyPath:$('keyPath').value,hasStoredPassphrase:initial.authentication.hasStoredPassphrase===true},agentAccess={enabled:$('agentEnabled').checked,allowReadFiles:$('agentRead').checked,allowWriteFiles:$('agentWrite').checked,allowExec:$('agentExec').checked,allowInteractiveShell:false,confirmationMode:$('agentConfirm').value,allowedRoots:$('agentRoots').value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean)};return{value:{name:$('name').value,folderId:$('folder').value||null,host:$('host').value,port:Number($('port').value),username:$('username').value,defaultRemotePath:$('path').value,authentication,agentAccess,options:{...(numberOrUndefined('keepAlive')===undefined?{}:{keepAliveIntervalMs:numberOrUndefined('keepAlive')}),...(numberOrUndefined('keepAliveCount')===undefined?{}:{keepAliveCountMax:numberOrUndefined('keepAliveCount')}),...(numberOrUndefined('readyTimeout')===undefined?{}:{readyTimeoutMs:numberOrUndefined('readyTimeout')})}},password:change($('password').value,$('clearPassword')),passphrase:change($('passphrase').value,$('clearPhrase'))}};$('form').onsubmit=e=>{e.preventDefault();const type=$('auth').value;if(initial.authentication.type==='password'&&initial.authentication.hasStoredPassword&&type!=='password'&&!$('clearPassword').checked){if(!confirm('Changing authentication will delete the stored password. Continue?'))return;$('clearPassword').checked=true;}if(initial.authentication.type==='privateKey'&&initial.authentication.hasStoredPassphrase&&type!=='privateKey'&&!$('clearPhrase').checked){if(!confirm('Changing authentication will delete the stored key passphrase. Continue?'))return;$('clearPhrase').checked=true;}send('save',payload())};$('test').onclick=()=>{if($('form').reportValidity())send('test',payload())};window.addEventListener('message',e=>{if(String(pending)!==e.data.requestId)return;busy(false);$('status').dataset.tone=e.data.ok?'success':'error';$('status').textContent=e.data.ok?(e.data.message||'Saved.'):(e.data.error||'Save failed.');if(e.data.ok&&!e.data.message)dirty=false;});window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});</script></body></html>`;
}
