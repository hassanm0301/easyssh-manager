/* Browser-only SFTP panel client. It never interpolates file data into HTML. */
import {
  clampColumnWidth,
  clampMenuPosition,
  clampPaneRatio,
  columnTemplate,
  controlAvailability,
  entryIconName,
  isRemoteDropTarget,
  sortIconName,
} from './presentation';
import type { BrowserColumnKey } from './presentation';

declare function acquireVsCodeApi(): {
  setState(state: unknown): void;
  postMessage(message: unknown): void;
};

type Sort = { readonly key: 'name' | 'size' | 'mtime'; readonly direction: 'asc' | 'desc' };
type Entry = {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symbolicLink' | 'other';
  readonly size?: number;
  readonly mtimeMs?: number;
};
type WorkspaceEntry = {
  readonly name: string;
  readonly uri: string;
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symbolicLink' | 'other';
  readonly size?: number;
  readonly mtimeMs?: number;
};
type WorkspaceView = {
  readonly generation: number;
  readonly state: 'ready' | 'untrusted' | 'noWorkspace' | 'error';
  readonly message?: string;
  readonly path: string;
  readonly location: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
  readonly sort: Sort;
  readonly loading: boolean;
};
type ColumnWidths = Record<BrowserColumnKey, number>;
type Layout = {
  paneRatio: number;
  visibleColumns: BrowserColumnKey[];
  workspaceColumnWidths: ColumnWidths;
  remoteColumnWidths: ColumnWidths;
};
type View = {
  readonly path: string;
  readonly entries: readonly Entry[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
  readonly sort: Sort;
  readonly connection: { readonly state: string; readonly text: string };
  readonly workspace: WorkspaceView;
  readonly layout: Layout;
};
type Pane = 'workspace' | 'remote';
type Suggestion = {
  readonly label: string;
  readonly value: string;
  readonly description: string;
  readonly uri?: string;
};

const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing static SFTP panel element '${id}'.`);
  return element as T;
};

const remoteRows = byId<HTMLDivElement>('rows');
const workspaceRows = byId<HTMLDivElement>('workspace-rows');
const remoteList = byId<HTMLElement>('list');
const workspaceList = byId<HTMLElement>('workspace-list');
const status = byId<HTMLElement>('status');
const loading = byId<HTMLElement>('loading');
const menu = byId<HTMLElement>('menu');
const more = byId<HTMLButtonElement>('more');
const browserLayout = document.querySelector<HTMLElement>('.browser-layout');
const columnsMenu = byId<HTMLElement>('columns-menu');
const paneResizer = byId<HTMLElement>('pane-resizer');

let view: View | undefined;
let sequence = 0;
let remoteBusy = true;
let remoteSelected = new Set<string>();
let workspaceSelected = new Set<string>();
let activeRemoteKey: string | undefined;
let activeWorkspaceKey: string | undefined;
let menuPane: Pane = 'remote';
let menuOrigin: HTMLElement | undefined;
const expandedRemote = new Set<string>();
const expandedWorkspace = new Set<string>();
const remoteChildren = new Map<string, readonly Entry[]>();
const workspaceChildren = new Map<string, readonly WorkspaceEntry[]>();
const remoteErrors = new Map<string, string>();
const workspaceErrors = new Map<string, string>();
let workspaceGeneration = -1;
let layout: Layout | undefined;

function send(message: Record<string, unknown>): string {
  sequence += 1;
  const requestId = `sftp-${sequence}`;
  vscode.postMessage({ ...message, requestId });
  return requestId;
}

function command(type: string, extra: Record<string, unknown> = {}): string {
  return send({ type, ...extra });
}

function render(next: View, pending = 0): void {
  const focusedRow = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.entry');
  const focusedPane: Pane | undefined = focusedRow?.classList.contains('workspace-entry')
    ? 'workspace'
    : focusedRow?.classList.contains('remote-entry')
      ? 'remote'
      : undefined;
  const focusedKey =
    focusedPane === 'workspace' ? focusedRow?.dataset.uri : focusedRow?.dataset.path;
  view = next;
  layout = cloneLayout(next.layout);
  remoteBusy = pending > 0;
  if (workspaceGeneration !== next.workspace.generation) {
    workspaceGeneration = next.workspace.generation;
    expandedWorkspace.clear();
    workspaceChildren.clear();
    workspaceErrors.clear();
    workspaceSelected.clear();
  }
  remoteSelected = new Set(
    [...remoteSelected].filter((path) => containsRemote(next.entries, path)),
  );
  workspaceSelected = new Set(
    [...workspaceSelected].filter((uri) => containsWorkspace(next.workspace.entries, uri)),
  );
  if (activeRemoteKey && !containsRemote(next.entries, activeRemoteKey))
    activeRemoteKey = undefined;
  if (activeWorkspaceKey && !containsWorkspace(next.workspace.entries, activeWorkspaceKey))
    activeWorkspaceKey = undefined;
  setStatus(next.connection.text, next.connection.state, connectionIcon(next.connection.state));
  loading.hidden = !remoteBusy && !next.workspace.loading;
  renderRemoteControls(next);
  renderWorkspaceControls(next.workspace);
  remoteRows.replaceChildren(...next.entries.map((entry, index) => remoteRow(entry, 0, index)));
  workspaceRows.replaceChildren(
    ...next.workspace.entries.map((entry, index) => workspaceRow(entry, 0, index)),
  );
  applyLayout();
  if (focusedPane && focusedKey) {
    const container = focusedPane === 'remote' ? remoteRows : workspaceRows;
    Array.from(container.querySelectorAll<HTMLElement>('.entry'))
      .find((row) =>
        focusedPane === 'remote' ? row.dataset.path === focusedKey : row.dataset.uri === focusedKey,
      )
      ?.focus();
  }
  byId<HTMLElement>('empty').hidden = remoteBusy || next.entries.length !== 0;
  byId<HTMLElement>('workspace-empty').hidden =
    next.workspace.loading ||
    next.workspace.state !== 'ready' ||
    next.workspace.entries.length !== 0;
  const error = byId<HTMLElement>('error');
  error.hidden = next.connection.state !== 'error' && next.connection.state !== 'disconnected';
  byId<HTMLElement>('error-message').textContent = error.hidden ? '' : next.connection.text;
  byId<HTMLElement>('workspace-state').textContent = next.workspace.message ?? '';
}

function renderRemoteControls(next: View): void {
  const controls = controlAvailability({
    pending: remoteBusy ? 1 : 0,
    selected: remoteSelected.size > 0,
    canGoBack: next.canGoBack,
    canGoForward: next.canGoForward,
    canGoUp: next.canGoUp,
  });
  remoteList.setAttribute('aria-busy', String(remoteBusy));
  byId<HTMLButtonElement>('back').disabled = !controls.back;
  byId<HTMLButtonElement>('forward').disabled = !controls.forward;
  byId<HTMLButtonElement>('up').disabled = !controls.up;
  const refresh = byId<HTMLButtonElement>('refresh');
  const reconnect = next.connection.state === 'disconnected' || next.connection.state === 'error';
  refresh.disabled = remoteBusy;
  refresh.title = reconnect ? 'Reconnect' : 'Refresh remote directory';
  refresh.setAttribute('aria-label', refresh.title);
  const refreshIcon = refresh.querySelector<HTMLElement>('.codicon');
  if (refreshIcon)
    refreshIcon.className = `codicon ${reconnect ? 'codicon-debug-restart' : 'codicon-refresh'}`;
  for (const id of ['new-file', 'new-folder', 'upload-files', 'upload-folder'])
    byId<HTMLButtonElement>(id).disabled = remoteBusy;
  byId<HTMLButtonElement>('download').disabled = !controls.selectionActions;
  more.disabled = !controls.selectionActions;
  renderSort('remote', next.sort, remoteBusy);
  updatePathInput('remote', next.path);
}

function renderWorkspaceControls(next: WorkspaceView): void {
  const unavailable = next.state === 'untrusted' || next.state === 'noWorkspace' || next.loading;
  workspaceList.setAttribute('aria-busy', String(next.loading));
  byId<HTMLButtonElement>('workspace-back').disabled = unavailable || !next.canGoBack;
  byId<HTMLButtonElement>('workspace-forward').disabled = unavailable || !next.canGoForward;
  byId<HTMLButtonElement>('workspace-up').disabled = unavailable || !next.canGoUp;
  byId<HTMLButtonElement>('workspace-home').disabled = unavailable;
  byId<HTMLButtonElement>('workspace-refresh').disabled = unavailable;
  byId<HTMLInputElement>('workspace-path').disabled =
    next.state === 'untrusted' || next.state === 'noWorkspace';
  renderSort('workspace', next.sort, unavailable);
  updatePathInput('workspace', next.path);
}

function renderSort(pane: Pane, sort: Sort, busy: boolean): void {
  const selector = pane === 'remote' ? '[data-sort]' : '[data-workspace-sort]';
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(selector))) {
    const key = pane === 'remote' ? button.dataset.sort : button.dataset.workspaceSort;
    const active = key === sort.key;
    button.disabled = busy;
    button.setAttribute(
      'aria-label',
      `${button.textContent?.trim() ?? 'Column'}, ${active ? `sorted ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : 'not sorted'}`,
    );
    const icon = button.querySelector<HTMLElement>('.sort-icon');
    const iconName = sortIconName(sort.key, sort.direction, key);
    if (icon) icon.className = `codicon sort-icon ${iconName ? `codicon-${iconName}` : ''}`;
  }
}

function remoteRow(entry: Entry, depth: number, index: number): HTMLElement {
  const item = baseRow(
    'remote',
    entry.name,
    entry.kind,
    entry.size,
    entry.mtimeMs,
    entry.path,
    depth,
  );
  item.dataset.path = entry.path;
  item.tabIndex = activeRemoteKey
    ? entry.path === activeRemoteKey
      ? 0
      : -1
    : depth === 0 && index === 0
      ? 0
      : -1;
  item.ariaSelected = String(remoteSelected.has(entry.path));
  installToggle(item, entry.kind, expandedRemote.has(entry.path), () =>
    toggleExpansion('remote', entry.path),
  );
  installActivation(item, 'remote', entry.path, entry.kind);
  installRemoteDropTarget(item, entry);
  const children = remoteChildren.get(entry.path);
  appendExpanded(
    item,
    entry.kind === 'directory' && expandedRemote.has(entry.path),
    children?.map((child) => remoteRow(child, depth + 1, index)) ?? [],
    remoteErrors.get(entry.path),
    children !== undefined,
  );
  return item;
}

function workspaceRow(entry: WorkspaceEntry, depth: number, index: number): HTMLElement {
  const item = baseRow(
    'workspace',
    entry.name,
    entry.kind,
    entry.size,
    entry.mtimeMs,
    entry.path,
    depth,
  );
  item.dataset.uri = entry.uri;
  item.tabIndex = activeWorkspaceKey
    ? entry.uri === activeWorkspaceKey
      ? 0
      : -1
    : depth === 0 && index === 0
      ? 0
      : -1;
  item.ariaSelected = String(workspaceSelected.has(entry.uri));
  installToggle(item, entry.kind, expandedWorkspace.has(entry.uri), () =>
    toggleExpansion('workspace', entry.uri),
  );
  installActivation(item, 'workspace', entry.uri, entry.kind);
  const name = item.querySelector<HTMLElement>('.name');
  if (name) {
    name.draggable = true;
    name.addEventListener('dragstart', (event) => startWorkspaceDrag(event, entry.uri));
  }
  const children = workspaceChildren.get(entry.uri);
  appendExpanded(
    item,
    entry.kind === 'directory' && expandedWorkspace.has(entry.uri),
    children?.map((child) => workspaceRow(child, depth + 1, index)) ?? [],
    workspaceErrors.get(entry.uri),
    children !== undefined,
  );
  return item;
}

function baseRow(
  pane: Pane,
  nameText: string,
  kind: Entry['kind'],
  sizeValue: number | undefined,
  mtimeValue: number | undefined,
  pathValue: string,
  depth: number,
): HTMLElement {
  const item = document.createElement('div');
  item.className = `entry ${pane}-entry`;
  item.setAttribute('role', 'row');
  item.style.setProperty('--entry-depth', String(depth));
  const name = document.createElement('span');
  name.className = 'name';
  name.dataset.column = 'name';
  const toggleSlot = document.createElement('span');
  toggleSlot.className = 'toggle-slot';
  name.append(toggleSlot, iconElement(entryIconName(kind)), document.createTextNode(nameText));
  name.setAttribute('aria-label', `${kindLabel(kind)} ${nameText}`);
  const size = document.createElement('span');
  size.dataset.column = 'size';
  size.textContent = sizeValue === undefined ? '—' : formatSize(sizeValue);
  const mtime = document.createElement('span');
  mtime.dataset.column = 'mtime';
  mtime.textContent = mtimeValue === undefined ? '—' : new Date(mtimeValue).toLocaleString();
  const type = document.createElement('span');
  type.dataset.column = 'type';
  type.textContent = kindLabel(kind);
  const path = document.createElement('span');
  path.dataset.column = 'path';
  path.textContent = pathValue;
  path.title = pathValue;
  item.append(name, type, size, mtime, path);
  return item;
}

function installToggle(
  row: HTMLElement,
  kind: Entry['kind'],
  expanded: boolean,
  onToggle: () => void,
): void {
  const slot = row.querySelector<HTMLElement>('.toggle-slot');
  if (!slot || kind !== 'directory') return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'entry-toggle';
  button.tabIndex = -1;
  button.setAttribute('aria-label', expanded ? 'Collapse folder' : 'Expand folder');
  button.setAttribute('aria-expanded', String(expanded));
  button.append(iconElement(expanded ? 'chevron-down' : 'chevron-right'));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onToggle();
  });
  slot.append(button);
}

function appendExpanded(
  row: HTMLElement,
  expanded: boolean,
  children: readonly HTMLElement[],
  errorText: string | undefined,
  loaded: boolean,
): void {
  if (!expanded) return;
  const group = document.createElement('div');
  group.className = 'entry-children';
  group.setAttribute('role', 'rowgroup');
  if (children.length > 0) group.append(...children);
  else {
    const state = document.createElement('div');
    state.className = 'inline-state';
    state.textContent = errorText ?? (loaded ? 'Empty folder' : 'Loading…');
    group.append(state);
  }
  row.append(group);
}

function installActivation(row: HTMLElement, pane: Pane, key: string, kind: Entry['kind']): void {
  row.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('.entry') !== row) return;
    choose(pane, key, event.ctrlKey || event.metaKey);
  });
  row.addEventListener('dblclick', (event) => {
    if (
      (event.target as HTMLElement).closest('.entry') !== row ||
      (event.target as HTMLElement).closest('.entry-toggle')
    )
      return;
    openEntry(pane, key);
  });
  row.addEventListener('contextmenu', (event) => {
    if ((event.target as HTMLElement).closest('.entry') !== row) return;
    event.preventDefault();
    event.stopPropagation();
    choose(pane, key, false);
    showMenu(row, pane, { x: event.clientX, y: event.clientY });
  });
  row.addEventListener('keydown', (event) => rowKeydown(event, pane, key, kind));
}

function rowKeydown(event: KeyboardEvent, pane: Pane, key: string, kind: Entry['kind']): void {
  if ((event.target as HTMLElement).closest('.entry') !== event.currentTarget) return;
  if (event.key === 'Enter') openEntry(pane, key);
  else if (event.key === ' ') choose(pane, key, event.ctrlKey || event.metaKey);
  else if (event.key === 'ArrowRight' && kind === 'directory') ensureExpanded(pane, key, true);
  else if (event.key === 'ArrowLeft' && kind === 'directory') ensureExpanded(pane, key, false);
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const list = pane === 'remote' ? remoteList : workspaceList;
    const visible = Array.from(list.querySelectorAll<HTMLElement>('.entry'));
    const current = visible.indexOf(event.currentTarget as HTMLElement);
    const target =
      visible[
        Math.max(0, Math.min(visible.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      ];
    if (target) {
      for (const row of visible) row.tabIndex = -1;
      target.tabIndex = 0;
      if (pane === 'remote') activeRemoteKey = target.dataset.path;
      else activeWorkspaceKey = target.dataset.uri;
      target.focus();
    }
  } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
    showMenu(event.currentTarget as HTMLElement, pane);
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function toggleExpansion(pane: Pane, key: string): void {
  const expanded = pane === 'remote' ? expandedRemote : expandedWorkspace;
  ensureExpanded(pane, key, !expanded.has(key));
}

function ensureExpanded(pane: Pane, key: string, shouldExpand: boolean): void {
  const expanded = pane === 'remote' ? expandedRemote : expandedWorkspace;
  const children = pane === 'remote' ? remoteChildren : workspaceChildren;
  if (!shouldExpand) expanded.delete(key);
  else {
    expanded.add(key);
    if (!children.has(key))
      command(
        pane === 'remote' ? 'remoteExpand' : 'workspaceExpand',
        pane === 'remote' ? { path: key, force: false } : { uri: key },
      );
  }
  if (view) render(view, remoteBusy ? 1 : 0);
}

function choose(pane: Pane, key: string, additive: boolean): void {
  const selected = pane === 'remote' ? remoteSelected : workspaceSelected;
  if (!additive) selected.clear();
  if (additive && selected.has(key)) selected.delete(key);
  else selected.add(key);
  if (pane === 'remote') activeRemoteKey = key;
  else activeWorkspaceKey = key;
  // Keep the clicked row attached so the browser can complete a double-click or drag.
  const rows = pane === 'remote' ? remoteRows : workspaceRows;
  for (const row of Array.from(rows.querySelectorAll<HTMLElement>('.entry'))) {
    const rowKey = pane === 'remote' ? row.dataset.path : row.dataset.uri;
    row.ariaSelected = String(rowKey !== undefined && selected.has(rowKey));
    row.tabIndex = rowKey === key ? 0 : -1;
    if (rowKey === key) row.focus();
  }
  if (view && pane === 'remote') renderRemoteControls(view);
}

function openEntry(pane: Pane, key: string): void {
  command(
    pane === 'remote' ? 'open' : 'workspaceOpen',
    pane === 'remote' ? { path: key } : { uri: key },
  );
}

function startWorkspaceDrag(event: DragEvent, uri: string): void {
  if (!event.dataTransfer) return;
  const uris = workspaceSelected.has(uri) ? [...workspaceSelected] : [uri];
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    'application/x-easyssh-workspace-items',
    JSON.stringify({ type: 'workspace-items', uris }),
  );
  event.dataTransfer.setData('text/plain', 'EasySSH workspace item');
}

function installRemoteDropTarget(row: HTMLElement, entry: Entry): void {
  const valid = () =>
    isRemoteDropTarget(entry.kind, remoteBusy, view?.connection.state ?? 'connecting');
  row.addEventListener('dragenter', (event) => {
    event.stopPropagation();
    remoteList.classList.remove('is-drop-target');
    setDropEffect(event, valid());
    if (valid() && event.defaultPrevented) row.classList.add('is-drop-target');
  });
  row.addEventListener('dragover', (event) => {
    event.stopPropagation();
    setDropEffect(event, valid());
  });
  row.addEventListener('dragleave', (event) => {
    event.stopPropagation();
    if (!row.contains(event.relatedTarget as Node | null)) row.classList.remove('is-drop-target');
  });
  row.addEventListener('drop', (event) => {
    event.stopPropagation();
    row.classList.remove('is-drop-target');
    if (!valid()) return;
    const payload = workspacePayload(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    command('workspaceDrop', { targetPath: entry.path, payload });
  });
}

function setDropEffect(event: DragEvent, valid: boolean): void {
  const accepted =
    valid &&
    !remoteBusy &&
    view?.connection.state === 'connected' &&
    hasWorkspacePayload(event.dataTransfer);
  if (event.dataTransfer) event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
  if (accepted) event.preventDefault();
}

function hasWorkspacePayload(transfer: DataTransfer | null): boolean {
  return transfer?.types.includes('application/x-easyssh-workspace-items') ?? false;
}

function workspacePayload(transfer: DataTransfer | null): unknown {
  if (!hasWorkspacePayload(transfer)) return undefined;
  try {
    return JSON.parse(transfer?.getData('application/x-easyssh-workspace-items') ?? '');
  } catch {
    return undefined;
  }
}

const pathSuggestionReceivers = new Map<
  Pane,
  (requestId: string, suggestions: readonly Suggestion[]) => void
>();

function setupPathBar(pane: Pane): void {
  const input = byId<HTMLInputElement>(`${pane}-path`);
  const popup = byId<HTMLElement>(`${pane}-suggestions`);
  let timer: number | undefined;
  let latestRequest = '';
  let suggestions: readonly Suggestion[] = [];
  let active = -1;
  const hide = () => {
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const submit = (suggestion?: Suggestion) => {
    if (pane === 'remote') {
      if (suggestion) command('navigate', { path: suggestion.value });
      else command('navigateInput', { value: input.value });
    } else if (suggestion?.uri) {
      command('workspaceNavigate', { target: suggestion.uri, input: false });
    } else {
      command('workspaceNavigate', { target: suggestion?.value ?? input.value, input: true });
    }
    hide();
    input.blur();
  };
  const draw = () => {
    popup.replaceChildren();
    suggestions.forEach((suggestion, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = `${pane}-suggestion-${index}`;
      option.className = 'path-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      const label = document.createElement('span');
      label.textContent = suggestion.label;
      const detail = document.createElement('small');
      detail.textContent = suggestion.description;
      option.append(label, detail);
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => submit(suggestion));
      popup.append(option);
    });
    popup.hidden = suggestions.length === 0;
    input.setAttribute('aria-expanded', String(suggestions.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${pane}-suggestion-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const request = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      latestRequest = command(pane === 'remote' ? 'remoteSuggest' : 'workspaceSuggest', {
        value: input.value,
      });
      pathSuggestionReceivers.set(pane, (requestId, next) => {
        if (requestId !== latestRequest || document.activeElement !== input) return;
        suggestions = next;
        active = -1;
        draw();
      });
    }, 150);
  };
  input.addEventListener('input', request);
  input.addEventListener('focus', request);
  input.addEventListener('blur', () => window.setTimeout(hide, 100));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + suggestions.length) % suggestions.length;
      draw();
      event.preventDefault();
    } else if (event.key === 'Enter') {
      submit(active >= 0 ? suggestions[active] : undefined);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      hide();
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function updatePathInput(pane: Pane, path: string): void {
  const input = byId<HTMLInputElement>(`${pane}-path`);
  if (document.activeElement !== input) input.value = path;
}

function selectedRemoteEntry(): Entry | undefined {
  return findRemote(view?.entries ?? [], (entry) => remoteSelected.has(entry.path));
}

function selectedWorkspaceEntry(): WorkspaceEntry | undefined {
  return findWorkspace(view?.workspace.entries ?? [], (entry) => workspaceSelected.has(entry.uri));
}

function findRemote(
  entries: readonly Entry[],
  predicate: (entry: Entry) => boolean,
): Entry | undefined {
  for (const entry of entries) {
    if (predicate(entry)) return entry;
    const child = findRemote(remoteChildren.get(entry.path) ?? [], predicate);
    if (child) return child;
  }
  return undefined;
}

function findWorkspace(
  entries: readonly WorkspaceEntry[],
  predicate: (entry: WorkspaceEntry) => boolean,
): WorkspaceEntry | undefined {
  for (const entry of entries) {
    if (predicate(entry)) return entry;
    const child = findWorkspace(workspaceChildren.get(entry.uri) ?? [], predicate);
    if (child) return child;
  }
  return undefined;
}

function showMenu(
  origin: HTMLElement,
  pane: Pane,
  point?: { readonly x: number; readonly y: number },
): void {
  if (pane === 'remote' ? !selectedRemoteEntry() : !selectedWorkspaceEntry()) return;
  menuPane = pane;
  menuOrigin = origin;
  menu.hidden = false;
  more.setAttribute('aria-expanded', String(pane === 'remote'));
  for (const button of Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-menu]'))) {
    button.hidden = pane === 'workspace' && button.dataset.menu !== 'copy';
  }
  const removeLabel = menu.querySelector<HTMLElement>('[data-menu=delete] .menu-label');
  const remote = selectedRemoteEntry();
  if (removeLabel)
    removeLabel.textContent = remote?.kind === 'directory' ? 'Delete Directory' : 'Delete';
  const originRect = origin.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const position = clampMenuPosition(
    { left: point?.x ?? originRect.right - menuRect.width, top: point?.y ?? originRect.bottom + 4 },
    { width: menuRect.width, height: menuRect.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  menu.style.left = `${position.left}px`;
  menu.style.top = `${position.top}px`;
  menu.querySelector<HTMLButtonElement>('[data-menu]:not([hidden])')?.focus();
}

function hideMenu(restore = false): void {
  if (menu.hidden) return;
  menu.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  if (restore) menuOrigin?.focus();
  menuOrigin = undefined;
}

function iconElement(name: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = `codicon codicon-${name}`;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function setStatus(text: string, tone: string, iconName: string): void {
  status.dataset.tone = tone === 'error' || tone === 'disconnected' ? 'error' : tone;
  const icon = iconElement(iconName);
  if (tone === 'connecting') icon.classList.add('codicon-modifier-spin');
  const label = document.createElement('span');
  label.textContent = text;
  status.replaceChildren(icon, label);
}

function connectionIcon(state: string): string {
  return state === 'connected'
    ? 'pass-filled'
    : state === 'connecting'
      ? 'loading'
      : state === 'disconnected'
        ? 'debug-disconnect'
        : 'warning';
}

function kindLabel(kind: Entry['kind']): string {
  return kind === 'directory'
    ? 'Folder'
    : kind === 'symbolicLink'
      ? 'Link'
      : kind === 'file'
        ? 'File'
        : 'Other';
}

function formatSize(bytes: number): string {
  return `${new Intl.NumberFormat().format(bytes)} B`;
}

function containsRemote(entries: readonly Entry[], path: string): boolean {
  return entries.some(
    (entry) => entry.path === path || containsRemote(remoteChildren.get(entry.path) ?? [], path),
  );
}

function containsWorkspace(entries: readonly WorkspaceEntry[], uri: string): boolean {
  return entries.some(
    (entry) => entry.uri === uri || containsWorkspace(workspaceChildren.get(entry.uri) ?? [], uri),
  );
}

function cloneLayout(value: Layout): Layout {
  return {
    paneRatio: value.paneRatio,
    visibleColumns: [...value.visibleColumns],
    workspaceColumnWidths: { ...value.workspaceColumnWidths },
    remoteColumnWidths: { ...value.remoteColumnWidths },
  };
}

function applyLayout(): void {
  if (!layout || !browserLayout) return;
  browserLayout.style.setProperty('--workspace-pane-width', `${layout.paneRatio * 100}%`);
  paneResizer.setAttribute('aria-valuenow', String(Math.round(layout.paneRatio * 100)));
  for (const pane of ['workspace', 'remote'] as const) {
    const list = pane === 'workspace' ? workspaceList : remoteList;
    const widths = pane === 'workspace' ? layout.workspaceColumnWidths : layout.remoteColumnWidths;
    list.style.setProperty('--column-template', columnTemplate(layout.visibleColumns, widths));
  }
  const visible = new Set(layout.visibleColumns);
  for (const cell of Array.from(document.querySelectorAll<HTMLElement>('[data-column]'))) {
    const column = cell.dataset.column;
    cell.hidden = !column || !visible.has(column as BrowserColumnKey);
  }
  for (const checkbox of Array.from(
    columnsMenu.querySelectorAll<HTMLInputElement>('[data-column-toggle]'),
  )) {
    checkbox.checked = visible.has(checkbox.dataset.columnToggle as BrowserColumnKey);
  }
  for (const pane of ['workspace', 'remote'] as const) {
    const last = layout.visibleColumns.at(-1);
    for (const handle of Array.from(
      document.querySelectorAll<HTMLElement>(`[data-pane="${pane}"][data-resize-column]`),
    )) {
      handle.hidden = handle.dataset.resizeColumn === last;
    }
  }
}

function persistLayout(): void {
  if (!layout) return;
  if (view) view = { ...view, layout: cloneLayout(layout) };
  command('setLayout', { layout });
}

function setPaneRatio(value: number, persist: boolean): void {
  if (!layout) return;
  layout.paneRatio = clampPaneRatio(value);
  applyLayout();
  if (persist) persistLayout();
}

function setupPaneResize(): void {
  let startX = 0;
  let startRatio = 0;
  let availableWidth = 1;
  paneResizer.addEventListener('pointerdown', (event) => {
    if (!layout || !browserLayout || window.matchMedia('(max-width: 44rem)').matches) return;
    startX = event.clientX;
    startRatio = layout.paneRatio;
    availableWidth = Math.max(1, browserLayout.getBoundingClientRect().width);
    paneResizer.classList.add('is-resizing');
    paneResizer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  paneResizer.addEventListener('pointermove', (event) => {
    if (!paneResizer.hasPointerCapture(event.pointerId)) return;
    setPaneRatio(startRatio + (event.clientX - startX) / availableWidth, false);
  });
  const finish = (event: PointerEvent) => {
    if (!paneResizer.hasPointerCapture(event.pointerId)) return;
    paneResizer.releasePointerCapture(event.pointerId);
    paneResizer.classList.remove('is-resizing');
    persistLayout();
  };
  paneResizer.addEventListener('pointerup', finish);
  paneResizer.addEventListener('pointercancel', finish);
  paneResizer.addEventListener('dblclick', () => setPaneRatio(0.4, true));
  paneResizer.addEventListener('keydown', (event) => {
    if (!layout) return;
    const increment = event.shiftKey ? 0.1 : 0.02;
    if (event.key === 'ArrowLeft') setPaneRatio(layout.paneRatio - increment, true);
    else if (event.key === 'ArrowRight') setPaneRatio(layout.paneRatio + increment, true);
    else if (event.key === 'Home') setPaneRatio(0.2, true);
    else if (event.key === 'End') setPaneRatio(0.8, true);
    else return;
    event.preventDefault();
  });
}

function setupColumnResize(): void {
  const defaults: ColumnWidths = { name: 260, type: 110, size: 100, mtime: 180, path: 280 };
  for (const handle of Array.from(
    document.querySelectorAll<HTMLElement>('[data-resize-column][data-pane]'),
  )) {
    const pane = handle.dataset.pane as Pane;
    const column = handle.dataset.resizeColumn as BrowserColumnKey;
    let startX = 0;
    let startWidth = 0;
    const widths = () =>
      pane === 'workspace' ? layout?.workspaceColumnWidths : layout?.remoteColumnWidths;
    handle.addEventListener('pointerdown', (event) => {
      const current = widths();
      if (!current) return;
      startX = event.clientX;
      startWidth = current[column];
      handle.classList.add('is-resizing');
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const current = widths();
      if (!current) return;
      current[column] = clampColumnWidth(startWidth + event.clientX - startX);
      applyLayout();
    });
    const finish = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      handle.classList.remove('is-resizing');
      persistLayout();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('dblclick', (event) => {
      const current = widths();
      if (!current) return;
      current[column] = defaults[column];
      applyLayout();
      persistLayout();
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('keydown', (event) => {
      const current = widths();
      if (!current) return;
      const increment = event.shiftKey ? 50 : 10;
      if (event.key === 'ArrowLeft')
        current[column] = clampColumnWidth(current[column] - increment);
      else if (event.key === 'ArrowRight')
        current[column] = clampColumnWidth(current[column] + increment);
      else if (event.key === 'Home') current[column] = defaults[column];
      else return;
      applyLayout();
      persistLayout();
      event.preventDefault();
      event.stopPropagation();
    });
  }
}

function hideColumnsMenu(restoreFocus: boolean): void {
  columnsMenu.hidden = true;
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-columns-button]'),
  ))
    button.setAttribute('aria-expanded', 'false');
  if (restoreFocus) columnsMenuOrigin?.focus();
  columnsMenuOrigin = undefined;
}

let columnsMenuOrigin: HTMLButtonElement | undefined;

function showColumnsMenu(button: HTMLButtonElement): void {
  hideMenu(false);
  columnsMenuOrigin = button;
  columnsMenu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const rect = button.getBoundingClientRect();
  const position = clampMenuPosition(
    { left: rect.right - columnsMenu.offsetWidth, top: rect.bottom + 4 },
    { width: columnsMenu.offsetWidth, height: columnsMenu.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  columnsMenu.style.left = `${position.left}px`;
  columnsMenu.style.top = `${position.top}px`;
  columnsMenu.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
}

function setupColumnsMenu(): void {
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-columns-button]'),
  )) {
    button.addEventListener('click', () => {
      if (!columnsMenu.hidden && columnsMenuOrigin === button) hideColumnsMenu(true);
      else showColumnsMenu(button);
    });
  }
  columnsMenu.addEventListener('change', (event) => {
    if (!layout) return;
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-column-toggle]');
    const column = input?.dataset.columnToggle as BrowserColumnKey | undefined;
    if (!input || !column || column === 'name') return;
    const visible = new Set(layout.visibleColumns);
    if (input.checked) visible.add(column);
    else visible.delete(column);
    const order: readonly BrowserColumnKey[] = ['name', 'type', 'size', 'mtime', 'path'];
    layout.visibleColumns = order.filter((candidate) => visible.has(candidate));
    applyLayout();
    persistLayout();
  });
}

setupPaneResize();
setupColumnResize();
setupColumnsMenu();

byId<HTMLButtonElement>('back').addEventListener('click', () => command('back'));
byId<HTMLButtonElement>('forward').addEventListener('click', () => command('forward'));
byId<HTMLButtonElement>('up').addEventListener('click', () => command('up'));
byId<HTMLButtonElement>('refresh').addEventListener('click', () => {
  const expanded = [...expandedRemote];
  remoteChildren.clear();
  command('list', { path: view?.path ?? '/', force: true });
  for (const path of expanded) command('remoteExpand', { path, force: true });
});
byId<HTMLButtonElement>('workspace-back').addEventListener('click', () => command('workspaceBack'));
byId<HTMLButtonElement>('workspace-forward').addEventListener('click', () =>
  command('workspaceForward'),
);
byId<HTMLButtonElement>('workspace-up').addEventListener('click', () => command('workspaceUp'));
function navigateToWorkspace(): void {
  if (byId<HTMLButtonElement>('workspace-home').disabled) return;
  command('workspaceNavigate', { target: 'Workspace', input: true });
}
byId<HTMLButtonElement>('workspace-home').addEventListener('click', navigateToWorkspace);
byId<HTMLElement>('workspace-pane').addEventListener('keydown', (event) => {
  if (event.altKey && event.key === 'Home') {
    event.preventDefault();
    navigateToWorkspace();
  }
});
byId<HTMLButtonElement>('workspace-refresh').addEventListener('click', () => {
  const expanded = [...expandedWorkspace];
  workspaceChildren.clear();
  command('workspaceRefresh');
  for (const uri of expanded) command('workspaceExpand', { uri });
});
byId<HTMLButtonElement>('new-file').addEventListener('click', () => {
  const name = window.prompt('New remote file name');
  if (name && view) command('createFile', { parentPath: view.path, name });
});
byId<HTMLButtonElement>('new-folder').addEventListener('click', () => {
  const name = window.prompt('New remote folder name');
  if (name && view) command('createDirectory', { parentPath: view.path, name });
});
byId<HTMLButtonElement>('download').addEventListener('click', () =>
  command('download', { paths: [...remoteSelected] }),
);
byId<HTMLButtonElement>('upload-files').addEventListener('click', () =>
  command('uploadFiles', {
    targetPath:
      selectedRemoteEntry()?.kind === 'directory'
        ? selectedRemoteEntry()!.path
        : (view?.path ?? '/'),
  }),
);
byId<HTMLButtonElement>('upload-folder').addEventListener('click', () =>
  command('uploadFolder', {
    targetPath:
      selectedRemoteEntry()?.kind === 'directory'
        ? selectedRemoteEntry()!.path
        : (view?.path ?? '/'),
  }),
);

for (const pane of ['remote', 'workspace'] as const) {
  const selector = pane === 'remote' ? '[data-sort]' : '[data-workspace-sort]';
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>(selector))) {
    button.addEventListener('click', () => {
      const key = pane === 'remote' ? button.dataset.sort : button.dataset.workspaceSort;
      if (key !== 'name' && key !== 'size' && key !== 'mtime') return;
      const current = pane === 'remote' ? view?.sort : view?.workspace.sort;
      const direction = current?.key === key && current.direction === 'asc' ? 'desc' : 'asc';
      if (pane === 'remote') remoteChildren.clear();
      else workspaceChildren.clear();
      if (pane === 'remote') expandedRemote.clear();
      else expandedWorkspace.clear();
      command(pane === 'remote' ? 'setSort' : 'workspaceSetSort', { key, direction });
    });
  }
  setupPathBar(pane);
}

remoteList.addEventListener('dragover', (event) => {
  if ((event.target as HTMLElement).closest('.entry,.headers')) return;
  setDropEffect(
    event,
    isRemoteDropTarget('currentDirectory', remoteBusy, view?.connection.state ?? 'connecting'),
  );
  if (event.defaultPrevented) remoteList.classList.add('is-drop-target');
});
remoteList.addEventListener('dragleave', (event) => {
  if (!remoteList.contains(event.relatedTarget as Node | null))
    remoteList.classList.remove('is-drop-target');
});
remoteList.addEventListener('drop', (event) => {
  if ((event.target as HTMLElement).closest('.entry,.headers')) return;
  remoteList.classList.remove('is-drop-target');
  const payload = workspacePayload(event.dataTransfer);
  if (!payload || remoteBusy || view?.connection.state !== 'connected') return;
  event.preventDefault();
  command('workspaceDrop', { targetPath: view?.path ?? '/', payload });
});

more.addEventListener('click', () => {
  if (menu.hidden) showMenu(more, 'remote');
  else hideMenu(true);
});
menu.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-menu]')?.dataset
    .menu;
  const remote = selectedRemoteEntry();
  const workspace = selectedWorkspaceEntry();
  hideMenu(true);
  if (!action) return;
  if (menuPane === 'workspace' && workspace && action === 'copy')
    command('workspaceCopyPath', { uri: workspace.uri });
  if (menuPane === 'remote' && remote) {
    if (action === 'copy') command('copyPath', { path: remote.path });
    if (action === 'delete') command('delete', { path: remote.path });
    if (action === 'rename') {
      const newName = window.prompt('New remote name', remote.name);
      if (newName) command('rename', { path: remote.path, newName });
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideColumnsMenu(true);
    hideMenu(true);
    command('cancel');
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !menu.contains(event.target as Node) && !more.contains(event.target as Node))
    hideMenu(false);
  if (
    !columnsMenu.hidden &&
    !columnsMenu.contains(event.target as Node) &&
    !(event.target as HTMLElement).closest('[data-columns-button]')
  )
    hideColumnsMenu(false);
});
window.addEventListener('resize', () => {
  hideMenu(false);
  hideColumnsMenu(false);
});
window.addEventListener('blur', () => {
  hideMenu(false);
  hideColumnsMenu(false);
});
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  const typed = message as Record<string, unknown>;
  if (typed.type === 'render' && isView(typed.value))
    render(typed.value, typeof typed.pending === 'number' ? typed.pending : 0);
  if (typed.type === 'persist') vscode.setState(typed.value);
  if (
    typed.type === 'remoteChildren' &&
    typeof typed.path === 'string' &&
    isEntries(typed.entries)
  ) {
    remoteChildren.set(typed.path, typed.entries);
    remoteErrors.delete(typed.path);
    if (view) render(view, remoteBusy ? 1 : 0);
  }
  if (
    typed.type === 'workspaceChildren' &&
    typeof typed.uri === 'string' &&
    typed.generation === workspaceGeneration &&
    isWorkspaceEntries(typed.entries)
  ) {
    workspaceChildren.set(typed.uri, typed.entries);
    workspaceErrors.delete(typed.uri);
    if (view) render(view, remoteBusy ? 1 : 0);
  }
  if (
    typed.type === 'remoteError' &&
    typeof typed.path === 'string' &&
    typeof typed.error === 'string'
  ) {
    remoteErrors.set(typed.path, typed.error);
    if (view) render(view, remoteBusy ? 1 : 0);
  }
  if (
    typed.type === 'workspaceError' &&
    typeof typed.uri === 'string' &&
    typeof typed.error === 'string'
  ) {
    workspaceErrors.set(typed.uri, typed.error);
    if (view) render(view, remoteBusy ? 1 : 0);
  }
  if (
    typed.type === 'pathSuggestions' &&
    (typed.pane === 'remote' || typed.pane === 'workspace') &&
    typeof typed.requestId === 'string' &&
    isSuggestions(typed.suggestions)
  ) {
    pathSuggestionReceivers.get(typed.pane)?.(typed.requestId, typed.suggestions);
  }
  if (typed.type === 'response') renderResponse(message as SftpResponseMessage);
});

// The webview is recreated when a hidden panel becomes visible again.
command('ready');

function isView(value: unknown): value is View {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { entries?: unknown }).entries) &&
    (value as { workspace?: unknown }).workspace !== undefined
  );
}

function isEntries(value: unknown): value is readonly Entry[] {
  return Array.isArray(value);
}

function isWorkspaceEntries(value: unknown): value is readonly WorkspaceEntry[] {
  return Array.isArray(value);
}

function isSuggestions(value: unknown): value is readonly Suggestion[] {
  return Array.isArray(value);
}

interface SftpResponseMessage {
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: { readonly message?: unknown };
}

function renderResponse(response: SftpResponseMessage): void {
  if (response.ok === false) {
    setStatus(
      typeof response.error?.message === 'string'
        ? response.error.message
        : 'The SFTP operation could not be completed.',
      'error',
      'error',
    );
    return;
  }
  if (isDownloadSummary(response.value)) {
    setStatus(
      `Download complete: ${response.value.completed} completed, ${response.value.skipped.length} skipped, ${response.value.failed.length} failed${response.value.cancelled ? ', cancelled' : ''}.`,
      response.value.failed.length > 0 ? 'error' : 'success',
      response.value.failed.length > 0 ? 'warning' : 'pass-filled',
    );
  }
  if (isTransferSummary(response.value)) {
    setStatus(
      `Upload complete: ${response.value.uploaded} uploaded, ${response.value.createdDirectories} directories created, ${response.value.skipped.length + response.value.skippedLinks.length} skipped, ${response.value.failed.length} failed${response.value.cancelled ? ', cancelled' : ''}.`,
      response.value.failed.length > 0 ? 'error' : 'success',
      response.value.failed.length > 0 ? 'warning' : 'pass-filled',
    );
  }
}

function isDownloadSummary(value: unknown): value is {
  readonly completed: number;
  readonly skipped: readonly unknown[];
  readonly failed: readonly unknown[];
  readonly cancelled: boolean;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { completed?: unknown }).completed === 'number' &&
    Array.isArray((value as { skipped?: unknown }).skipped) &&
    Array.isArray((value as { failed?: unknown }).failed) &&
    typeof (value as { cancelled?: unknown }).cancelled === 'boolean'
  );
}

function isTransferSummary(value: unknown): value is {
  readonly uploaded: number;
  readonly createdDirectories: number;
  readonly skipped: readonly unknown[];
  readonly skippedLinks: readonly unknown[];
  readonly failed: readonly unknown[];
  readonly cancelled: boolean;
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { uploaded?: unknown }).uploaded === 'number' &&
    typeof (value as { createdDirectories?: unknown }).createdDirectories === 'number' &&
    Array.isArray((value as { skipped?: unknown }).skipped) &&
    Array.isArray((value as { skippedLinks?: unknown }).skippedLinks) &&
    Array.isArray((value as { failed?: unknown }).failed) &&
    typeof (value as { cancelled?: unknown }).cancelled === 'boolean'
  );
}
