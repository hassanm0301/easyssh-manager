import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import SSHConfig from 'ssh-config';

export interface ImportIssue {
  code: string;
  message: string;
}
export interface SshImportCandidate {
  candidateId: string;
  sourcePath: string;
  hostPattern: string;
  name: string;
  host?: string;
  port: number;
  username?: string;
  identityFiles: string[];
  selectedIdentityFile?: string;
  selectedAuthentication?: 'password' | 'privateKey' | 'agent';
  blockingIssues: ImportIssue[];
  warnings: ImportIssue[];
}

export interface ImportFileSystem {
  readFile(file: string): Promise<Uint8Array>;
  realpath(file: string): Promise<string>;
  readdir(directory: string): Promise<string[]>;
}

const defaults: ImportFileSystem = {
  readFile: (file) => fs.readFile(file),
  realpath: (file) => fs.realpath(file),
  readdir: (directory) => fs.readdir(directory),
};
const MAX_DEPTH = 16,
  MAX_FILES = 256,
  MAX_BYTES = 8 * 1024 * 1024;
const ISSUE_DIRECTIVE = 'EasySSHManagerImportIssue';

/** Read-only, bounded OpenSSH config discovery and preview parsing. */
export class OpenSshImporter {
  constructor(
    private readonly files: ImportFileSystem = defaults,
    private readonly homeDirectory: () => string = os.homedir,
    private readonly username: () => string = () => os.userInfo().username,
  ) {}

  defaultConfigPath(): string {
    return path.join(this.homeDirectory(), '.ssh', 'config');
  }

  async discover(sourcePath = this.defaultConfigPath()): Promise<SshImportCandidate[]> {
    const resolvedSource = path.resolve(expandHome(sourcePath, this.homeDirectory()));
    const loaded = await this.loadIncludes(resolvedSource, new Set(), 0, { files: 0, bytes: 0 });
    // Parse through the reviewed/pinned parser as a syntax guard. Computation below is deliberately
    // local so Match exec is never passed to any execution-capable implementation.
    let parsed: ReturnType<typeof SSHConfig.parse>;
    try {
      parsed = SSHConfig.parse(loaded.text);
    } catch (error) {
      throw new Error(
        `Unable to parse OpenSSH config: ${error instanceof Error ? error.message : 'invalid syntax'}`,
      );
    }
    const candidates = this.candidates(loaded.text, resolvedSource, loaded.issues, parsed);
    if (candidates.length === 0) {
      const issue = firstEmbeddedIssue(loaded.text);
      if (issue) throw new Error(issue.message);
    }
    return candidates;
  }

  private async loadIncludes(
    file: string,
    visited: Set<string>,
    depth: number,
    tally: { files: number; bytes: number },
  ): Promise<{ text: string; issues: ImportIssue[] }> {
    const issues: ImportIssue[] = [];
    if (depth > MAX_DEPTH)
      return {
        text: issueLine({
          code: 'INCLUDE_DEPTH',
          message: 'Include depth exceeds the safe limit of 16.',
        }),
        issues: [],
      };
    let canonical: string;
    try {
      canonical = await this.files.realpath(file);
    } catch {
      return {
        text: issueLine({
          code: 'INCLUDE_MISSING',
          message: `Included file could not be resolved: ${file}`,
        }),
        issues: [],
      };
    }
    if (visited.has(canonical))
      return {
        text: issueLine({ code: 'INCLUDE_LOOP', message: `Ignored recursive include: ${file}` }),
        issues: [],
      };
    if (++tally.files > MAX_FILES)
      return {
        text: issueLine({
          code: 'INCLUDE_FILES',
          message: 'Include file count exceeds the safe limit of 256.',
        }),
        issues: [],
      };
    visited.add(canonical);
    let bytes: Uint8Array;
    try {
      bytes = await this.files.readFile(canonical);
    } catch {
      return {
        text: issueLine({ code: 'INCLUDE_READ', message: `Unable to read ${file}.` }),
        issues: [],
      };
    }
    tally.bytes += bytes.byteLength;
    if (tally.bytes > MAX_BYTES)
      return {
        text: issueLine({
          code: 'INCLUDE_SIZE',
          message: 'OpenSSH configuration exceeds the safe 8 MiB limit.',
        }),
        issues: [],
      };
    const decoded = decodeUtf8(bytes);
    if (!decoded.ok)
      return {
        text: issueLine({
          code: 'INVALID_UTF8',
          message: `Config file is not valid UTF-8: ${file}`,
        }),
        issues: [],
      };
    const output: string[] = [];
    for (const line of decoded.text.split(/\r?\n/)) {
      const match = /^\s*Include\s+(.+?)\s*(?:#.*)?$/i.exec(line);
      if (!match) {
        output.push(line);
        continue;
      }
      const patterns = splitArguments(match[1] ?? '');
      for (const pattern of patterns) {
        const paths = await this.expandInclude(
          path.dirname(canonical),
          expandHome(pattern, this.homeDirectory()),
        );
        if (paths.length === 0)
          output.push(
            issueLine({
              code: 'INCLUDE_MISSING',
              message: `Included file could not be resolved: ${pattern}`,
            }),
          );
        for (const child of paths) {
          const nested = await this.loadIncludes(child, visited, depth + 1, tally);
          output.push(nested.text);
          issues.push(...nested.issues);
        }
      }
    }
    return { text: output.join('\n'), issues };
  }

  private async expandInclude(base: string, pattern: string): Promise<string[]> {
    const candidate = path.isAbsolute(pattern) ? pattern : path.resolve(base, pattern);
    if (!/[?*[]/.test(candidate)) return [candidate];
    const root = path.parse(candidate).root;
    const segments = candidate.slice(root.length).split(path.sep).filter(Boolean);
    let paths = [root];
    for (const segment of segments) {
      const next: string[] = [];
      for (const parent of paths) {
        if (!/[?*[]/.test(segment)) {
          next.push(path.join(parent, segment));
          continue;
        }
        try {
          const names = (await this.files.readdir(parent)).filter((name) => glob(segment, name));
          next.push(...names.sort().map((name) => path.join(parent, name)));
        } catch {
          // An unreadable glob branch has no matches; its include is marked unresolved by the caller.
        }
      }
      paths = next;
      if (paths.length === 0) break;
    }
    return paths.sort();
  }

  private candidates(
    text: string,
    sourcePath: string,
    includeIssues: ImportIssue[],
    parsed: ReturnType<typeof SSHConfig.parse>,
  ): SshImportCandidate[] {
    const sections = parseSections(text);
    const aliases = [
      ...new Set(
        sections.flatMap((section) =>
          section.kind === 'host'
            ? section.patterns.filter(
                (pattern) => !pattern.startsWith('!') && !/[?*[]/.test(pattern),
              )
            : [],
        ),
      ),
    ];
    return aliases.map((alias) => {
      // ssh-config 4.x never evaluates Match/exec. Calling compute still exercises its reviewed
      // first-value implementation; the safe subset below adds stricter Match and token handling.
      parsed.compute(alias, { matchExec: false });
      return this.compute(alias, sections, sourcePath, includeIssues);
    });
  }

  private compute(
    alias: string,
    sections: Section[],
    sourcePath: string,
    includeIssues: ImportIssue[],
  ): SshImportCandidate {
    const values = new Map<string, string[]>();
    const blocking: ImportIssue[] = [];
    const warnings: ImportIssue[] = [...includeIssues];
    for (const section of sections) {
      if (section.kind === 'match') {
        if (
          section.directives.some(
            (directive) =>
              /^exec\b/i.test(directive.key) || /\bexec\b/i.test(section.patterns.join(' ')),
          )
        )
          blocking.push({
            code: 'MATCH_EXEC',
            message: 'Match exec is not executed and cannot be imported safely.',
          });
        else
          blocking.push({
            code: 'MATCH',
            message: 'Conditional Match directives cannot be imported safely.',
          });
        continue;
      }
      if (section.kind === 'host' && !matchesHost(section.patterns, alias)) continue;
      for (const directive of section.directives) {
        const key = directive.key.toLowerCase();
        if (key === ISSUE_DIRECTIVE.toLowerCase()) {
          const issue = decodeIssue(directive.value);
          blocking.push(
            issue ?? {
              code: 'INCLUDE',
              message: 'An included config could not be resolved safely.',
            },
          );
          continue;
        }
        if (
          [
            'proxyjump',
            'proxycommand',
            'canonicalizehostname',
            'canonicaldomains',
            'hostkeyalias',
            'bindaddress',
            'bindinterface',
            'localcommand',
            'permitlocalcommand',
          ].includes(key)
        )
          blocking.push({
            code: key.toUpperCase(),
            message: `${directive.key} changes connectivity and is not supported.`,
          });
        if (key === 'include') continue;
        const existing = values.get(key) ?? [];
        if (key === 'identityfile') existing.push(directive.value);
        else if (existing.length === 0) existing.push(directive.value);
        values.set(key, existing);
      }
    }
    const tokenContext = {
      alias,
      host: values.get('hostname')?.[0] ?? alias,
      user: values.get('user')?.[0] ?? this.username(),
      localUser: this.username(),
      home: this.homeDirectory(),
    };
    const host = expandTokens(tokenContext.host, tokenContext, blocking);
    const user = expandTokens(tokenContext.user, { ...tokenContext, host }, blocking);
    if (!validHost(host))
      blocking.push({
        code: 'HOST',
        message: `Resolved host is not a valid DNS name or IP address: ${host}`,
      });
    const rawPort = values.get('port')?.[0] ?? '22';
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      blocking.push({ code: 'PORT', message: `Invalid resolved port: ${rawPort}` });
    const identityFiles = (values.get('identityfile') ?? [])
      .filter((value) => value.toLowerCase() !== 'none')
      .map((value) => expandTokens(value, { ...tokenContext, host, user }, blocking));
    const preferred = values.get('preferredauthentications')?.[0]?.toLowerCase();
    const identitiesOnly = values.get('identitiesonly')?.[0]?.toLowerCase();
    let selectedAuthentication: SshImportCandidate['selectedAuthentication'] = identityFiles.length
      ? 'privateKey'
      : 'agent';
    if (preferred) {
      const ordered = preferred.split(',').map((item) => item.trim());
      const selected = ordered.find((item) =>
        ['publickey', 'password', 'keyboard-interactive'].includes(item),
      );
      if (selected === 'password' || selected === 'keyboard-interactive')
        selectedAuthentication = 'password';
      if (selected === 'publickey')
        selectedAuthentication = identityFiles.length ? 'privateKey' : 'agent';
      if (!selected)
        warnings.push({
          code: 'PREFERRED_AUTH',
          message: 'PreferredAuthentications does not contain a directly supported method.',
        });
    }
    if (identitiesOnly === 'yes' && identityFiles.length === 0)
      warnings.push({
        code: 'IDENTITIES_ONLY',
        message: 'IdentitiesOnly is enabled but no identity file was resolved.',
      });
    if (identityFiles.length > 1)
      warnings.push({
        code: 'MULTIPLE_IDENTITIES',
        message: 'Select exactly one identity file before importing.',
      });
    return {
      candidateId: `${sourcePath}:${alias}`,
      sourcePath,
      hostPattern: alias,
      name: alias,
      host,
      port: Number.isInteger(port) ? port : 22,
      username: user,
      identityFiles,
      ...(identityFiles[0] === undefined ? {} : { selectedIdentityFile: identityFiles[0] }),
      selectedAuthentication,
      blockingIssues: uniqueIssues(blocking),
      warnings: uniqueIssues(warnings),
    };
  }
}

type Section = {
  kind: 'global' | 'host' | 'match';
  patterns: string[];
  directives: { key: string; value: string }[];
};
function parseSections(text: string): Section[] {
  const initial: Section = { kind: 'global', patterns: [], directives: [] };
  const sections: Section[] = [initial];
  let current: Section = initial;
  for (const original of text.split(/\r?\n/)) {
    const line = original.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const match = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? '',
      value = (match[2] ?? '').trim();
    if (/^host$/i.test(key)) {
      current = { kind: 'host', patterns: splitArguments(value), directives: [] };
      sections.push(current);
    } else if (/^match$/i.test(key)) {
      current = { kind: 'match', patterns: splitArguments(value), directives: [] };
      sections.push(current);
    } else current.directives.push({ key, value: unquote(value) });
  }
  return sections;
}
function matchesHost(patterns: string[], host: string): boolean {
  const positives = patterns.filter((pattern) => !pattern.startsWith('!'));
  return (
    !patterns.some((pattern) => pattern.startsWith('!') && glob(pattern.slice(1), host)) &&
    positives.some((pattern) => glob(pattern, host))
  );
}
function glob(pattern: string, value: string): boolean {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else if (character === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) source += '\\[';
      else {
        let contents = pattern.slice(index + 1, end);
        if (contents.startsWith('!')) contents = `^${contents.slice(1)}`;
        source += `[${contents.replace(/\\/g, '\\\\')}]`;
        index = end;
      }
    } else source += character.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`${source}$`, 'i').test(value);
  } catch {
    return false;
  }
}
function splitArguments(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(unquote) ?? [];
}
function unquote(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
}
function expandHome(value: string, home: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
}
function expandTokens(
  value: string,
  context: { alias: string; host: string; user: string; localUser: string; home: string },
  issues: ImportIssue[],
): string {
  return value
    .replace(
      /%([%duhrn])/g,
      (token, code: string) =>
        ({
          '%': '%',
          d: context.home,
          u: context.localUser,
          h: context.host,
          r: context.user,
          n: context.alias,
        })[code] ?? token,
    )
    .replace(/%./g, (token) => {
      issues.push({ code: 'UNSUPPORTED_TOKEN', message: `Unsupported OpenSSH token ${token}.` });
      return token;
    })
    .replace(/^~(?=\/|$)/, context.home);
}
function decodeUtf8(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return { ok: false };
  }
}
function validHost(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('@') || /\s|:\/\//.test(value)) return false;
  const literal = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(literal) !== 0) return true;
  const dns = value.endsWith('.') ? value.slice(0, -1) : value;
  return (
    dns.length <= 253 && dns.split('.').every((label) => /^(?!-)[a-z\d-]{1,63}(?<!-)$/i.test(label))
  );
}
function uniqueIssues(issues: ImportIssue[]): ImportIssue[] {
  return issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) => candidate.code === issue.code && candidate.message === issue.message,
      ) === index,
  );
}
function issueLine(issue: ImportIssue): string {
  return `${ISSUE_DIRECTIVE} ${Buffer.from(JSON.stringify(issue), 'utf8').toString('base64url')}`;
}
function decodeIssue(value: string): ImportIssue | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).code === 'string' &&
      typeof (parsed as Record<string, unknown>).message === 'string'
    ) {
      return {
        code: (parsed as Record<string, string>).code!,
        message: (parsed as Record<string, string>).message!,
      };
    }
  } catch {
    // Invalid internal markers are treated as a generic blocking issue by the caller.
  }
  return undefined;
}
function firstEmbeddedIssue(text: string): ImportIssue | undefined {
  for (const section of parseSections(text)) {
    for (const directive of section.directives) {
      if (directive.key.toLowerCase() === ISSUE_DIRECTIVE.toLowerCase())
        return decodeIssue(directive.value);
    }
  }
  return undefined;
}
