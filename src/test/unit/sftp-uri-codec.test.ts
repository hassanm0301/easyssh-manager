import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';

import {
  DefaultSftpUriCodec,
  normalizeRemotePath,
  SFTP_URI_SCHEME,
  type SftpUriComponents,
  type SftpUriFactory,
} from '../../sftp/SftpUriCodec';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

class TestUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  constructor(components: SftpUriComponents) {
    this.scheme = components.scheme;
    this.authority = components.authority ?? '';
    this.path = components.path ?? '';
    this.query = components.query ?? '';
    this.fragment = components.fragment ?? '';
  }

  toString(): string {
    const encodedPath = this.path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.scheme}://${this.authority}${encodedPath}`;
  }
}

const uriFactory: SftpUriFactory = {
  from: (components) => new TestUri(components) as unknown as vscode.Uri,
};

const codec = new DefaultSftpUriCodec(uriFactory, (id) => id === CONNECTION_ID);

function uri(overrides: Partial<TestUri> = {}): vscode.Uri {
  return {
    scheme: SFTP_URI_SCHEME,
    authority: CONNECTION_ID,
    path: '/',
    query: '',
    fragment: '',
    ...overrides,
  } as unknown as vscode.Uri;
}

describe('remote SFTP path normalization', () => {
  it.each([
    ['/', '/'],
    ['///', '/'],
    ['/nested//path/./file.txt', '/nested/path/file.txt'],
    ['/nested/child/../file.txt', '/nested/file.txt'],
    ['/.ssh/.config', '/.ssh/.config'],
    ['/space here/%/#/?/café/世界', '/space here/%/#/?/café/世界'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeRemotePath(input)).toBe(expected);
  });

  it.each(['relative', '', '..', '/../secret', '/a/../../secret'])('rejects %j', (input) => {
    expect(() => normalizeRemotePath(input)).toThrow();
  });

  it('rejects NUL and malformed UTF-16 instead of changing remote names', () => {
    expect(() => normalizeRemotePath('/bad\0name')).toThrow(/NUL/);
    expect(() => normalizeRemotePath('/bad\ud800name')).toThrow(/Unicode/);
    expect(() => normalizeRemotePath('/bad\udc00name')).toThrow(/Unicode/);
  });
});

describe('remote SFTP URI codec', () => {
  it.each([
    '/',
    '/nested/file.txt',
    '/space here/100%/#hash/?question',
    '/Unicode/日本語/🧪.txt',
    '/.leading/nested/.file',
    '/[2001:db8::1]/name',
  ])('round trips %j without double encoding', (remotePath) => {
    const created = codec.create(CONNECTION_ID, remotePath);
    expect(codec.parse(created)).toEqual({ connectionId: CONNECTION_ID, remotePath });
    expect(created.path).toBe(remotePath);
  });

  it('uses URI component construction so reserved filename characters are encoded once', () => {
    const created = codec.create(CONNECTION_ID, '/space here/100%/#hash/?question');
    expect(created.toString()).toBe(
      'remote-sftp://11111111-1111-4111-8111-111111111111/space%20here/100%25/%23hash/%3Fquestion',
    );
    expect(created.path).toBe('/space here/100%/#hash/?question');
  });

  it.each([
    ['wrong scheme', { scheme: 'file' }],
    ['userinfo', { authority: `user@${CONNECTION_ID}` }],
    ['query', { query: 'download=true' }],
    ['fragment', { fragment: 'line-1' }],
    ['missing authority', { authority: '' }],
    ['uppercase/noncanonical UUID', { authority: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }],
    ['wrong UUID version', { authority: '11111111-1111-3111-8111-111111111111' }],
    ['relative path', { path: 'relative' }],
    ['NUL path', { path: '/bad\0name' }],
    ['root escape', { path: '/../secret' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => codec.parse(uri(overrides))).toThrow();
  });

  it('rejects unknown connection ids on creation and parsing', () => {
    const unknown = '22222222-2222-4222-8222-222222222222';
    expect(() => codec.create(unknown, '/')).toThrow(/does not exist/);
    expect(() => codec.parse(uri({ authority: unknown }))).toThrow(/does not exist/);
  });

  it('normalizes dot segments in both directions', () => {
    const created = codec.create(CONNECTION_ID, '//a/./b/../c');
    expect(created.path).toBe('/a/c');
    expect(codec.parse(uri({ path: '//a/./b/../c' })).remotePath).toBe('/a/c');
  });

  it('fuzzes valid Unicode paths for normalization idempotence and URI round trips', () => {
    const random = xorshift32(0x5f3759df);
    const alphabet = [
      'a',
      'Z',
      '0',
      ' ',
      '%',
      '#',
      '?',
      '.',
      '-',
      '_',
      'é',
      '界',
      '🧪',
      '[',
      ']',
      ':',
    ];

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const segments = Array.from({ length: 1 + integer(random, 8) }, () => {
        let segment = '';
        for (let index = 0; index < 1 + integer(random, 12); index += 1) {
          segment += alphabet[integer(random, alphabet.length)];
        }
        return segment === '.' || segment === '..' ? `${segment}x` : segment;
      });
      const input = `/${segments.join(iteration % 2 === 0 ? '/' : '//')}`;
      const normalized = normalizeRemotePath(input);
      expect(normalizeRemotePath(normalized)).toBe(normalized);
      expect(codec.parse(codec.create(CONNECTION_ID, input))).toEqual({
        connectionId: CONNECTION_ID,
        remotePath: normalized,
      });
    }
  });
});

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function integer(random: () => number, upperBound: number): number {
  return random() % upperBound;
}
