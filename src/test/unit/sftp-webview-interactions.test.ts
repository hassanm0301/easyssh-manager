// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSftpLayoutState } from '../../sftp/browser/contracts';
import { sftpPanelHtml } from '../../views/sftp/SftpPanel';

const postMessage = vi.fn();
const errors = vi.fn();
let generation = 0;
let bootstrapMessages: unknown[][];

function message(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function show(entries: readonly unknown[] = [], workspaceEntries: readonly unknown[] = []): void {
  message({
    type: 'render',
    pending: 0,
    value: {
      path: '/',
      entries,
      canGoBack: false,
      canGoForward: false,
      canGoUp: false,
      sort: { key: 'name', direction: 'asc' },
      connection: { state: 'connected', text: 'Connected' },
      workspace: {
        generation: ++generation,
        state: 'ready',
        path: 'Workspace',
        location: 'workspace',
        entries: workspaceEntries,
        canGoBack: false,
        canGoForward: false,
        canGoUp: false,
        sort: { key: 'name', direction: 'asc' },
        loading: false,
      },
      layout: defaultSftpLayoutState(),
    },
  });
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing test element: ${selector}`);
  return found;
}

function doubleClick(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
}

describe('SFTP browser interactions', () => {
  beforeAll(async () => {
    const Uri = { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') };
    const html = sftpPanelHtml(
      { cspSource: 'local:', asWebviewUri: (uri: unknown) => uri } as never,
      { Uri } as never,
      {} as never,
      'test-nonce',
    );
    document.documentElement.innerHTML = html;
    window.addEventListener('error', errors);
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage, setState: vi.fn() }));
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    await import('../../views/sftp/webview/main.js');
    bootstrapMessages = [...postMessage.mock.calls];
  });

  beforeEach(() => {
    postMessage.mockClear();
    errors.mockClear();
    show();
  });

  afterEach(() => expect(errors).not.toHaveBeenCalled());

  afterAll(() => {
    window.removeEventListener('error', errors);
    vi.unstubAllGlobals();
  });

  it('requests current host state after loading and applies the initial layout', () => {
    expect(bootstrapMessages).toEqual([[expect.objectContaining({ type: 'ready' })]]);
    expect(element('.browser-layout').style.getPropertyValue('--workspace-pane-width')).toBe('40%');
    expect(element('#list').style.getPropertyValue('--column-template')).toBe('260px 100px 180px');
  });

  it('returns to the current workspace using the home button and Alt+Home', () => {
    element('#workspace-home').click();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workspaceNavigate', target: 'Workspace', input: true }),
    );
    postMessage.mockClear();
    element('#workspace-list').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', altKey: true, bubbles: true }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workspaceNavigate', target: 'Workspace', input: true }),
    );
  });

  it('keeps a selected row attached so double-click opens the file', () => {
    show([{ name: 'file.txt', path: '/file.txt', kind: 'file' }]);
    const row = element('.remote-entry');
    element('.remote-entry .name').click();
    expect(row.isConnected).toBe(true);
    expect(row.ariaSelected).toBe('true');
    doubleClick(element('.remote-entry .name'));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open', path: '/file.txt' }),
    );
  });

  it.each(['remote', 'workspace'] as const)(
    'opens nested %s files with mouse and keyboard without activating their parent',
    (pane) => {
      const root = { name: 'folder', path: '/folder', uri: 'file:///folder', kind: 'directory' };
      const child = {
        name: 'nested.txt',
        path: '/folder/nested.txt',
        uri: 'file:///folder/nested.txt',
        kind: 'file',
      };
      show(pane === 'remote' ? [root] : [], pane === 'workspace' ? [root] : []);
      element(`.${pane}-entry .entry-toggle`).click();
      message({
        type: pane === 'remote' ? 'remoteChildren' : 'workspaceChildren',
        path: root.path,
        uri: root.uri,
        entries: [child],
        generation,
      });
      const row = element(`.${pane}-entry .entry-children .${pane}-entry`);
      const name = row.querySelector<HTMLElement>('.name');
      if (!name) throw new Error('Missing nested file name.');
      name.click();
      expect(row.ariaSelected).toBe('true');
      expect(row.isConnected).toBe(true);
      postMessage.mockClear();
      doubleClick(name);
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const expected =
        pane === 'remote'
          ? { type: 'open', path: child.path }
          : { type: 'workspaceOpen', uri: child.uri };
      expect(postMessage).toHaveBeenCalledTimes(2);
      for (const [sent] of postMessage.mock.calls) expect(sent).toMatchObject(expected);
    },
  );

  it('keeps native Windows file URI encoding intact in workspace drag payloads', () => {
    const uri = 'file:///C:/Users/Hassan%20M%C3%A9t%C3%A9or/project%20files/source.txt';
    show(
      [],
      [
        {
          name: 'source.txt',
          path: 'C:\\Users\\Hassan Météor\\project files\\source.txt',
          uri,
          kind: 'file',
        },
      ],
    );
    const values = new Map<string, string>();
    const transfer = {
      effectAllowed: '',
      setData: (type: string, value: string) => values.set(type, value),
    };
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    element('.workspace-entry .name').dispatchEvent(event);

    expect(JSON.parse(values.get('application/x-easyssh-workspace-items') ?? '')).toEqual({
      type: 'workspace-items',
      uris: [uri],
    });
    expect(transfer.effectAllowed).toBe('copy');
  });

  it('resizes the panes by dragging and keyboard and sends the resulting layout to the host', () => {
    const divider = element('#pane-resizer');
    const captured = new Set<number>();
    divider.setPointerCapture = (id) => void captured.add(id);
    divider.hasPointerCapture = (id) => captured.has(id);
    divider.releasePointerCapture = (id) => void captured.delete(id);
    vi.spyOn(element('.browser-layout'), 'getBoundingClientRect').mockReturnValue({
      width: 1_000,
    } as DOMRect);
    for (const [type, clientX] of [
      ['pointerdown', 400],
      ['pointermove', 600],
      ['pointerup', 600],
    ] as const) {
      divider.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, clientX }));
    }
    expect(
      parseFloat(element('.browser-layout').style.getPropertyValue('--workspace-pane-width')),
    ).toBeCloseTo(60);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'setLayout',
        layout: expect.objectContaining({ paneRatio: expect.closeTo(0.6) }),
      }),
    );
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true }));
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(50);
  });

  it('resizes columns without losing the current file rows', () => {
    show([{ name: 'column.txt', path: '/column.txt', kind: 'file' }]);
    const row = element('.remote-entry');
    element('[data-pane="remote"][data-resize-column="size"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(element('#list').style.getPropertyValue('--column-template')).toBe('260px 110px 180px');
    expect(row.isConnected).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'setLayout',
        layout: expect.objectContaining({
          remoteColumnWidths: expect.objectContaining({ size: 110 }),
        }),
      }),
    );
  });
});
