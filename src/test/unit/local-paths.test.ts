import { describe, expect, it } from 'vitest';

import { expandLocalHome, resolveLocalPath } from '../../common/localPaths';

describe('local path helpers', () => {
  it('expands POSIX home paths and resolves relative paths', () => {
    expect(expandLocalHome('~', { platform: 'posix', homeDirectory: '/home/test' })).toBe(
      '/home/test',
    );
    expect(
      expandLocalHome('~/work/é file', { platform: 'posix', homeDirectory: '/home/test' }),
    ).toBe('/home/test/work/é file');
    expect(resolveLocalPath('folder/../file', { platform: 'posix', cwd: '/workspace' })).toBe(
      '/workspace/file',
    );
    expect(resolveLocalPath('/tmp/../var/data', { platform: 'posix' })).toBe('/var/data');
  });

  it('expands both Windows home separators and keeps Unicode and spaces', () => {
    const options = { platform: 'win32' as const, homeDirectory: 'C:\\Users\\Test' };
    expect(expandLocalHome('~\\Documents\\résumé.txt', options)).toBe(
      'C:\\Users\\Test\\Documents\\résumé.txt',
    );
    expect(expandLocalHome('~/Documents/hello world', options)).toBe(
      'C:\\Users\\Test\\Documents\\hello world',
    );
    expect(resolveLocalPath('C:\\', options)).toBe('C:\\');
    expect(resolveLocalPath('D:/work/é file', options)).toBe('D:\\work\\é file');
  });

  it('supports UNC paths and resolves ordinary relative Windows input against cwd', () => {
    const options = { platform: 'win32' as const, cwd: 'C:\\workspace' };
    expect(resolveLocalPath('\\\\server\\share\\folder\\..\\file', options)).toBe(
      '\\\\server\\share\\file',
    );
    expect(resolveLocalPath('subfolder\\résumé.txt', options)).toBe(
      'C:\\workspace\\subfolder\\résumé.txt',
    );
  });

  it('rejects ambiguous Windows drive-relative and current-drive-rooted inputs', () => {
    expect(() => resolveLocalPath('C:folder', { platform: 'win32', cwd: 'C:\\work' })).toThrow(
      /Drive-relative/,
    );
    expect(() => resolveLocalPath('\\folder', { platform: 'win32', cwd: 'C:\\work' })).toThrow(
      /Root-relative/,
    );
    expect(() => resolveLocalPath('/folder', { platform: 'win32', cwd: 'C:\\work' })).toThrow(
      /Root-relative/,
    );
  });
});
