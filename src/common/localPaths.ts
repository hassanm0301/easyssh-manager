import path from 'node:path';
import { homedir } from 'node:os';

export interface LocalPathOptions {
  /** Defaults to the current process platform. `posix` and `win32` are useful in tests. */
  platform?: NodeJS.Platform | 'posix' | 'win32';
  /** Home directory used to expand `~/` (and `~\\` on Windows). */
  homeDirectory?: string;
}

export interface ResolveLocalPathOptions extends LocalPathOptions {
  /** Base directory for relative input. Defaults to `process.cwd()`. */
  cwd?: string;
}

function pathApi(platform: LocalPathOptions['platform']): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isWindows(platform: LocalPathOptions['platform']): boolean {
  return platform === 'win32';
}

/** Expand a leading home marker using the selected platform's local path rules. */
export function expandLocalHome(input: string, options: LocalPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const windows = isWindows(platform);
  const homePrefix = windows ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/;
  if (!homePrefix.test(input)) return input;

  const homeDirectory = options.homeDirectory ?? homedir();
  if (!homeDirectory || !api.isAbsolute(homeDirectory)) {
    throw new Error('A valid absolute home directory is required to expand this path.');
  }

  if (windows) {
    const rest = input.slice(1).replace(/^[\\/]/, '');
    return rest ? api.join(homeDirectory, rest) : homeDirectory;
  }
  return input === '~' ? homeDirectory : api.join(homeDirectory, input.slice(2));
}

/** Resolve a local filesystem input to a normalized absolute path. */
export function resolveLocalPath(input: string, options: ResolveLocalPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const windows = isWindows(platform);
  const expanded = expandLocalHome(input, options);

  if (windows) {
    if (/^[a-zA-Z]:(?![\\/])/.test(expanded)) {
      throw new Error(`Drive-relative paths are ambiguous: ${input}`);
    }
    // A single leading separator is rooted on the process's current drive and
    // therefore cannot be resolved consistently from an arbitrary workspace.
    if (/^[\\/](?![\\/])/.test(expanded)) {
      throw new Error(`Root-relative paths are ambiguous: ${input}`);
    }
  }

  if (api.isAbsolute(expanded)) return api.normalize(expanded);

  const cwd = options.cwd ?? process.cwd();
  if (!api.isAbsolute(cwd)) {
    throw new Error('The current working directory must be an absolute local path.');
  }
  return api.resolve(cwd, expanded);
}
