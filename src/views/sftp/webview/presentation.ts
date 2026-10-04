export type BrowserEntryKind = 'file' | 'directory' | 'symbolicLink' | 'other' | undefined;
export type BrowserColumnKey = 'name' | 'type' | 'size' | 'mtime' | 'path';

export function clampPaneRatio(value: number): number {
  return Math.max(0.2, Math.min(0.8, value));
}

export function clampColumnWidth(value: number): number {
  return Math.round(Math.max(64, Math.min(1_200, value)));
}

export function columnTemplate(
  visible: readonly BrowserColumnKey[],
  widths: Readonly<Record<BrowserColumnKey, number>>,
): string {
  return visible.map((column) => `${clampColumnWidth(widths[column])}px`).join(' ');
}

export function entryIconName(kind: BrowserEntryKind): string {
  return kind === 'directory' || kind === undefined
    ? 'folder'
    : kind === 'symbolicLink'
      ? 'file-symlink-file'
      : kind === 'file'
        ? 'file'
        : 'question';
}

export function sortIconName(
  activeKey: 'name' | 'size' | 'mtime',
  direction: 'asc' | 'desc',
  column: string | undefined,
): string {
  if (column !== activeKey) return '';
  return direction === 'asc' ? 'chevron-up' : 'chevron-down';
}

export function isRemoteDropTarget(
  kind: BrowserEntryKind | 'currentDirectory',
  busy: boolean,
  connectionState: string,
): boolean {
  return (
    !busy &&
    connectionState === 'connected' &&
    (kind === 'directory' || kind === 'currentDirectory')
  );
}

export function controlAvailability(input: {
  readonly pending: number;
  readonly selected: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canGoUp: boolean;
}): {
  readonly busy: boolean;
  readonly back: boolean;
  readonly forward: boolean;
  readonly up: boolean;
  readonly selectionActions: boolean;
} {
  const busy = input.pending > 0;
  return {
    busy,
    back: !busy && input.canGoBack,
    forward: !busy && input.canGoForward,
    up: !busy && input.canGoUp,
    selectionActions: !busy && input.selected,
  };
}

export function clampMenuPosition(
  preferred: { readonly left: number; readonly top: number },
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  margin = 8,
): { readonly left: number; readonly top: number } {
  return {
    left: Math.max(margin, Math.min(preferred.left, viewport.width - menu.width - margin)),
    top: Math.max(margin, Math.min(preferred.top, viewport.height - menu.height - margin)),
  };
}
