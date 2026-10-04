import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  clampMenuPosition,
  controlAvailability,
  entryIconName,
  isRemoteDropTarget,
  sortIconName,
} from '../../views/sftp/webview/presentation';

describe('webview presentation', () => {
  it('maps remote entry kinds and active sorts to packaged Codicons', () => {
    expect(entryIconName('directory')).toBe('folder');
    expect(entryIconName('file')).toBe('file');
    expect(entryIconName('symbolicLink')).toBe('file-symlink-file');
    expect(entryIconName('other')).toBe('question');
    expect(sortIconName('name', 'asc', 'name')).toBe('chevron-up');
    expect(sortIconName('mtime', 'desc', 'mtime')).toBe('chevron-down');
    expect(sortIconName('name', 'asc', 'size')).toBe('');
  });

  it('disables conflicting controls while loading and requires a selection for item actions', () => {
    expect(
      controlAvailability({
        pending: 1,
        selected: true,
        canGoBack: true,
        canGoForward: true,
        canGoUp: true,
      }),
    ).toEqual({ busy: true, back: false, forward: false, up: false, selectionActions: false });
    expect(
      controlAvailability({
        pending: 0,
        selected: true,
        canGoBack: true,
        canGoForward: false,
        canGoUp: true,
      }),
    ).toEqual({ busy: false, back: true, forward: false, up: true, selectionActions: true });
  });

  it('keeps context menus inside the visible viewport', () => {
    expect(
      clampMenuPosition(
        { left: 790, top: 590 },
        { width: 180, height: 140 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ left: 612, top: 452 });
    expect(
      clampMenuPosition(
        { left: -20, top: -10 },
        { width: 180, height: 140 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ left: 8, top: 8 });
  });

  it('offers copy drag feedback only for connected remote directories', () => {
    expect(isRemoteDropTarget('directory', false, 'connected')).toBe(true);
    expect(isRemoteDropTarget('currentDirectory', false, 'connected')).toBe(true);
    expect(isRemoteDropTarget('file', false, 'connected')).toBe(false);
    expect(isRemoteDropTarget('symbolicLink', false, 'connected')).toBe(false);
    expect(isRemoteDropTarget('directory', true, 'connected')).toBe(false);
    expect(isRemoteDropTarget('directory', false, 'disconnected')).toBe(false);
  });
});

describe('extension UI assets', () => {
  it('declares a packaged Activity Bar icon and a native import command icon', () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      contributes: {
        viewsContainers: { activitybar: { icon: string }[] };
        commands: { command: string; icon?: string }[];
      };
    };
    const activityIcon = manifest.contributes.viewsContainers.activitybar[0]?.icon;
    expect(activityIcon).toBe('media/easyssh-manager.svg');
    expect(existsSync(resolve(root, activityIcon ?? ''))).toBe(true);
    expect(
      manifest.contributes.commands.find(
        (command) => command.command === 'easysshManager.importSshConfig',
      )?.icon,
    ).toBe('$(cloud-download)');
  });

  it('declares independently configurable Connections title actions', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: {
        configuration: { properties: Record<string, { default?: unknown }> };
        menus: { 'view/title': { command: string; when?: string }[] };
      };
    };
    const names = [
      'showAddConnection',
      'showAddFolder',
      'showImport',
      'showRefresh',
      'showCollapseAll',
      'showSettings',
    ];
    for (const name of names) {
      const key = `easysshManager.connections.titleActions.${name}`;
      expect(manifest.contributes.configuration.properties[key]?.default).toBe(true);
      expect(
        manifest.contributes.menus['view/title'].some((item) =>
          item.when?.includes(`config.${key}`),
        ),
      ).toBe(true);
    }
    expect(
      manifest.contributes.menus['view/title'].some(
        (item) => item.command === 'easysshManager.openSettings',
      ),
    ).toBe(true);
  });

  it('uses only icon names present in the packaged Codicon set', () => {
    const root = process.cwd();
    const codicons = readFileSync(
      resolve(root, 'node_modules/@vscode/codicons/dist/codicon.css'),
      'utf8',
    );
    const sources = [
      'src/views/connections/ConnectionEditor.ts',
      'src/views/connections/ImportPreview.ts',
      'src/views/sftp/SftpPanel.ts',
    ]
      .map((file) => readFileSync(resolve(root, file), 'utf8'))
      .join('\n');
    const iconNames = new Set(
      [...sources.matchAll(/\bcodicon-([a-z][\w-]+)/g)]
        .map((match) => match[1])
        .filter((name): name is string => name !== undefined && !name.startsWith('modifier-')),
    );
    for (const name of iconNames) expect(codicons).toContain(`.codicon-${name}:before`);
  });
});
