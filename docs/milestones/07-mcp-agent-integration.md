# Milestone 07 — MCP Agent Integration

## Objective

Expose explicitly authorized connection capabilities to local MCP clients without moving credentials, private keys, host-trust authority, or permission decisions out of the extension host. Ship a stdio companion that is only a protocol/IPC bridge; all connection lookup, policy enforcement, confirmation, SSH/SFTP execution, and auditing stay in the running extension.

v1 MCP provides connection discovery, bounded non-interactive SSH execution, and SFTP list/stat/ranged-read/write/mkdir/rename/delete. Interactive PTYs and attachment to visible terminals are deliberately excluded.

## Prerequisites

- Milestones 01–06 exit criteria pass.
- Shared SSH/SFTP services expose cancellation, size/time bounds, safe writes, canonical paths, and deterministic disposal.
- A compatible stable release from the official MCP v2 TypeScript SDK is pinned exactly with its schema-validation dependency and Node engine requirement.
- Linux Unix-domain sockets and filesystem permission behavior are covered by CI fixtures.

## Deliverables

- Separately bundled Node.js stdio MCP companion with no `vscode`, `ssh2`, SecretStorage, or private-key access.
- Authenticated length-bounded local IPC server in the extension and reconnecting client in the companion.
- Generic MCP setup/config generation command and runtime/preflight diagnostics.
- Per-connection agent policy editor, absolute remote-root allowlists, confirmation modes, immediate revocation, and session cancellation.
- Discovery, `ssh_exec`, and safe SFTP MCP tools with strict schemas, limits, cancellation, and normalized errors.
- Canonical path/root enforcement resistant to `..` and symlink escapes.
- Bounded persistent metadata-only audit store with view/export/clear commands.
- Contract, adversarial security, integration, and client smoke tests.

## Architecture and interfaces

### Trust boundary and process layout

```text
MCP client
  -> stdio JSON-RPC
bundled companion.js (untrusted bridge; no secrets)
  -> authenticated Unix-domain IPC
VSCodium extension host
  -> policy + confirmation + audit
shared SSH/SFTP services
  -> remote server
```

- The MCP client launches `node <absolute-extension-path>/dist/mcp/companion.js --discovery <file>` using a generated generic configuration snippet.
- Setup verifies the selected `node` binary meets the pinned MCP SDK minimum before generating configuration.
- The config contains no credential or long-lived bearer token.
- The extension creates a random per-activation IPC generation, socket, and 256-bit authentication token. Store discovery data in an extension-global-storage file readable/writable only by the current user (`0600`); place the socket in a private `0700` runtime directory under `$XDG_RUNTIME_DIR` or a validated private temp fallback to avoid Unix path-length problems.
- Discovery contains protocol version, extension instance id, socket path, token, created time, and expiry. Rotate it on every activation and unlink it/socket on deactivation.
- Local same-user compromise is outside the enforceable boundary, but path permissions, a constant-time token check, protocol versioning, policy, and confirmation prevent accidental/cross-user access.
- Do not open TCP/HTTP listeners or install a daemon. If the editor/discovery/socket is absent, companion initialization fails within five seconds with instructions to start VSCodium and enable the bridge.

### IPC framing and authentication

Use length-prefixed UTF-8 JSON frames, not newline-delimited bodies that can be confused by payloads.

```ts
interface IpcRequest {
  protocolVersion: 1;
  requestId: string;
  instanceId: string;
  token: string;
  method: string;
  params: unknown;
}

interface IpcResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}
```

- Limit frame length to 24 MiB, request IDs to 128 characters, method names to an allowlist, and concurrent requests per companion connection to 8.
- Authenticate the first frame and bind the socket to the validated instance/token; reject changes thereafter.
- Runtime-validate frames independently on both sides; ignore prototype properties and unknown privileged fields.
- Associate every request with an AbortController. Client cancellation, socket close, policy revocation, and extension deactivation cancel remote work.
- Never place the token, frames, tool payloads, stdout/stderr, or file content in logs/audit.

### Policy model and enforcement order

Milestone 02's `AgentAccessPolicy` becomes editable. File grants require one or more normalized absolute POSIX `allowedRoots`; write does not implicitly grant read, and exec is independent.

For every call, in this exact order:

1. Validate MCP input schema and global size limits.
2. Resolve connection UUID fresh; reject unknown/deleted ids.
3. Load policy fresh; reject disabled tool/grant.
4. For SFTP, canonicalize and enforce allowed roots.
5. Apply confirmation mode.
6. Execute through shared service with cancellation/limits.
7. Record metadata-only audit outcome in `finally`.

Do not cache an authorization decision across calls. Track active request ids by connection; disabling agent access, removing a grant/root, or deleting the connection cancels matching active requests and rejects subsequent ones immediately.

New/disabled policies use `confirmationMode: 'always'`. Switching to `destructive` or `never` displays a warning that heuristics are not a security boundary. Tool grants remain the primary boundary.

### Confirmation behavior

- `always`: prompt before every exec and SFTP mutation; SFTP reads may be grouped into one explicit request only, never globally approved.
- `destructive`: use a conservative classifier for exec (`rm`, `sudo`, redirections, chmod/chown, service/package/database mutation, reboot/shutdown, ambiguous shell composition) and prompt for all SFTP mutations. If uncertain, prompt.
- `never`: no per-call prompt after policy checks; enabling it requires explicit warning confirmation in the connection editor.
- Prompt shows client label, connection name, tool, command summary or exact normalized path/operation, bounds, and Approve/Deny. It never shows secret/file content.
- Confirmation expires after 60 seconds; window close, timeout, policy change, or editor shutdown denies/cancels.
- Prompts are serialized per connection and queued request policy is re-evaluated after the preceding answer.

### Root containment and symlink safety

Lexical prefix checks are insufficient. For every requested path:

- Normalize absolute POSIX form and reject NUL/relative/above-root traversal.
- Canonicalize each configured allowed root with SFTP `realpath` when enabling/using policy; fail closed if unavailable.
- For existing read/stat/list/delete/rename sources, `realpath` the resource and require equality to or segment-bound descendant of one canonical allowed root.
- For new write/mkdir/rename destinations, walk upward with `lstat` to the nearest existing ancestor, `realpath` it, prove containment, then append validated missing segments without following any subsequently appeared link.
- Recheck source/destination containment immediately before mutation.
- A symbolic-link entry may be listed/stat'ed, but reading/writing/deleting through it is rejected unless its canonical target independently remains inside an allowed root; recursive behavior never follows links.
- Rename requires source and destination inside allowed roots and on the same connection.

### MCP tool schemas

`remote_list_connections`

- Input: empty object.
- Output: only enabled connection UUID/name/host/port/username plus effective read/write/exec booleans and allowed roots. Never include auth mode detail, local key path, provenance, SecretStorage status/key, or credentials.

`ssh_exec`

```ts
interface SshExecInput {
  connectionId: string;
  command: string;       // 1..32,768 UTF-8 bytes, no NUL
  cwd?: string;          // absolute POSIX path
  timeoutMs?: number;    // default 30,000; max 300,000
}

interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
}
```

- Open an independent non-PTY SSH exec channel through shared host/auth services.
- If `cwd` exists, validate it and construct `cd -- <single-quote-escaped cwd> && <command>` for the supported Linux POSIX shell contract. The user-provided command remains intentionally shell-evaluated; never add it to another shell/CLI argument locally.
- Capture stdout and stderr separately, with hard raw caps of 1 MiB each. On either overflow, terminate the channel and return `OUTPUT_LIMIT` with observed counts but no partial bodies.
- Timeout terminates the channel and returns a structured timed-out result when an exit status can be safely represented; connection errors remain errors.

SFTP tools:

```ts
interface SftpReadInput {
  connectionId: string;
  path: string;
  encoding: 'utf8' | 'base64';
  offset?: number;
  length?: number; // raw-byte max 4 MiB
}

interface SftpReadResult {
  data: string;
  encoding: 'utf8' | 'base64';
  offset: number;
  bytesRead: number;
  totalSize: number;
  version: string;
  eof: boolean;
}

interface SftpWriteInput {
  connectionId: string;
  path: string;
  data: string;
  encoding: 'utf8' | 'base64';
  expectedVersion?: string;
  force?: boolean;
}
```

- `sftp_list`: one directory only; return name/kind/size/mtime and opaque version where meaningful.
- `sftp_stat`: return lstat metadata, canonical containment result, and opaque metadata version.
- `sftp_read`: decode exact range, reject invalid UTF-8 in UTF-8 mode, cap raw request/result at 4 MiB, and return an opaque version derived from connection/path/mtime/size with a per-activation keyed digest so clients cannot forge fields.
- `sftp_write`: cap decoded data at 20 MiB. Creating a missing file needs no version. Overwriting requires a matching `expectedVersion`; `force: true` bypasses version only after policy confirmation. Use the shared atomic writer and return the new version.
- `sftp_mkdir`: one directory, parents must exist, target missing.
- `sftp_rename`: no implicit overwrite; source/destination containment and fresh conflict checks.
- `sftp_delete`: file/link only by default; directory deletion requires `recursive: true`, strong applicable confirmation, bounded iterative traversal, and no link following.
- Encode binary data only as base64; validate canonical base64 and reject decoded over-limit payloads before allocation where possible.

### MCP companion

- Use the official v2 server package and stdio transport only.
- Register static tool definitions and translate SDK cancellation/errors to IPC.
- Companion performs schema validation for quick feedback, but extension validation remains authoritative.
- Map extension errors to bounded user-safe MCP errors with stable codes; do not include stack/cause/IPC data.
- Handle SIGINT/SIGTERM/stdin close by cancelling IPC requests and closing the socket.
- Do not cache connection lists/policies/results across calls.

### Setup command

`easysshManager.configureMcp`:

1. confirms the packaged companion/discovery path exists;
2. asks for or discovers a `node` executable without invoking a shell;
3. runs `node --version` with argv-safe process spawn and validates the supported range;
4. starts an ephemeral `--self-test` of the companion;
5. enables/starts the extension IPC bridge after confirmation;
6. produces a generic JSON snippet with absolute command/args and copies or saves it on request;
7. never edits Codex/Claude/other client configurations automatically.

### Audit store

Write JSONL under extension global storage, rotating to keep both at most 30 days and 10 MiB total.

```ts
interface AgentAuditRecord {
  timestamp: string;
  requestId: string;
  clientLabel?: string;
  connectionId: string;
  connectionNameSnapshot: string;
  tool: string;
  operationTarget?: string; // normalized remote path, not content
  commandFingerprint?: string; // keyed digest; never raw command
  confirmation: 'approved' | 'denied' | 'not-required' | 'expired';
  outcome: 'success' | 'rejected' | 'failed' | 'cancelled';
  errorCode?: string;
  durationMs: number;
}
```

- Never persist raw command, cwd contents beyond normalized path if policy permits, stdout/stderr, file data, credential/auth/key data, IPC token, or tool payload.
- Serialize appends, fsync/close predictably, enforce `0600`, tolerate/truncate a partial last line, and rotate without following symlinks.
- Commands view a paginated sanitized representation, export the same records through a save dialog, and clear only after confirmation.

## Implementation checklist

- [ ] Add MCP/IPC settings and agent-policy editor controls with disabled secure defaults/warnings.
- [ ] Bundle the companion separately and enforce import rules preventing VS Code/SSH/credential dependencies.
- [ ] Implement private runtime directory, per-activation discovery/token/socket lifecycle, permissions, framed protocol, authentication, validation, concurrency, and cancellation.
- [ ] Implement companion stdio tools, IPC translation, error mapping, shutdown, and self-test.
- [ ] Add generic setup/config command and Node compatibility checks.
- [ ] Implement fresh per-call policy engine, active-request registry, immediate revocation, confirmation queue, and destructive classifier.
- [ ] Implement canonical root service for existing/new paths and mutation-time rechecks.
- [ ] Implement discovery, bounded exec, and all SFTP tool handlers through shared services.
- [ ] Implement keyed opaque version tokens, range/encoding handling, exact size caps, and forced-write confirmation.
- [ ] Implement bounded permission-safe audit JSONL, rotation, view, export, and clear.
- [ ] Add deactivation ordering: stop accepts, revoke/cancel calls, close IPC, remove socket/discovery/token references, close audit, then shared network cleanup.

## Automated tests

### IPC/companion tests

- Discovery/socket permission, stale generation/token, wrong instance/protocol, oversized/truncated/invalid frames, unknown methods, duplicate ids, concurrency cap, socket loss, cancellation, and cleanup.
- Companion unavailable-editor error within five seconds, self-test, stdio request/result/error/cancel, SIGINT, and no secret-capable imports.
- Generated generic config quotes absolute paths as JSON values and contains no token/credential.

### Policy/security tests

- Disabled/unknown/deleted connections; independent read/write/exec grants; empty root rejection; default always confirmation; deny/expire/window-close; destructive/never warning; queued prompt re-evaluation.
- Immediate cancellation/rejection after disable, grant removal, root removal, or connection deletion.
- Lexical prefix confusion (`/app` vs `/application`), `..`, encoded/NUL segments, root itself, symlink inside-to-outside, outside-to-inside, broken links, parent replacement race, new nested target, and rename across roots.
- Direct IPC calls cannot bypass schemas, permission, confirmation, version, or path enforcement.

### Tool tests

- Discovery returns only authorized safe fields.
- Exec stdout/stderr/exit/signal/timeout/cwd quoting, cancellation, output cap on each stream, Unicode, command length/NUL, disconnect, and confirmation.
- List/stat/read boundaries, range/eof, valid/invalid UTF-8, canonical base64, 4 MiB cap, stale/forged versions, create, matching overwrite, forced overwrite, 20 MiB cap, mkdir, rename conflict, file/link delete, recursive directory delete, and no link recursion.
- Credential/private-key/passphrase/SecretStorage ids never appear in any MCP result/error/log/audit fixture.

### Audit tests

- Success/reject/failure/cancel records, concurrent serialized append, partial-line recovery, 30-day/10-MiB rotation, permission mode, view pagination, export, clear confirmation, and symlink-safe files.
- Sentinel command/file/credential/output strings do not appear in persisted audit bytes.

### Integration/client tests

- Companion-to-extension-to-Docker discovery, exec, ranged read, create/versioned overwrite, mkdir/rename/delete, permission denial, prompt approval/denial, and immediate revocation.
- Smoke-test with at least two MCP-capable clients manually in Milestone 08; tool semantics remain generic and client-independent.

## Manual acceptance tests

1. Run Configure MCP, validate Node, generate a generic snippet, and connect a local MCP client.
2. With all policies disabled, verify discovery excludes the connection and direct guessed-ID calls fail.
3. Enable read with one root; list/stat/read inside it and attempt lexical/traversal/symlink escapes.
4. Enable exec with default Always Ask; approve/deny/expire commands, then test output and timeout caps.
5. Read a file/version, modify it externally, and verify stale write rejection. Exercise confirmed force on a harmless test file.
6. Enable write and exercise mkdir/rename/delete plus recursive delete on a test tree.
7. Revoke each grant and entire agent access during active requests; verify immediate cancellation/subsequent rejection.
8. Inspect, export, and clear audit records; search global storage, logs, process arguments, config, and responses for sentinel secrets/content.
9. Close VSCodium and verify the companion fails clearly without starting or retaining a daemon.

## Exit criteria

- The companion contains no credential/network-transport authority beyond authenticated IPC and stdio MCP handling.
- Every call is freshly authorized, root-contained, confirmation-controlled, bounded, cancellable, and audited.
- Credentials/private keys never cross IPC or MCP, and raw commands/file bodies never enter persistent audit storage.
- Discovery, exec, and all declared SFTP tools pass contract/adversarial/Docker tests.
- Revocation takes effect immediately for queued, active, and future work.
- Socket/discovery/audit permissions and shutdown cleanup pass on supported Linux environments.
- All previous human workflows and package tests remain green.

## Risks and mitigations

- **IPC mistaken for a security boundary against same user:** document the boundary honestly, apply filesystem permissions/token authentication, and retain per-call policy/confirmation.
- **Symlink/path escape:** canonicalize server-side through SFTP and recheck immediately before mutation.
- **Command classifier gaps:** default to Always Ask; treat classifier only as convenience, never authorization.
- **Unbounded agent data:** cap frames, inputs, outputs, concurrency, time, and file ranges before allocation/execution.
- **Companion version skew:** version discovery/IPC, package companion with extension, and reject incompatible protocol versions.
- **Audit leaking command secrets:** store only keyed fingerprints and bounded metadata, backed by sentinel tests.

## Non-goals

- Interactive MCP shells, PTY session tools, attachment to visible terminals, or terminal scraping.
- TCP/HTTP MCP transport, remote MCP access, auto-editing client configs, or an always-running broker.
- Returning stored credentials, private-key contents/paths, auth payloads, or raw audit commands.
- Agent access outside explicit allowed roots or across connections.
- Automatic shell safety guarantees; users grant exec deliberately and confirmation remains policy-driven.
