import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import type { SshImportCandidate } from '../../connections/OpenSshImporter';
import type { ConnectionFolder } from '../../connections/types';

export interface ImportSelection {
  candidateId: string;
  name: string;
  folderId: string | null;
  authentication: 'password' | 'privateKey' | 'agent';
  selectedIdentityFile?: string;
}

/** Preview deliberately receives candidates, never raw ssh-config source or filesystem authority. */
export class ImportPreview implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(private readonly vscodeApi: typeof vscode) {}

  open(
    candidates: readonly SshImportCandidate[],
    folders: readonly ConnectionFolder[],
    onImport: (selections: ImportSelection[]) => Promise<void>,
  ): void {
    const panel = this.vscodeApi.window.createWebviewPanel(
      'easysshManager.sshImportPreview',
      'Import OpenSSH Connections',
      this.vscodeApi.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
    const nonce = crypto.randomBytes(18).toString('base64');
    panel.webview.html = previewHtml(panel.webview, nonce, candidates, folders);
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      const requestId = requestIdOf(message);
      try {
        const selections = validateMessage(message, candidates, folders);
        await onImport(selections);
        await panel.webview.postMessage({ requestId, ok: true });
        panel.dispose();
      } catch (error) {
        await panel.webview.postMessage({
          requestId,
          ok: false,
          error:
            error instanceof Error ? error.message : 'Import failed. No source file was changed.',
        });
      }
    });
  }

  dispose(): void {
    for (const panel of this.panels) panel.dispose();
    this.panels.clear();
  }
}

export function validateImportMessage(
  value: unknown,
  candidates: readonly SshImportCandidate[],
  folders: readonly ConnectionFolder[],
): ImportSelection[] {
  return validateMessage(value, candidates, folders);
}

function validateMessage(
  value: unknown,
  candidates: readonly SshImportCandidate[],
  folders: readonly ConnectionFolder[],
): ImportSelection[] {
  if (!plain(value) || !exact(value, ['requestId', 'type', 'selections'])) invalidRequest();
  if (
    value.type !== 'import' ||
    typeof value.requestId !== 'string' ||
    !/^[\w-]{1,80}$/.test(value.requestId) ||
    !Array.isArray(value.selections)
  )
    invalidRequest();
  const importable = new Map(
    candidates
      .filter((candidate) => candidate.blockingIssues.length === 0)
      .map((candidate) => [candidate.candidateId, candidate]),
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const seen = new Set<string>();
  const selections = value.selections.map((selection): ImportSelection => {
    if (
      !plain(selection) ||
      !exact(selection, [
        'candidateId',
        'name',
        'folderId',
        'authentication',
        'selectedIdentityFile',
      ]) ||
      typeof selection.candidateId !== 'string'
    )
      return invalidRequest();
    const candidate = importable.get(selection.candidateId);
    if (!candidate || seen.has(selection.candidateId)) invalidRequest();
    seen.add(selection.candidateId);
    if (typeof selection.name !== 'string') invalidRequest();
    const name = selection.name.trim();
    if (!name || Array.from(name).length > 200 || name.includes('\0'))
      throw new Error('Imported connection names must be 1–200 characters.');
    const folderId = selection.folderId;
    if (folderId !== null && (typeof folderId !== 'string' || !folderIds.has(folderId)))
      throw new Error('The selected destination folder no longer exists.');
    if (!['password', 'privateKey', 'agent'].includes(String(selection.authentication)))
      invalidRequest();
    const authentication = selection.authentication as ImportSelection['authentication'];
    if (authentication !== 'privateKey' && selection.selectedIdentityFile !== undefined)
      invalidRequest();
    if (
      authentication === 'privateKey' &&
      (typeof selection.selectedIdentityFile !== 'string' ||
        !candidate.identityFiles.includes(selection.selectedIdentityFile))
    )
      throw new Error(`Select one of the resolved identity files for ${name}.`);
    return {
      candidateId: selection.candidateId,
      name,
      folderId,
      authentication,
      ...(authentication === 'privateKey'
        ? { selectedIdentityFile: selection.selectedIdentityFile as string }
        : {}),
    };
  });
  if (selections.length === 0) throw new Error('Select at least one importable profile.');
  return selections;
}

function previewHtml(
  _webview: vscode.Webview,
  nonce: string,
  candidates: readonly SshImportCandidate[],
  folders: readonly ConnectionFolder[],
): string {
  const display = candidates.map((candidate) => ({
    id: candidate.candidateId,
    name: candidate.name,
    target: `${candidate.username ?? ''}@${candidate.host ?? candidate.hostPattern}:${candidate.port}`,
    importable: candidate.blockingIssues.length === 0,
    authentication: candidate.selectedAuthentication ?? 'agent',
    identityFiles: candidate.identityFiles,
    selectedIdentityFile: candidate.selectedIdentityFile,
    issues: [...candidate.blockingIssues, ...candidate.warnings].map((issue) => issue.message),
  }));
  const json = JSON.stringify(display).replace(/</g, '\\u003c');
  const folderJson = JSON.stringify(
    folders.map((folder) => ({ id: folder.id, name: folder.name })),
  ).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><title>OpenSSH import</title><style nonce="${nonce}">body{max-width:64rem;margin:1rem auto}.candidate{border:1px solid var(--vscode-panel-border);padding:.8rem;margin:.8rem 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}label{display:block}input[type=text],select{width:100%;box-sizing:border-box}.issues{color:var(--vscode-descriptionForeground)}button{margin-right:.5rem}</style></head><body><h1>OpenSSH import preview</h1><p>Review metadata only. Source files will not be changed.</p><button id="all" type="button">Select all importable</button><form id="items"></form><button id="import" type="button">Import selected</button><p id="status" role="status" aria-live="polite"></p><script nonce="${nonce}">const vscode=acquireVsCodeApi(),items=${json},folders=${folderJson},form=document.getElementById('items'),rows=new Map();for(const item of items){const section=document.createElement('section');section.className='candidate';const selectLabel=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=item.importable;box.disabled=!item.importable;selectLabel.append(box,document.createTextNode(' Import '+item.name));const target=document.createElement('div');target.textContent=item.target;const grid=document.createElement('div');grid.className='grid';const nameLabel=document.createElement('label');nameLabel.append(document.createTextNode('Name'));const name=document.createElement('input');name.type='text';name.maxLength=200;name.value=item.name;name.disabled=!item.importable;nameLabel.append(name);const folderLabel=document.createElement('label');folderLabel.append(document.createTextNode('Destination folder'));const folder=document.createElement('select'),root=document.createElement('option');root.value='';root.textContent='Root';folder.append(root);for(const entry of folders){const option=document.createElement('option');option.value=entry.id;option.textContent=entry.name;folder.append(option)}folder.disabled=!item.importable;folderLabel.append(folder);const authLabel=document.createElement('label');authLabel.append(document.createTextNode('Authentication'));const auth=document.createElement('select');for(const [value,label] of [['agent','SSH agent'],['password','Password'],['privateKey','Private key']]){const option=document.createElement('option');option.value=value;option.textContent=label;if(value==='privateKey'&&!item.identityFiles.length)option.disabled=true;auth.append(option)}auth.value=item.authentication==='privateKey'&&item.identityFiles.length===0?'agent':item.authentication;auth.disabled=!item.importable;authLabel.append(auth);const keyLabel=document.createElement('label');keyLabel.append(document.createTextNode('Identity file'));const key=document.createElement('select');for(const identity of item.identityFiles){const option=document.createElement('option');option.value=identity;option.textContent=identity;key.append(option)}key.value=item.selectedIdentityFile||item.identityFiles[0]||'';keyLabel.append(key);const render=()=>keyLabel.hidden=auth.value!=='privateKey';auth.onchange=render;render();grid.append(nameLabel,folderLabel,authLabel,keyLabel);section.append(selectLabel,target,grid);if(item.issues.length){const issues=document.createElement('p');issues.className='issues';issues.textContent=item.issues.join('; ');section.append(issues)}form.append(section);rows.set(item.id,{item,box,name,folder,auth,key})}document.getElementById('all').onclick=()=>{for(const row of rows.values())if(!row.box.disabled)row.box.checked=true};let sequence=0,pending=0;document.getElementById('import').onclick=()=>{const selections=[];for(const [candidateId,row] of rows)if(row.box.checked&&!row.box.disabled)selections.push({candidateId,name:row.name.value,folderId:row.folder.value||null,authentication:row.auth.value,...(row.auth.value==='privateKey'?{selectedIdentityFile:row.key.value}:{})});pending=++sequence;vscode.postMessage({type:'import',requestId:String(pending),selections})};window.addEventListener('message',event=>{if(event.data.requestId!==String(pending))return;document.getElementById('status').textContent=event.data.ok?'Imported.':event.data.error});</script></body></html>`;
}

function requestIdOf(value: unknown): string {
  return plain(value) && typeof value.requestId === 'string' ? value.requestId : '';
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function invalidRequest(): never {
  throw new Error('Invalid import request. Refresh the preview and try again.');
}
