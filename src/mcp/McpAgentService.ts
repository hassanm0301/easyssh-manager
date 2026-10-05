import { createHmac, randomBytes } from 'node:crypto';
import { posix } from 'node:path';

import { EasySshError } from '../common/errors';
import type { PersistedStateV1, RemoteConnection } from '../connections/types';
import type { RemoteStat, SftpConnectionPool, SftpClient } from '../sftp/ports';
import type { SshSessionManager } from '../ssh/ports';
import { isPathWithinRoot, normalizeAbsoluteRemotePath } from './remotePaths';
import { mcpToolSchemas, type McpToolName } from './toolSchemas';
import { McpAuditLog } from './McpAuditLog';

interface StateReader {
  load(): Promise<Readonly<PersistedStateV1>>;
}
interface PromptHost {
  showWarningMessage(
    message: string,
    options: { modal: true },
    ...items: string[]
  ): PromiseLike<string | undefined>;
}
interface MutationCache {
  invalidatePath(connectionId: string, path: string): void;
  invalidateParent(connectionId: string, path: string): void;
}

/** Extension-host authority for MCP calls. It resolves state and policy on every request. */
export class McpAgentService {
  private readonly versionKey = randomBytes(32);
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly promptTails = new Map<string, Promise<void>>();

  revokeConnection(connectionId: string): void {
    for (const controller of this.active.get(connectionId) ?? []) controller.abort();
  }

  revokeAll(): void {
    for (const controllers of this.active.values())
      for (const controller of controllers) controller.abort();
  }

  constructor(
    private readonly state: StateReader,
    private readonly ssh: SshSessionManager,
    private readonly sftp: SftpConnectionPool,
    private readonly window: PromptHost,
    private readonly audit?: McpAuditLog,
    private readonly mutationCache?: MutationCache,
  ) {}

  async dispatch(
    method: string,
    raw: Record<string, unknown>,
    signal: AbortSignal,
    requestId = '',
  ): Promise<unknown> {
    const started = Date.now();
    const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId : undefined;
    let connection: RemoteConnection | undefined;
    let outcome: 'success' | 'denied' | 'error' = 'error';
    let errorCode: string | undefined;
    try {
      if (!Object.hasOwn(mcpToolSchemas, method))
        throw new EasySshError('VALIDATION', 'Unknown MCP method.');
      raw = mcpToolSchemas[method as McpToolName].parse(raw) as Record<string, unknown>;
      if (connectionId)
        connection = (await this.state.load()).connections.find(
          (item) => item.id === raw.connectionId,
        );
      const result = await this.dispatchRequest(method, raw, signal);
      outcome = 'success';
      return result;
    } catch (error) {
      errorCode =
        error instanceof EasySshError
          ? error.code
          : error instanceof Error && error.name === 'ZodError'
            ? 'INVALID_INPUT'
            : 'UNAVAILABLE';
      if (
        errorCode === 'ACCESS_DENIED' ||
        errorCode === 'POLICY_DISABLED' ||
        errorCode.startsWith('CONFIRMATION')
      )
        outcome = 'denied';
      throw error;
    } finally {
      if (this.audit) {
        let target: string | undefined;
        const rawTarget =
          typeof raw.path === 'string'
            ? raw.path
            : typeof raw.source === 'string'
              ? raw.source
              : undefined;
        if (rawTarget) {
          try {
            target = normalizeAbsoluteRemotePath(rawTarget);
          } catch {
            /* invalid input has no authorized target */
          }
        }
        const command = typeof raw.command === 'string' ? raw.command : undefined;
        const policy = connection?.agentAccess;
        await this.audit.append({
          timestamp: Date.now(),
          requestId: requestId || 'unknown',
          ...(connectionId ? { connectionId } : {}),
          ...(connection ? { connectionNameSnapshot: connection.name } : {}),
          tool: method.slice(0, 64),
          ...(target && target.startsWith('/') ? { operationTarget: target } : {}),
          ...(command ? { commandFingerprint: this.audit.fingerprint(command) } : {}),
          confirmation: policy?.confirmationMode ?? 'not-applicable',
          outcome,
          ...(errorCode ? { errorCode } : {}),
          durationMs: Date.now() - started,
        });
      }
    }
  }

  private async dispatchRequest(
    method: string,
    raw: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
    if (!(method in mcpToolSchemas)) throw new EasySshError('VALIDATION', 'Unknown MCP method.');
    const name = method as McpToolName;
    const input = mcpToolSchemas[name].parse(raw) as Record<string, unknown>;
    if (name === 'remote_list_connections') return this.listConnections();
    const connectionId = input.connectionId as string;
    await this.authorizedConnection(connectionId, name);
    const controller = new AbortController();
    const controllers = this.active.get(connectionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.active.set(connectionId, controllers);
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      const current = await this.authorizedConnection(connectionId, name);
      if (controller.signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      switch (name) {
        case 'ssh_exec':
          return await this.exec(current, input, controller.signal);
        case 'sftp_list':
          return await this.list(current, input, controller.signal);
        case 'sftp_stat':
          return await this.stat(current, input, controller.signal);
        case 'sftp_read':
          return await this.read(current, input, controller.signal);
        case 'sftp_write':
        case 'sftp_mkdir':
        case 'sftp_rename':
        case 'sftp_delete':
          return await this.mutate(current, name, input, controller.signal);
        default:
          throw new EasySshError('VALIDATION', 'Unknown MCP method.');
      }
    } finally {
      signal.removeEventListener('abort', abort);
      controllers.delete(controller);
      if (controllers.size === 0) this.active.delete(connectionId);
    }
  }

  private async listConnections(): Promise<unknown> {
    const state = await this.state.load();
    return state.connections
      .filter((item) => item.agentAccess?.enabled === true)
      .map((item) => ({
        id: item.id,
        name: item.name,
        host: item.host,
        port: item.port,
        username: item.username,
        read: item.agentAccess.allowReadFiles,
        write: item.agentAccess.allowWriteFiles,
        exec: item.agentAccess.allowExec,
        allowedRoots: [...item.agentAccess.allowedRoots],
      }));
  }

  private async authorizedConnection(id: string, tool: McpToolName): Promise<RemoteConnection> {
    const state = await this.state.load();
    const connection = state.connections.find((item) => item.id === id);
    if (!connection)
      throw new EasySshError('ACCESS_DENIED', 'The requested operation is not authorized.');
    const policy = connection.agentAccess;
    if (!policy?.enabled)
      throw new EasySshError('POLICY_DISABLED', 'Agent access is disabled for this connection.');
    if (tool === 'ssh_exec' && !policy.allowExec)
      throw new EasySshError('ACCESS_DENIED', 'The requested operation is not authorized.');
    if (['sftp_list', 'sftp_stat', 'sftp_read'].includes(tool) && !policy.allowReadFiles)
      throw new EasySshError('ACCESS_DENIED', 'The requested operation is not authorized.');
    if (
      ['sftp_write', 'sftp_mkdir', 'sftp_rename', 'sftp_delete'].includes(tool) &&
      !policy.allowWriteFiles
    )
      throw new EasySshError('ACCESS_DENIED', 'The requested operation is not authorized.');
    return connection;
  }

  private async withClient<T>(
    connection: RemoteConnection,
    signal: AbortSignal,
    action: (client: import('../sftp/ports').SftpClient) => Promise<T>,
  ): Promise<T> {
    const token = cancellationToken(signal);
    const lease = await this.sftp.acquire(connection.id, token, 'interactive');
    const cancelOperation = (): void => {
      void lease.client.close().catch(() => undefined);
    };
    signal.addEventListener('abort', cancelOperation, { once: true });
    try {
      return await action(lease.client);
    } finally {
      signal.removeEventListener('abort', cancelOperation);
      await lease[Symbol.asyncDispose]();
    }
  }

  private async canonicalRoots(
    client: import('../sftp/ports').SftpClient,
    connection: RemoteConnection,
  ): Promise<string[]> {
    const roots = connection.agentAccess.allowedRoots;
    if (!Array.isArray(roots) || roots.length === 0)
      throw new EasySshError('PATH_NOT_ALLOWED', 'No file roots are authorized.');
    const canonical: string[] = [];
    for (const root of roots) {
      const normalized = normalizeAbsoluteRemotePath(root);
      const resolved = normalizeAbsoluteRemotePath(await client.realpath(normalized));
      canonical.push(resolved);
    }
    return canonical;
  }

  private async assertPath(
    client: import('../sftp/ports').SftpClient,
    connection: RemoteConnection,
    path: string,
  ): Promise<string> {
    const normalized = normalizeAbsoluteRemotePath(path);
    const roots = await this.canonicalRoots(client, connection);
    let resolved: string;
    let exists = true;
    try {
      await client.lstat(normalized);
    } catch (error) {
      if (!(error instanceof EasySshError) || error.code !== 'NOT_FOUND') throw error;
      exists = false;
    }
    if (exists) {
      // Existing objects must resolve successfully. In particular, never treat a
      // dangling link or a permission/transport error as a missing destination.
      resolved = normalizeAbsoluteRemotePath(await client.realpath(normalized));
    } else {
      // Only NOT_FOUND permits destination ancestor walking. Every other failure
      // is an authorization/canonicalization failure and must fail closed.
      let parent = posix.dirname(normalized);
      const missing: string[] = [posix.basename(normalized)];
      while (parent !== '/') {
        try {
          await client.lstat(parent);
          break;
        } catch (error) {
          if (!(error instanceof EasySshError) || error.code !== 'NOT_FOUND') throw error;
          missing.unshift(posix.basename(parent));
          parent = posix.dirname(parent);
        }
      }
      const ancestor = normalizeAbsoluteRemotePath(await client.realpath(parent));
      resolved = posix.join(ancestor, ...missing);
    }
    if (!roots.some((root) => isPathWithinRoot(resolved, root)))
      throw new EasySshError('PATH_NOT_ALLOWED', 'The path is outside the allowed roots.');
    return resolved;
  }

  private async readDirectoryBounded(
    client: import('../sftp/ports').SftpClient,
    path: string,
    limit: number,
  ): Promise<import('../sftp/ports').RemoteDirectoryEntry[]> {
    const result = client.readDirectoryBounded
      ? await client.readDirectoryBounded(path, limit)
      : await client.readDirectory(path).then((entries) => ({
          entries: entries.slice(0, limit),
          truncated: entries.length > limit,
        }));
    if (result.truncated)
      throw new EasySshError('OUTPUT_LIMIT', 'Directory listing exceeds its limit.');
    return result.entries;
  }

  private invalidateMutation(connectionId: string, path: string): void {
    this.mutationCache?.invalidatePath(connectionId, path);
    this.mutationCache?.invalidateParent(connectionId, path);
  }

  private async list(
    c: RemoteConnection,
    i: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.withClient(c, signal, async (client) => {
      const path = await this.assertPath(client, c, i.path as string);
      const rows = await this.readDirectoryBounded(client, path, 10_000);
      return rows.map(({ name, stat }) => ({
        name: name.slice(0, 255),
        kind: stat.kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }));
    });
  }
  private async stat(
    c: RemoteConnection,
    i: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.withClient(c, signal, async (client) => {
      const path = normalizeAbsoluteRemotePath(i.path as string);
      const canonical = await this.assertPath(client, c, path);
      const stat = await client.lstat(path);
      const versionStat = await client.stat(canonical);
      return {
        kind: stat.kind,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        contained: true,
        version: this.version(c.id, path, versionStat.mtimeMs, versionStat.size),
      };
    });
  }
  private async read(
    c: RemoteConnection,
    i: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.withClient(c, signal, async (client) => {
      const path = await this.assertPath(client, c, i.path as string);
      const stat = await client.stat(path);
      if (stat.kind !== 'file') throw new EasySshError('INVALID_INPUT', 'Only files can be read.');
      const offset = i.offset as number,
        length = Math.min(i.length as number, 4 * 1024 * 1024);
      const bytes = Buffer.from(await client.readFile(path, { offset, length }));
      if (bytes.length > 4 * 1024 * 1024)
        throw new EasySshError('OUTPUT_LIMIT', 'Read exceeds its limit.');
      let data: string;
      if (i.encoding === 'base64') data = bytes.toString('base64');
      else {
        try {
          data = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new EasySshError('INVALID_INPUT', 'Remote file content is not valid UTF-8.');
        }
      }
      return {
        data,
        encoding: i.encoding,
        offset,
        bytesRead: bytes.length,
        totalSize: stat.size,
        eof: offset + bytes.length >= stat.size,
        version: this.version(c.id, i.path as string, stat.mtimeMs, stat.size),
      };
    });
  }
  private async exec(
    c: RemoteConnection,
    i: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const command = i.command as string;
    const policy = c.agentAccess;
    const readOnlyCommand =
      /^(?:pwd|whoami|id|uname|uptime|date|ls|cat|head|tail|grep|find|stat|df|du|ps|free|env)(?:\s+[^;&|<>\n]+)?$/i.test(
        command.trim(),
      );
    const destructive =
      !readOnlyCommand ||
      /(^|[;&|\s])(rm|sudo|chmod|chown|reboot|shutdown|systemctl|service|apt|yum|dnf|npm\s+(?:install|uninstall)|DROP|DELETE|TRUNCATE)(\s|$)|>|\|\s*(?:sh|bash)/i.test(
        command,
      );
    if (
      policy.confirmationMode === 'always' ||
      (policy.confirmationMode === 'destructive' && destructive)
    ) {
      const accepted = await this.ask(
        c.id,
        `MCP client requests a non-interactive SSH command on “${c.name}”. Command content is hidden; size ${Buffer.byteLength(command, 'utf8')} bytes, timeout ${i.timeoutMs as number} ms, output limit 1 MiB per stream.`,
        signal,
        'Approve',
        () => this.authorizedConnection(c.id, 'ssh_exec'),
      );
      await this.authorizedConnection(c.id, 'ssh_exec');
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      if (accepted !== 'Approve')
        throw new EasySshError('CONFIRMATION_DENIED', 'The operation was denied.');
    }
    const cwd = i.cwd as string | undefined;
    const commandWithCwd = cwd ? `cd -- '${cwd.replace(/'/g, "'\\''")}' && ${command}` : command;
    const remoteCommand = cancellableShellCommand(commandWithCwd);
    const handle = await this.ssh.connect(c.id, {
      kind: 'test',
      scopeId: `mcp-${Date.now()}`,
    });
    try {
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      let abortedWhileOpening = false;
      const markAbortedWhileOpening = (): void => {
        abortedWhileOpening = true;
      };
      signal.addEventListener('abort', markAbortedWhileOpening, { once: true });
      let execHandle: Awaited<ReturnType<typeof handle.exec>>;
      try {
        execHandle = await handle.exec({ command: remoteCommand });
      } finally {
        signal.removeEventListener('abort', markAbortedWhileOpening);
      }
      const channel = execHandle.stream;
      return await new Promise((resolve, reject) => {
        const out: Buffer[] = [],
          err: Buffer[] = [];
        let outSize = 0,
          errSize = 0,
          exitCode: number | null = null,
          signalName: string | null = null,
          settled = false;
        const started = Date.now();
        let terminationError: Error | undefined;
        let terminationTimedOut = false;
        let terminationTimer: NodeJS.Timeout | undefined;
        let forcedCloseTimer: NodeJS.Timeout | undefined;
        const terminateRemoteCommand = (failure?: Error, timedOut = false): void => {
          terminationError = failure;
          terminationTimedOut = timedOut;
          try {
            channel.signal('TERM');
          } catch {
            done(failure, timedOut);
            channel.close();
            return;
          }
          terminationTimer = setTimeout(() => {
            try {
              channel.signal('KILL');
            } catch {
              // The server may have already closed the channel after TERM.
            }
            forcedCloseTimer = setTimeout(() => {
              done(failure, timedOut);
              channel.close();
            }, 100);
          }, 500);
        };
        const timer = setTimeout(() => {
          terminateRemoteCommand(undefined, true);
        }, i.timeoutMs as number);
        const done = (failure?: Error, timedOut = false): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (terminationTimer) clearTimeout(terminationTimer);
          if (forcedCloseTimer) clearTimeout(forcedCloseTimer);
          signal.removeEventListener('abort', onAbort);
          void handle[Symbol.asyncDispose]();
          if (failure) reject(failure);
          else if (outSize > 1024 * 1024 || errSize > 1024 * 1024) {
            const error = new EasySshError(
              'OUTPUT_LIMIT',
              'The operation exceeded its output limit.',
            ) as EasySshError & { observedOutput: { stdout: number; stderr: number } };
            error.observedOutput = { stdout: outSize, stderr: errSize };
            reject(error);
          } else
            resolve({
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(err).toString('utf8'),
              exitCode,
              signal: signalName ?? null,
              timedOut,
              durationMs: Date.now() - started,
            });
        };
        const onAbort = (): void => {
          terminateRemoteCommand(new EasySshError('CANCELLED', 'Request cancelled.'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // The abort may arrive while SSH is opening the exec channel. Install the
        // handler before checking the state so the remote process is signaled
        // before disposing the SSH connection.
        if (abortedWhileOpening || signal.aborted) onAbort();
        channel.on('data', (chunk: Buffer) => {
          outSize += chunk.length;
          if (outSize <= 1024 * 1024) out.push(Buffer.from(chunk));
          else {
            terminateRemoteCommand();
          }
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          errSize += chunk.length;
          if (errSize <= 1024 * 1024) err.push(Buffer.from(chunk));
          else {
            terminateRemoteCommand();
          }
        });
        channel.once('exit', (code: number | null, sig: string | null) => {
          exitCode = code;
          signalName = sig;
          if (terminationError || terminationTimedOut) done(terminationError, terminationTimedOut);
        });
        channel.once('close', () => done(terminationError, terminationTimedOut));
        channel.once('error', () =>
          done(new EasySshError('CONNECTION_FAILED', 'The SSH connection failed.')),
        );
      });
    } finally {
      await handle[Symbol.asyncDispose]();
    }
  }
  private async mutate(
    c: RemoteConnection,
    name: McpToolName,
    i: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const path = i.path as string | undefined;
    const opPath =
      name === 'sftp_rename' ? (i.source as string) : (path ?? (i.destination as string));
    const normalizedOperationPath = normalizeAbsoluteRemotePath(opPath);
    if ((name === 'sftp_delete' || name === 'sftp_rename') && normalizedOperationPath === '/')
      throw new EasySshError('INVALID_INPUT', 'The remote root cannot be renamed or deleted.');
    await this.withClient(c, signal, async (client) => {
      await this.assertPath(client, c, normalizedOperationPath);
      if (name === 'sftp_rename') await this.assertPath(client, c, i.destination as string);
    });
    if (c.agentAccess.confirmationMode !== 'never') {
      const recursive = name === 'sftp_delete' && i.recursive === true;
      const approveLabel = recursive ? 'Delete Recursively' : 'Approve';
      const accepted = await this.ask(
        c.id,
        recursive
          ? `Permanently delete “${opPath}” and all descendants on “${c.name}”? This cannot be undone.`
          : `MCP client requests ${name} on “${c.name}”: ${opPath}`,
        signal,
        approveLabel,
        () => this.authorizedConnection(c.id, name),
      );
      await this.authorizedConnection(c.id, name);
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      if (accepted !== approveLabel)
        throw new EasySshError('CONFIRMATION_DENIED', 'The operation was denied.');
    }
    return this.withClient(c, signal, async (client) => {
      const operationPath = normalizedOperationPath;
      const checked = await this.assertPath(client, c, operationPath);
      if (name === 'sftp_mkdir') {
        await client.mkdir(checked);
        this.invalidateMutation(c.id, checked);
        return { created: true };
      }
      if (name === 'sftp_delete') {
        this.invalidateMutation(c.id, checked);
        const initial = await client.lstat(operationPath);
        if (initial.kind !== 'directory') {
          await this.assertPath(client, c, operationPath);
          await client.unlink(operationPath);
          return { deleted: true, count: 1 };
        }
        if (i.recursive !== true)
          throw new EasySshError('INVALID_INPUT', 'Directory deletion requires recursive=true.');
        const nodes: { path: string; visited: boolean }[] = [
          { path: operationPath, visited: false },
        ];
        let count = 0;
        let bytes = 0;
        const started = Date.now();
        while (nodes.length) {
          if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
          if (Date.now() - started > 300_000 || count >= 100_000 || bytes > 20 * 1024 ** 3)
            throw new EasySshError('OUTPUT_LIMIT', 'Recursive deletion exceeded its safety bound.');
          const next = nodes.pop()!;
          const canonical = await this.assertPath(client, c, next.path);
          const stat = await client.lstat(next.path);
          if (stat.kind === 'directory' && !next.visited) {
            nodes.push({ path: next.path, visited: true });
            const entries = await this.readDirectoryBounded(client, canonical, 100_000 - count);
            for (const entry of entries)
              nodes.push({ path: posix.join(next.path, entry.name), visited: false });
          } else if (stat.kind === 'directory') {
            await client.rmdir(next.path);
            this.mutationCache?.invalidatePath(c.id, next.path);
          } else {
            if (bytes + stat.size > 20 * 1024 ** 3)
              throw new EasySshError('OUTPUT_LIMIT', 'Recursive deletion exceeded its byte limit.');
            bytes += stat.size;
            await client.unlink(next.path);
            this.mutationCache?.invalidatePath(c.id, next.path);
          }
          count += 1;
        }
        return { deleted: true, count };
      }
      if (name === 'sftp_rename') {
        const destination = normalizeAbsoluteRemotePath(i.destination as string);
        await this.assertPath(client, c, destination);
        await client.lstat(operationPath);
        try {
          await client.lstat(destination);
          throw new EasySshError('CONFLICT', 'The destination already exists.');
        } catch (error) {
          if (!(error instanceof EasySshError) || error.code !== 'NOT_FOUND') throw error;
        }
        await this.assertPath(client, c, operationPath);
        await this.assertPath(client, c, destination);
        this.invalidateMutation(c.id, operationPath);
        this.invalidateMutation(c.id, destination);
        await client.rename(operationPath, destination, false);
        return { renamed: true };
      }
      const data =
        i.encoding === 'base64'
          ? Buffer.from(i.data as string, 'base64')
          : Buffer.from(i.data as string, 'utf8');
      const sourcePath = i.path as string;
      const sourceStat = await lstatIfPresent(client, sourcePath);
      const existing = await lstatIfPresent(client, checked);
      if (sourceStat && !i.force) {
        const expected = i.expectedVersion;
        if (!existing)
          throw new EasySshError('STALE_VERSION', 'The remote target no longer exists.');
        const version = this.version(c.id, sourcePath, existing.mtimeMs, existing.size);
        if (typeof expected !== 'string' || expected !== version)
          throw new EasySshError('STALE_VERSION', 'The remote file version no longer matches.');
      }
      const temporary = posix.join(
        posix.dirname(checked),
        `.easyssh-${randomBytes(12).toString('hex')}.tmp`,
      );
      await client.writeFile(temporary, data, { create: true, overwrite: false });
      try {
        const canonical = await this.assertPath(client, c, sourcePath);
        if (canonical !== checked)
          throw new EasySshError('PATH_NOT_ALLOWED', 'The destination changed during the write.');
        const currentSource = await lstatIfPresent(client, sourcePath);
        const currentTarget = await lstatIfPresent(client, canonical);
        if (!i.force) {
          if (!sourceStat && currentSource)
            throw new EasySshError('CONFLICT', 'The remote file was created during the write.');
          if (sourceStat && !sameRemoteVersion(sourceStat, currentSource))
            throw new EasySshError('STALE_VERSION', 'The remote file changed during the write.');
          if (existing && !sameRemoteVersion(existing, currentTarget))
            throw new EasySshError('STALE_VERSION', 'The remote target changed during the write.');
          if (!existing && currentTarget)
            throw new EasySshError('CONFLICT', 'The remote file was created during the write.');
        }
        this.invalidateMutation(c.id, checked);
        await client.rename(temporary, checked, Boolean(existing));
      } catch (error) {
        await client.unlink(temporary).catch(() => undefined);
        throw error;
      }
      const writtenStat = await client.stat(checked);
      return {
        written: data.length,
        version: this.version(c.id, checked, writtenStat.mtimeMs, writtenStat.size),
      };
    });
  }
  private version(id: string, path: string, mtime: number, size: number): string {
    return createHmac('sha256', this.versionKey)
      .update(`${id}\0${path}\0${mtime}\0${size}`)
      .digest('base64url');
  }

  private async ask(
    connectionId: string,
    message: string,
    signal: AbortSignal,
    approveLabel = 'Approve',
    beforePrompt?: () => Promise<unknown>,
  ): Promise<string | undefined> {
    const prior = this.promptTails.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.promptTails.set(connectionId, tail);
    const timeoutMarker = Symbol('confirmation-timeout');
    const abortMarker = Symbol('confirmation-abort');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let onQueueAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      await Promise.race([
        prior,
        new Promise<void>((resolve) => {
          onQueueAbort = resolve;
          signal.addEventListener('abort', onQueueAbort, { once: true });
        }),
      ]);
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      await beforePrompt?.();
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      const answer = await Promise.race([
        this.window.showWarningMessage(message, { modal: true }, approveLabel, 'Deny'),
        new Promise<typeof timeoutMarker>((resolve) => {
          timer = setTimeout(() => resolve(timeoutMarker), 60_000);
        }),
        new Promise<typeof abortMarker>((resolve) => {
          onAbort = () => resolve(abortMarker);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (answer === timeoutMarker)
        throw new EasySshError('CONFIRMATION_EXPIRED', 'Confirmation expired.');
      if (answer === abortMarker) throw new EasySshError('CANCELLED', 'Request cancelled.');
      if (signal.aborted) throw new EasySshError('CANCELLED', 'Request cancelled.');
      return answer;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (onQueueAbort) signal.removeEventListener('abort', onQueueAbort);
      release();
      if (this.promptTails.get(connectionId) === tail)
        void tail.then(() => {
          if (this.promptTails.get(connectionId) === tail) this.promptTails.delete(connectionId);
        });
    }
  }
}

function cancellationToken(signal: AbortSignal) {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(listener: () => unknown) {
      signal.addEventListener('abort', listener, { once: true });
      return { dispose: () => signal.removeEventListener('abort', listener) };
    },
  };
}

async function lstatIfPresent(client: SftpClient, path: string): Promise<RemoteStat | undefined> {
  try {
    return await client.lstat(path);
  } catch (error) {
    if (error instanceof EasySshError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

function sameRemoteVersion(expected: RemoteStat, current: RemoteStat | undefined): boolean {
  return Boolean(
    current &&
      current.kind === expected.kind &&
      current.mtimeMs === expected.mtimeMs &&
      current.size === expected.size,
  );
}

function cancellableShellCommand(command: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  const wrapper = [
    'set -m',
    'child=',
    `trap 'if [ -n "$child" ]; then kill -TERM -- -"$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; fi; exit 143' HUP INT TERM`,
    `sh -c ${quote(command)} </dev/null &`,
    'child=$!',
    'wait "$child"',
    'status=$?',
    'trap - HUP INT TERM',
    'exit "$status"',
  ].join('\n');
  return wrapper;
}
