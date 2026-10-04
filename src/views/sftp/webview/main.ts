/* Browser-only SFTP panel client. It never interpolates remote data into HTML. */
declare function acquireVsCodeApi(): {
  setState(state: unknown): void;
  postMessage(message: unknown): void;
};

type Entry = {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symbolicLink' | 'other';
  readonly size?: number;
  readonly mtimeMs?: number;
};

type View = {
  readonly path: string;
  readonly entries: readonly Entry[];
  readonly breadcrumbs: readonly { readonly name: string; readonly path: string }[];
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
  readonly sort: { readonly key: 'name' | 'size' | 'mtime'; readonly direction: 'asc' | 'desc' };
  readonly connection: { readonly state: string; readonly text: string };
};

const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing static SFTP panel element '${id}'.`);
  return element as T;
};
const rows = byId<HTMLDivElement>('rows');
const list = byId<HTMLElement>('list');
const breadcrumbs = byId<HTMLElement>('breadcrumbs');
const status = byId<HTMLElement>('status');
const empty = byId<HTMLElement>('empty');
const error = byId<HTMLElement>('error');
const menu = byId<HTMLElement>('menu');
const more = byId<HTMLButtonElement>('more');

let view: View | undefined;
let selected = new Set<string>();
let activeIndex = 0;
let sequence = 0;

function send(message: Record<string, unknown>): void {
  sequence += 1;
  vscode.postMessage({ ...message, requestId: `sftp-${sequence}` });
}

function command(type: string, extra: Record<string, unknown> = {}): void {
  send({ type, ...extra });
}

function selectedEntry(): Entry | undefined {
  if (!view) return undefined;
  return view.entries.find((entry) => selected.has(entry.path));
}

function render(next: View): void {
  view = next;
  selected = new Set(
    [...selected].filter((path) => next.entries.some((entry) => entry.path === path)),
  );
  if (activeIndex >= next.entries.length) activeIndex = Math.max(0, next.entries.length - 1);
  status.replaceChildren(
    icon(next.connection.state),
    document.createTextNode(` ${next.connection.text}`),
  );
  byId<HTMLButtonElement>('back').disabled = !next.canGoBack;
  byId<HTMLButtonElement>('forward').disabled = !next.canGoForward;
  byId<HTMLButtonElement>('up').disabled = !next.canGoUp;
  const refresh = byId<HTMLButtonElement>('refresh');
  refresh.textContent =
    next.connection.state === 'disconnected' || next.connection.state === 'error'
      ? 'Reconnect'
      : 'Refresh';
  breadcrumbs.replaceChildren();
  next.breadcrumbs.forEach((crumb, index) => {
    if (index > 0) breadcrumbs.append(document.createTextNode(' / '));
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = crumb.name;
    button.addEventListener('click', () => command('navigate', { path: crumb.path }));
    breadcrumbs.append(button);
  });
  rows.replaceChildren();
  next.entries.forEach((entry, index) => rows.append(row(entry, index)));
  empty.hidden = next.entries.length !== 0;
  error.hidden = next.connection.state !== 'error' && next.connection.state !== 'disconnected';
  error.textContent = error.hidden ? '' : next.connection.text;
  const selectedAny = selected.size > 0;
  byId<HTMLButtonElement>('download').disabled = !selectedAny;
}

function row(entry: Entry, index: number): HTMLElement {
  const item = document.createElement('div');
  item.className = 'entry';
  item.role = 'option';
  item.tabIndex = index === activeIndex ? 0 : -1;
  item.dataset.path = entry.path;
  item.ariaSelected = selected.has(entry.path) ? 'true' : 'false';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${kindLabel(entry.kind)} ${entry.name}`;
  const size = document.createElement('span');
  size.textContent = entry.size === undefined ? '—' : formatSize(entry.size);
  const mtime = document.createElement('span');
  mtime.textContent = entry.mtimeMs === undefined ? '—' : new Date(entry.mtimeMs).toLocaleString();
  item.append(name, size, mtime);
  item.addEventListener('click', () => choose(entry.path, index));
  item.addEventListener('dblclick', () => command('open', { path: entry.path }));
  item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    choose(entry.path, index);
    showMenu(item);
  });
  item.addEventListener('keydown', (event) => keydown(event, index));
  return item;
}

function choose(path: string, index: number): void {
  selected = new Set([path]);
  activeIndex = index;
  if (view) render(view);
  const target = Array.from(rows.querySelectorAll<HTMLElement>('[role=option]')).find(
    (candidate) => candidate.dataset.path === path,
  );
  target?.focus();
}

function keydown(event: KeyboardEvent, index: number): void {
  if (!view) return;
  if (event.key === 'Enter') {
    const entry = view.entries[index];
    if (entry) command('open', { path: entry.path });
    event.preventDefault();
  } else if (event.key === ' ') {
    const entry = view.entries[index];
    if (entry) choose(entry.path, index);
    event.preventDefault();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    activeIndex = Math.max(
      0,
      Math.min(view.entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    if (view) render(view);
    rows.querySelectorAll<HTMLElement>('[role=option]')[activeIndex]?.focus();
    event.preventDefault();
  } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    const entry = view.entries[index];
    if (entry) choose(entry.path, index);
    showMenu(rows.querySelectorAll<HTMLElement>('[role=option]')[index] ?? list);
    event.preventDefault();
  } else if (event.key === 'Escape') {
    hideMenu();
    selected.clear();
    render(view);
    list.focus();
    command('cancel');
    event.stopPropagation();
  }
}

function showMenu(origin: HTMLElement): void {
  const entry = selectedEntry();
  if (!entry) return;
  menu.hidden = false;
  more.setAttribute('aria-expanded', 'true');
  const remove = menu.querySelector<HTMLButtonElement>('[data-menu=delete]');
  if (remove) remove.textContent = entry.kind === 'directory' ? 'Delete Directory' : 'Delete';
  menu.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
  void origin;
}

function hideMenu(restore = false): void {
  if (menu.hidden) return;
  menu.hidden = true;
  more.setAttribute('aria-expanded', 'false');
  if (restore)
    (selectedEntry()
      ? rows.querySelector<HTMLElement>('[role=option][tabindex="0"]')
      : more
    )?.focus();
}

function icon(state: string): Text {
  const value =
    state === 'connected'
      ? '●'
      : state === 'connecting'
        ? '◌'
        : state === 'disconnected'
          ? '○'
          : '⚠';
  return document.createTextNode(value);
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

byId<HTMLButtonElement>('back').addEventListener('click', () => command('back'));
byId<HTMLButtonElement>('forward').addEventListener('click', () => command('forward'));
byId<HTMLButtonElement>('up').addEventListener('click', () => command('up'));
byId<HTMLButtonElement>('refresh').addEventListener('click', () =>
  command('list', { path: view?.path ?? '/', force: true }),
);
byId<HTMLButtonElement>('new-file').addEventListener('click', () => {
  const name = window.prompt('New remote file name');
  if (name && view) command('createFile', { parentPath: view.path, name });
});
byId<HTMLButtonElement>('new-folder').addEventListener('click', () => {
  const name = window.prompt('New remote folder name');
  if (name && view) command('createDirectory', { parentPath: view.path, name });
});
byId<HTMLButtonElement>('download').addEventListener('click', () =>
  command('download', { paths: [...selected] }),
);
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sort]'))) {
  button.addEventListener('click', () => {
    const key = button.dataset.sort;
    if (key !== 'name' && key !== 'size' && key !== 'mtime') return;
    const current = view;
    const direction =
      current?.sort.key === key && current.sort.direction === 'asc' ? 'desc' : 'asc';
    command('setSort', { key, direction });
  });
}
for (const button of [
  byId<HTMLButtonElement>('upload-files'),
  byId<HTMLButtonElement>('upload-folder'),
]) {
  button.addEventListener('click', () => {
    status.replaceChildren(document.createTextNode('Upload will be available in Milestone 06.'));
  });
}
more.addEventListener('click', () => {
  if (menu.hidden) showMenu(more);
  else hideMenu(true);
});
menu.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-menu]')?.dataset
    .menu;
  const entry = selectedEntry();
  hideMenu(true);
  if (!entry || !action) return;
  if (action === 'copy') command('copyPath', { path: entry.path });
  if (action === 'delete') command('delete', { path: entry.path });
  if (action === 'rename') {
    const newName = window.prompt('New remote name', entry.name);
    if (newName) command('rename', { path: entry.path, newName });
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideMenu(true);
    command('cancel');
  }
});
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  const typed = message as { type?: unknown; value?: unknown };
  if (typed.type === 'render' && isView(typed.value)) render(typed.value);
  if (typed.type === 'persist') vscode.setState(typed.value);
  if (typed.type === 'response') renderResponse(message as SftpResponseMessage);
});

function isView(value: unknown): value is View {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

interface SftpResponseMessage {
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: { readonly message?: unknown };
}

function renderResponse(response: SftpResponseMessage): void {
  if (response.ok === false) {
    const message =
      typeof response.error?.message === 'string'
        ? response.error.message
        : 'The SFTP operation could not be completed.';
    status.replaceChildren(document.createTextNode(message));
    return;
  }
  if (isDownloadSummary(response.value)) {
    status.replaceChildren(
      document.createTextNode(
        `Download complete: ${response.value.completed} completed, ${response.value.skipped.length} skipped, ${response.value.failed.length} failed${response.value.cancelled ? ', cancelled' : ''}.`,
      ),
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
