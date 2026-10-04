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

## Milestone completion checklist

This checklist is the authoritative completion gate for Milestone 07. Check an item only after its implementation and applicable tests/evidence satisfy the detailed requirements below. The milestone is complete only when every item is checked; no implementation, test, documentation, or verification work described by this milestone may remain.

### Entry gate, packaging, and trust boundary

- [ ] Re-run and record all Milestones 01–06 exit criteria, human workflows, tests, and package checks as passing before starting the Milestone 07 completion sign-off.
- [ ] Verify shared SSH/SFTP services provide canonical paths, safe atomic writes, cancellation, size/time/concurrency bounds, exact error mapping, and deterministic disposal required by every MCP handler.
- [ ] Pin an official compatible MCP v2 TypeScript SDK, its schema-validation dependency, and supported companion Node engine exactly; cover the supported Linux socket/filesystem behavior in CI fixtures.
- [ ] Define and document the v1 trust boundary: the companion is an untrusted stdio/IPC bridge, while connection lookup, credentials, host trust, policy, confirmation, SSH/SFTP execution, and audit authority remain in the extension host.
- [ ] Produce a separately bundled Node companion with static MCP tool definitions and enforced imports proving it contains no `vscode`, `ssh2`, SecretStorage, private-key, direct SSH/SFTP, TCP/HTTP, or daemon authority.
- [ ] Add MCP/IPC settings and per-connection agent-policy editor controls with agent access disabled, independent read/write/exec grants, absolute allowed roots, `confirmationMode: 'always'`, and reserved interactive-shell access unavailable by default.
- [ ] Show explicit warnings before switching confirmation to `destructive` or `never`, and document that classification/IPC authentication is not a security boundary against compromise of the same local user.

### Discovery, IPC, companion, and setup

- [ ] Create a fresh per-activation instance id, IPC generation, and cryptographically random 256-bit token; never persist it outside the current discovery lifecycle.
- [ ] Create the Unix socket in a validated private `0700` runtime directory under `$XDG_RUNTIME_DIR` or a private short-path temp fallback and reject unsafe ownership/permission/path conditions.
- [ ] Write a protocol-versioned, expiring discovery file under extension global storage with `0600` permissions and only instance id, socket path, token, creation time, and expiry.
- [ ] Rotate discovery/socket/token state on every activation and reliably unlink discovery and socket artifacts on deactivation or failed startup.
- [ ] Implement 24 MiB length-prefixed UTF-8 JSON framing, exact frame schemas, 128-character request-id caps, method allowlisting, malformed/truncated/oversized rejection, and bounded error responses.
- [ ] Authenticate the first frame using protocol, instance, and constant-time token validation; bind the socket session and reject any later identity/token change, unknown privileged field, or prototype-shaped input.
- [ ] Limit each companion connection to eight concurrent requests and associate every request with cancellation triggered by MCP cancellation, socket close, policy revocation, connection deletion, or extension shutdown.
- [ ] Ensure the IPC server never logs/audits tokens, frames, raw tool payloads, commands, stdout/stderr, file content, credentials, or private-key data.
- [ ] Implement the companion with the official v2 stdio transport, local schema checks, request/cancellation IPC translation, bounded stable error mapping, and no connection/policy/result caching.
- [ ] Handle SIGINT, SIGTERM, stdin close, socket loss, editor absence, and stale discovery by cancelling outstanding work, closing IPC, and returning documented bounded failures without leaving a process/daemon.
- [ ] Implement companion `--self-test` and editor/discovery/socket absence failure within five seconds with actionable instructions.
- [ ] Implement `easysshManager.configureMcp` to verify packaged paths, discover or request Node without a shell, spawn `node --version` argv-safely, enforce the supported range, run self-test, confirm/enable the bridge, and emit generic configuration.
- [ ] Generate/copy/save only a generic JSON snippet containing absolute command/argument paths; include no credential/token and never edit any MCP client's configuration automatically.

### Policy, confirmation, revocation, and path safety

- [ ] Runtime-validate each MCP input and global bound before resolving a connection or performing any authorization/execution work.
- [ ] For every call, freshly resolve the connection, reload policy, check the independent grant, canonicalize/enforce roots, apply confirmation, execute with bounds/cancellation, and append the audit outcome in `finally` in that exact order.
- [ ] Reject empty/non-absolute/invalid allowed roots and canonicalize configured roots with SFTP `realpath`, failing closed whenever canonicalization is unavailable.
- [ ] Track active/queued request ids by connection, grant, and root so disabling access, removing a grant/root, deleting a connection, or shutting down immediately cancels affected work and rejects future calls.
- [ ] Implement `always`, conservative `destructive`, and `never` confirmation behavior exactly, including prompts for all required SFTP mutations and uncertainty-defaults-to-prompt exec classification.
- [ ] Show client label, connection name, tool, safe command summary or exact normalized operation/path, and bounds in Approve/Deny prompts without secret/file content.
- [ ] Serialize prompts per connection, expire them after 60 seconds, deny on close/timeout/policy change/shutdown, and freshly re-evaluate queued policy after every preceding response.
- [ ] Normalize absolute POSIX paths, reject NUL/relative/above-root traversal, and use equality-or-segment-descendant comparisons rather than lexical prefixes.
- [ ] For existing resources, use `realpath` and require canonical containment; for new destinations, walk with `lstat` to the nearest existing ancestor, canonicalize it, and validate every missing segment.
- [ ] Recheck source and destination containment immediately before mutation to resist parent replacement/symlink races; require both rename endpoints inside allowed roots on the same connection.
- [ ] Allow link metadata listing/stat only as specified; reject read/write/delete traversal through links unless the canonical target independently remains allowed, and never follow links recursively.

### MCP tools and bounded execution

- [ ] Implement `remote_list_connections` with an empty input and only enabled UUID/name/host/port/username, effective grants, and allowed roots—never auth details, local key paths, provenance, SecretStorage identifiers, or credentials.
- [ ] Implement independent non-PTY `ssh_exec` through shared host/auth services with 1–32,768-byte non-NUL commands, absolute validated `cwd`, safe POSIX `cd --` quoting, and no local shell interpolation.
- [ ] Enforce exec timeout defaults/maxima, cancellation, separate 1 MiB raw stdout/stderr caps, channel termination on overflow, no partial output on `OUTPUT_LIMIT`, and structured exit/signal/timed-out/duration results.
- [ ] Implement `sftp_list` for exactly one directory with bounded safe metadata and `sftp_stat` with `lstat`, canonical-containment result, and opaque metadata version.
- [ ] Implement ranged `sftp_read` with offset/length/eof semantics, strict UTF-8 or canonical base64, a 4 MiB raw cap, total size, and keyed per-activation opaque versions derived without forgeable exposed fields.
- [ ] Implement `sftp_write` with canonical base64/UTF-8 decoding, pre-allocation 20 MiB decoded cap, missing-file creation, matching-version overwrite, explicitly confirmed force bypass, shared atomic writer, and returned fresh version.
- [ ] Implement `sftp_mkdir` for one missing directory with existing parents and `sftp_rename` with both endpoints contained plus fresh no-overwrite checks.
- [ ] Implement `sftp_delete` for file/link by default and explicitly recursive directories only with strong applicable confirmation, iterative bounded post-order traversal, cancellation, and no link following.
- [ ] Route every tool through shared connection/auth/host-trust/SFTP services, stable domain errors, operation limits, cancellation, mutation-time policy/path rechecks, and targeted cache/provider updates.
- [ ] Ensure decoded/encoded sizes, list counts, recursive traversal, IPC frames, request concurrency, execution time, and returned errors are all bounded before unbounded allocation or work.

### Audit and shutdown

- [ ] Implement serialized metadata-only JSONL audit records with the specified fields, keyed command fingerprints, safe normalized targets, confirmation/outcome/error/duration, and no raw command/cwd content, output, file data, auth data, IPC token, or payload.
- [ ] Store audit files under extension global storage with `0600` permissions, symlink-safe open/rotation, predictable flush/close, partial-last-line recovery, and combined 30-day/10 MiB retention.
- [ ] Implement paginated sanitized audit viewing, save-dialog export of the same sanitized representation, and confirmation-protected clearing.
- [ ] Implement ordered deactivation that stops accepts, denies prompts, revokes/cancels calls, closes companion sockets/IPC, removes discovery/socket/token references, flushes/closes audit storage, and then performs shared network cleanup.

### Automated verification

- [ ] Add discovery/socket lifecycle tests for permissions, private fallback directories, rotation/expiry, stale generation/token, wrong instance/protocol, startup failure, and complete cleanup.
- [ ] Add IPC tests for oversized/truncated/invalid/prototype frames, unknown methods/fields, duplicate ids, authentication rebinding attempts, concurrency caps, cancellation, socket loss, and bounded sanitized errors.
- [ ] Add companion tests for self-test, five-second unavailable-editor behavior, stdio request/result/error/cancel mapping, SIGINT/SIGTERM/stdin close, no state caching, and prohibited-import enforcement.
- [ ] Add setup tests proving argv-safe Node version checks, supported-range enforcement, absolute-path JSON quoting, generic config generation, no client-config mutation, and absence of tokens/credentials.
- [ ] Add policy tests for disabled/unknown/deleted connections, independent grants, invalid/empty roots, secure defaults, every confirmation result/expiry/close, warning acknowledgements, prompt serialization, and queued re-evaluation.
- [ ] Add revocation tests proving immediate cancellation/rejection for queued, active, and future requests after access disable, grant/root removal, connection deletion, and shutdown.
- [ ] Add canonical-path adversarial tests for `/app` versus `/application`, `..`, relative/encoded/NUL input, root equality, broken/internal/external links, outside-to-inside links, missing nested targets, parent replacement races, and cross-root rename.
- [ ] Add direct-IPC adversarial tests proving schemas, grants, confirmation, versions, size limits, and root containment cannot be bypassed without the companion.
- [ ] Add discovery and exec tests for safe-field filtering, stdout/stderr/exit/signal/timeout/cwd quoting, cancellation, per-stream overflow, Unicode, length/NUL rejection, disconnect, and confirmation modes.
- [ ] Add SFTP tool tests for list/stat metadata, range/eof boundaries, UTF-8/base64 validation, 4 MiB/20 MiB limits, stale/forged/matching/forced versions, create/mkdir/rename conflicts, link/file/recursive delete, cancellation, and no link recursion.
- [ ] Add audit tests for every outcome, concurrent serialized append, partial-line recovery, retention rotation, permissions, symlink attacks, pagination/export/clear, and sentinel absence from persisted bytes.
- [ ] Add companion-to-extension-to-Docker integration tests for discovery, exec, ranged reads, create/versioned/forced overwrite, mkdir/rename/delete, permission denial, confirmation approval/denial/expiry, cancellation, disconnect, and immediate revocation.
- [ ] Add secret-boundary sentinel tests proving credentials, private keys/paths where prohibited, passphrases, SecretStorage ids, IPC tokens, raw commands, file bodies, and stdout/stderr do not appear in unauthorized MCP results/errors, logs, audit, config, discovery, or process arguments.
- [ ] Run the complete automated suite plus formatting, lint, typecheck, both bundles, package-content/import checks, Docker/extension integration, and all previous milestone checks and record all results as passing.

### Manual acceptance and completion gate

- [ ] Run Configure MCP, validate supported/unsupported Node versions, self-test the companion, generate a generic snippet, and connect a local MCP client without automatic config edits.
- [ ] With all policies disabled, verify discovery omits the connection and guessed UUID/direct IPC calls fail without leaking connection/auth details.
- [ ] Enable read for one root; exercise list/stat/ranged UTF-8/base64 reads inside it and attempt lexical, traversal, encoded, broken-link, and symlink escape cases.
- [ ] Enable exec with default Always Ask; approve, deny, expire, cancel, timeout, and overflow commands and verify exact safe outcomes and prompt serialization.
- [ ] Read a file/version, change it externally, verify stale/forged writes fail, then exercise matching-version and explicitly confirmed force writes on harmless data.
- [ ] Enable write and exercise create, mkdir, rename conflict, link/file delete, and strongly confirmed bounded recursive directory delete on a test tree.
- [ ] Revoke each grant/root and all agent access during queued and active work; verify immediate cancellation and subsequent rejection.
- [ ] View, export, rotate, and clear audit records; scan global storage, logs, config, process arguments, discovery/socket data, responses, and exports for sentinel secrets/content.
- [ ] Close VSCodium during active work and verify companion failure within the documented bound, no useful discovery/socket, no daemon, cancelled work, closed audit, and removed runtime artifacts.
- [ ] Smoke-test the generic MCP semantics with one client now and reserve the required second MCP-capable client cross-check for the explicit Milestone 08 release gate.
- [ ] Confirm the companion contains no credential/network authority, every request is freshly authorized/contained/confirmed/bounded/cancellable/audited, and all supported Linux permission/shutdown checks pass.
- [ ] Re-run every previous milestone gate and confirm every Milestone 07 deliverable, exit criterion, risk mitigation, and stated non-goal boundary is satisfied with no remaining implementation, test, documentation, or verification task.

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
