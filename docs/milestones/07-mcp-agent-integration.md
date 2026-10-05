# Milestone 07 — MCP Agent Integration

## Goal

Expose explicitly authorized EasySSH connections to local MCP clients without moving credentials, private keys, host trust, authorization, confirmation, SSH/SFTP execution, or audit authority out of the VSCodium extension host.

The bundled MCP companion is only a stdio ↔ authenticated local IPC bridge. v1 supports connection discovery, bounded non-interactive SSH execution, and SFTP list/stat/ranged-read/write/mkdir/rename/delete. Interactive PTYs, visible-terminal attachment, TCP/HTTP transport, remote MCP access, and background daemons are out of scope.

## Goal-mode rules

- Work top-to-bottom.
- Check an item only when its implementation and relevant tests pass.
- Reuse the existing shared SSH/SFTP/auth/host-trust services.
- Make authorization decisions fresh for every call; do not cache policy decisions.
- Fail closed on invalid policy, invalid paths, failed canonicalization, stale discovery, or ambiguous authorization.
- Never log or persist credentials, private keys, IPC tokens, raw commands, stdout/stderr, file bodies, raw IPC frames, or raw MCP payloads.

---

## 1. Entry gate and fixed dependencies

- [ ] **Re-run Milestones 01–06 and record them green.**
  - Exit criteria, human workflows, automated tests, and package checks must all pass before Milestone 07 sign-off.

- [ ] **Verify the shared SSH/SFTP layer is ready for MCP use.**
  - Must provide cancellation, canonical paths, safe atomic writes, size/time/concurrency bounds, stable errors, and deterministic disposal.

- [x] **Pin the MCP runtime dependencies exactly.**
  - Pin a compatible official MCP v2 TypeScript SDK.
  - Pin its schema-validation dependency.
  - Define the exact supported Node engine range for the companion.

- [ ] **Add Linux IPC permission fixtures to CI.**
  - Cover Unix-domain sockets, `0600` files, `0700` runtime directories, ownership, cleanup, and temp fallback behavior.

---

## 2. Lock the trust boundary

- [ ] **Document and enforce this process split.**
  - MCP client → stdio companion → authenticated Unix-domain IPC → extension host → shared SSH/SFTP services → remote server.
  - Companion contains no credential, private-key, host-trust, policy, confirmation, SSH/SFTP, or audit authority.

- [ ] **Document the local-user boundary honestly.**
  - Same-user compromise is outside the enforceable security boundary.
  - Filesystem permissions, token auth, per-call policy, and confirmation still protect against accidental/cross-user access.

- [ ] **Keep v1 non-goals unavailable.**
  - No interactive MCP shell/PTTY.
  - No attachment to visible terminals or terminal scraping.
  - No TCP/HTTP MCP listener.
  - No remote MCP access.
  - No always-running broker/daemon.
  - No automatic client-config editing.

---

## 3. Build the stdio MCP companion

- [ ] **Bundle a separate Node.js companion.**
  - Use the official MCP v2 server package and stdio transport only.
  - Register static tool definitions.
  - Package it with the extension.

- [ ] **Prove the companion has no forbidden authority.**
  - Add package/import checks rejecting `vscode`, `ssh2`, SecretStorage/private-key access, direct SSH/SFTP access, TCP/HTTP listeners, or daemon behavior.

- [ ] **Keep companion behavior bounded and stateless.**
  - Local schema validation is only fast feedback; extension validation is authoritative.
  - Do not cache connections, policies, or results.
  - Map extension failures to bounded stable MCP errors without stack/cause/IPC internals.

- [ ] **Handle companion termination correctly.**
  - SIGINT, SIGTERM, and stdin close cancel outstanding requests and close IPC.

---

## 4. Create per-activation discovery and socket state

- [ ] **Generate fresh activation identity.**
  - Fresh instance id.
  - Fresh IPC generation.
  - Cryptographically random 256-bit auth token.
  - Rotate all of them every activation.

- [ ] **Create a private Unix-domain socket location.**
  - Prefer a validated user-owned `0700` directory under `$XDG_RUNTIME_DIR`.
  - Use a validated private short-path temp fallback if necessary.
  - Reject unsafe ownership/permissions/path conditions.
  - Never fall back to TCP/HTTP.

- [ ] **Write a strict discovery file under extension global storage.**
  - Mode `0600`.
  - Contains only protocol version, instance id, socket path, token, creation time, and expiry.
  - No credentials or long-lived client bearer token.

- [ ] **Clean activation artifacts reliably.**
  - Unlink stale socket state safely.
  - Remove socket/discovery/token references on deactivation.
  - Remove them after failed/partial startup.
  - Reject expired/stale discovery.

---

## 5. Implement authenticated bounded IPC

- [x] **Implement length-prefixed UTF-8 JSON framing.**
  - Do not use newline-delimited framing.
  - Frame cap: 24 MiB.
  - Request id cap: 128 characters.
  - Method names come from an allowlist.
  - Reject malformed, truncated, oversized, prototype-shaped, and unknown privileged fields.

- [x] **Use the fixed request/response contract.**
  - Request: `protocolVersion`, `requestId`, `instanceId`, `token`, `method`, `params`.
  - Response: `protocolVersion`, `requestId`, `ok`, optional `result`, optional bounded `{code,message,retryable}` error.
  - Runtime-validate independently on both sides.

- [ ] **Authenticate and bind the IPC connection on its first frame.**
  - Validate protocol and instance id.
  - Compare token in constant time.
  - Bind the connection to that identity.
  - Reject later token/instance changes and stale credentials.

- [ ] **Bound request concurrency and lifecycle.**
  - Maximum 8 concurrent requests per companion connection.
  - Bound/reject duplicate request ids.
  - Associate every request with an `AbortController`.

- [ ] **Propagate cancellation from every required source.**
  - MCP cancellation.
  - Socket close.
  - Agent-access disable.
  - Grant/root removal.
  - Connection deletion.
  - Extension shutdown.

- [ ] **Make IPC shutdown ordered.**
  - Stop accepts.
  - Deny pending prompts.
  - Cancel work.
  - Close companion sockets.
  - Remove discovery/socket/token references.
  - Flush/close audit.
  - Then perform shared network cleanup.

---

## 6. Implement per-connection agent policy

- [x] **Add policy editing to the connection editor.**
  - Agent access disabled by default.
  - Independent read, write, and exec grants.
  - Write does not imply read.
  - File grants require one or more normalized absolute POSIX `allowedRoots`.
  - Reserved interactive-shell access stays false/unavailable in v1.

- [x] **Use secure confirmation defaults.**
  - New/disabled policies default to `confirmationMode: 'always'`.
  - Switching to `destructive` or `never` requires an explicit warning acknowledgement.
  - State that the destructive classifier is convenience only, not a security boundary.

- [ ] **Enforce one exact authorization order for every call.**
  1. Validate MCP input and global bounds.
  2. Freshly resolve connection id.
  3. Freshly load policy and grant.
  4. For SFTP, canonicalize/enforce roots.
  5. Apply confirmation mode.
  6. Execute via shared services with bounds/cancellation.
  7. Append metadata-only audit outcome in `finally`.

- [ ] **Make revocation immediate.**
  - Track queued/active work by connection, grant, and root as needed.
  - Disable access, remove grant/root, delete connection, or shutdown → cancel matching queued/active work immediately.
  - All subsequent matching calls fail immediately.

---

## 7. Implement confirmation behavior

- [ ] **Implement `always`.**
  - Prompt before every exec call.
  - Prompt before every SFTP mutation.
  - SFTP reads may be grouped only inside one explicit request, never globally approved.

- [ ] **Implement conservative `destructive`.**
  - Prompt for all SFTP mutations.
  - Prompt for exec containing or ambiguously composing destructive patterns such as `rm`, `sudo`, redirections, chmod/chown, service/package/database mutation, reboot/shutdown.
  - If uncertain, prompt.

- [ ] **Implement `never` only after policy checks.**
  - No per-call prompt after authorization/path checks.
  - Enabling it requires explicit warning confirmation in the editor.

- [ ] **Build safe prompts.**
  - Show client label, connection name, tool, safe command summary or exact normalized path/operation, applicable bounds, Approve/Deny.
  - Do not show secrets or file bodies.

- [ ] **Bound and serialize prompts.**
  - Expire after 60 seconds.
  - Window close, timeout, policy change, or editor shutdown denies/cancels.
  - Serialize prompts per connection.
  - Re-evaluate queued policy after each preceding answer.

---

## 8. Implement canonical root/path safety

- [x] **Normalize every remote path before authorization.**
  - Absolute POSIX only.
  - Reject NUL, relative paths, and above-root traversal.
  - Use equality-or-segment-descendant checks, never lexical prefix checks.

- [ ] **Canonicalize configured roots.**
  - Use SFTP `realpath` when enabling/using policy.
  - Fail closed if canonicalization is unavailable.

- [ ] **Protect access to existing resources.**
  - For read/stat/list/delete/rename source: `realpath` the resource and require canonical containment in an allowed root.

- [ ] **Protect creation destinations.**
  - For new write/mkdir/rename destination: walk upward using `lstat` to the nearest existing ancestor, `realpath` it, prove containment, then append validated missing segments without following newly appeared links.

- [ ] **Recheck immediately before every mutation.**
  - Recheck source and destination containment to resist replacement/symlink races.
  - Rename requires both endpoints inside allowed roots on the same connection.

- [ ] **Handle symlinks safely.**
  - Listing/stat may expose link metadata.
  - Read/write/delete through a link only if its canonical target independently remains allowed.
  - Recursive behavior never follows links.

---

## 9. Implement MCP tools

- [ ] **Implement `remote_list_connections`.**
  - Empty-object input only.
  - Return enabled UUID/name/host/port/username, effective read/write/exec booleans, and allowed roots.
  - Never return auth details, local key paths, provenance, SecretStorage ids/status, or credentials.

- [ ] **Implement bounded non-PTY `ssh_exec`.**
  - Command: 1–32,768 UTF-8 bytes, no NUL.
  - Optional absolute POSIX `cwd`.
  - Timeout default 30,000 ms; max 300,000 ms.
  - Use independent shared SSH exec channel, no PTY.
  - For `cwd`, use safe POSIX `cd -- <single-quote-escaped cwd> && <command>`; never place the command into a local shell/CLI argument.
  - Separate stdout/stderr; each hard-capped at 1 MiB raw.
  - On either overflow: terminate and return `OUTPUT_LIMIT` with observed counts, no partial bodies.
  - Return stdout/stderr/exitCode/signal/timedOut/duration when safely representable; connection failures remain errors.

- [ ] **Implement `sftp_list` and `sftp_stat`.**
  - List exactly one directory; bounded name/kind/size/mtime/version metadata.
  - Stat uses `lstat`, reports containment result and opaque metadata version.

- [ ] **Implement ranged `sftp_read`.**
  - `utf8` or `base64` only.
  - Optional offset/length.
  - Raw cap 4 MiB.
  - Reject invalid UTF-8 in UTF-8 mode.
  - Return data, encoding, offset, bytesRead, totalSize, eof, opaque version.
  - Version uses connection/path/mtime/size plus per-activation keyed digest so clients cannot forge fields.

- [ ] **Implement versioned atomic `sftp_write`.**
  - `utf8` or canonical base64 only.
  - Decoded cap 20 MiB; reject over-limit input before unbounded allocation where possible.
  - Missing file may be created without a version.
  - Existing overwrite requires matching `expectedVersion`.
  - `force: true` bypasses version only after applicable explicit confirmation.
  - Use shared atomic writer and return a fresh opaque version.

- [ ] **Implement `sftp_mkdir`, `sftp_rename`, and `sftp_delete`.**
  - mkdir: exactly one missing directory; parents already exist.
  - rename: both endpoints contained, same connection, fresh no-overwrite conflict check.
  - delete: file/link by default; directory only with `recursive: true`, strong confirmation, bounded iterative post-order traversal, cancellation, and no link following.

- [ ] **Route every tool through shared services and hard bounds.**
  - Shared connection/auth/host-trust/SFTP services.
  - Stable errors, cancellation, mutation-time policy/path rechecks, targeted cache/provider updates.
  - Bound decoded/encoded sizes, list counts, recursive traversal, frames, concurrency, execution time, and returned errors before unbounded work/allocation.

---

## 10. Implement MCP setup flow

- [ ] **Implement `easysshManager.configureMcp`.**
  - Verify packaged companion/discovery paths.
  - Discover or ask for Node without invoking a shell.
  - Spawn `node --version` argv-safely and enforce supported range.
  - Run companion `--self-test`.
  - Confirm before enabling/starting the extension IPC bridge.
  - Generate generic JSON config equivalent to launching `node <absolute-extension-path>/dist/mcp/companion.js --discovery <file>`, with absolute command/argument paths.
  - Allow copy/save on request.
  - Never write a client config automatically.
  - Config contains no credential/token.

- [ ] **Implement bounded editor-unavailable behavior.**
  - Missing editor/discovery/socket or stale discovery fails within 5 seconds with actionable instructions to start VSCodium and enable the bridge when appropriate.
  - No orphan process/daemon remains.

---

## 11. Implement metadata-only audit

- [ ] **Write bounded JSONL audit records under global storage.**
  - Fields: timestamp, requestId, optional clientLabel, connectionId, connectionNameSnapshot, tool, optional normalized operationTarget, optional keyed commandFingerprint, confirmation, outcome, optional errorCode, durationMs.

- [ ] **Keep audit content non-sensitive.**
  - Never persist raw command, stdout/stderr, file data, credential/auth/key data, IPC token, or raw tool/IPC payload.

- [ ] **Make audit storage robust.**
  - Serialized appends, mode `0600`, symlink-safe open/rotation, predictable flush/close, partial-final-line recovery.
  - Retain at most 30 days and 10 MiB total.

- [ ] **Add audit UI commands.**
  - Paginated sanitized view.
  - Save-dialog export of the same sanitized representation.
  - Clear only after confirmation.

---

## 12. Automated verification

- [ ] **Discovery/socket lifecycle suite passes.**
  - Permissions, private fallback, rotation/expiry, stale generation/token, wrong instance/protocol, startup failure, and complete cleanup.

- [ ] **IPC adversarial suite passes.**
  - Oversized/truncated/invalid/prototype frames, unknown methods/fields, duplicate ids, auth rebinding, concurrency cap, cancellation, socket loss, bounded sanitized errors.

- [ ] **Companion/setup suite passes.**
  - Self-test, 5-second unavailable-editor behavior, stdio mapping, SIGINT/SIGTERM/stdin close, no caching, prohibited-import checks, argv-safe Node checks, version-range enforcement, JSON path quoting, generic config, no auto mutation, no tokens/credentials.

- [ ] **Policy/confirmation/revocation suite passes.**
  - Disabled/unknown/deleted connections, independent grants, invalid roots, secure defaults, approve/deny/expire/close, warnings, prompt serialization, queued re-evaluation, and immediate cancellation/rejection after every revocation case.

- [ ] **Canonical-path adversarial suite passes.**
  - `/app` vs `/application`, `..`, relative/encoded/NUL input, root equality, broken/internal/external links, outside→inside links, missing nested targets, parent replacement race, cross-root rename.

- [ ] **Direct-IPC bypass suite passes.**
  - Direct calls cannot bypass schemas, grants, confirmation, versions, size limits, or root containment.

- [ ] **Exec suite passes.**
  - Safe-field filtering, stdout/stderr/exit/signal/timeout/cwd quoting, cancellation, per-stream overflow, Unicode, length/NUL rejection, disconnect, confirmation modes.

- [ ] **SFTP suite passes.**
  - List/stat, range/eof, UTF-8/base64 validation, 4 MiB/20 MiB limits, stale/forged/matching/forced versions, create/mkdir/rename conflicts, link/file/recursive delete, cancellation, no link recursion.

- [ ] **Audit/sentinel suite passes.**
  - All outcomes, concurrent append, partial-line recovery, retention, permissions, symlink attacks, pagination/export/clear.
  - Secret/command/file/output sentinels never appear in persisted audit bytes.

- [ ] **Companion→extension→Docker integration passes.**
  - Discovery, exec, ranged read, create/versioned/forced overwrite, mkdir/rename/delete, denial, confirmation approve/deny/expiry, cancellation, disconnect, immediate revocation.

- [ ] **Secret-boundary sentinel suite passes.**
  - Credentials, private keys/paths where prohibited, passphrases, SecretStorage ids, IPC tokens, raw commands, file bodies, stdout/stderr do not appear in unauthorized MCP results/errors, logs, audit, config, discovery, or process arguments.

- [ ] **Run the full engineering gate and record it green.**
  - Formatting, lint, strict typecheck, complete suite, both bundles, package/import checks, Docker/extension integration, all previous milestone checks.

---

## 13. Manual acceptance

- [ ] **Configure and connect one MCP client.**
  - Validate supported/unsupported Node versions, run self-test, generate generic config, connect without automatic config edits.

- [ ] **Verify disabled-policy behavior.**
  - Disabled connection is omitted from discovery.
  - Guessed UUID/direct IPC calls fail without leaking connection/auth details.

- [ ] **Verify read-root containment manually.**
  - List/stat/ranged UTF-8/base64 reads inside one root.
  - Attempt lexical, traversal, encoded, broken-link, and symlink escape cases.

- [ ] **Verify exec manually with default Always Ask.**
  - Approve, deny, expire, cancel, timeout, overflow, and prompt serialization.

- [ ] **Verify versioned writes manually.**
  - Read version → modify externally → stale/forged write fails → matching write succeeds → explicitly confirmed force succeeds on harmless test data.

- [ ] **Verify write mutations manually.**
  - Create, mkdir, rename conflict, link/file delete, strongly confirmed bounded recursive delete on a disposable tree.

- [ ] **Verify revocation manually.**
  - Remove each grant/root and all agent access during queued and active work; confirm immediate cancellation and future rejection.

- [ ] **Verify audit/privacy manually.**
  - View/export/rotate/clear audit.
  - Scan global storage, logs, config, process args, discovery/socket metadata, responses, exports for secret/content sentinels.

- [ ] **Verify editor-close cleanup manually.**
  - Close VSCodium during active work.
  - Companion fails within documented bound; work cancels; no useful discovery/socket, no daemon, audit closes, runtime artifacts disappear.

- [ ] **Smoke-test generic semantics with one MCP client now.**
  - Reserve the required second MCP-capable client cross-check for Milestone 08.

---

## 14. Milestone 07 completion gate

- [ ] Companion has no credential/network authority beyond stdio MCP handling plus authenticated local IPC.
- [ ] Every request is freshly authorized, root-contained where applicable, confirmation-controlled, bounded, cancellable, and metadata-audited.
- [ ] Credentials/private keys never cross IPC/MCP, and raw commands/file bodies never enter persistent audit storage.
- [ ] Discovery, exec, and every declared SFTP tool pass contract, adversarial, and Docker integration tests.
- [ ] Revocation is immediate for queued, active, and future work.
- [ ] Socket/discovery/audit permissions and shutdown cleanup pass on supported Linux environments.
- [ ] All previous milestone workflows/package checks remain green.
- [ ] Every Milestone 07 requirement, risk mitigation, test, documentation item, and non-goal boundary is satisfied with no remaining work.
