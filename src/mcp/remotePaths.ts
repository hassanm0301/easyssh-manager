import { posix } from 'node:path';

/** Normalize untrusted remote POSIX paths, rejecting traversal rather than clamping it. */
export function normalizeAbsoluteRemotePath(input: string): string {
  if (input.length === 0 || input.includes('\0') || !input.startsWith('/'))
    throw new Error('A valid absolute POSIX path is required.');
  const segments = input.split('/');
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (result.length === 0) throw new Error('Path traversal is not allowed.');
      result.pop();
      continue;
    }
    result.push(segment);
  }
  return `/${result.join('/')}`;
}

export function normalizeAllowedRoot(input: string): string {
  if (input.includes('\0') || !input.startsWith('/'))
    throw new Error('Allowed roots must be absolute POSIX paths.');
  return normalizeAbsoluteRemotePath(input);
}

export function isPathWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeAbsoluteRemotePath(path);
  const normalizedRoot = normalizeAllowedRoot(root);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot.replace(/\/$/, '')}/`)
  );
}

export function remotePathSegments(path: string): string[] {
  return normalizeAbsoluteRemotePath(path).split('/').filter(Boolean);
}

export function remoteParent(path: string): string {
  return posix.dirname(normalizeAbsoluteRemotePath(path));
}
