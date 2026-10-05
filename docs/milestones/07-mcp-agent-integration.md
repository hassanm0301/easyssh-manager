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

- [x] **Re-run Milestones 01–06 and record them green.**
  - Exit criteria, human workflows, automated tests, and package checks must all pass before Milestone 07 sign-off.

- [x] **Verify the shared SSH/SFTP layer is ready for MCP use.**
  - Must provide cancellation, canonical paths, safe atomic writes, size/time/concurrency bounds, stable errors, and deterministic disposal.

- [x] **Pin the MCP runtime dependencies exactly.**
  - Pin a compatible official MCP v2 TypeScript SDK.
  - Pin its schema-validation dependency.
  - Define the exact supported Node engine range for the companion.

- [x] **Add Linux IPC permission fixtures to CI.**
  - Cover Unix-domain sockets, `0600` files, `0700` runtime directories, ownership, cleanup, and temp fallback behavior.

---

## 2. Lock the trust boundary

- [x] **Document and enforce this process split.**
  - MCP client → stdio companion → authenticated Unix-domain IPC → extension host → shared SSH/SFTP services → remote server.
  - Companion contains no credential, private-key, host-trust, policy, confirmation, SSH/SFTP, or audit authority.

- [x] **Document the local-user boundary honestly.**
  - Same-user compromise is outside the enforceable security boundary.
  - Filesystem permissions, token auth, per-call policy, and confirmation still protect against accidental/cross-user access.

- [x] **Keep v1 non-goals unavailable.**
  - No interactive MCP shell/PTTY.
  - No attachment to visible terminals or terminal scraping.
  - No TCP/HTTP MCP listener.
  - No remote MCP access.
  - No always-running broker/daemon.
  - No automatic client-config editing.

---

## 3. Build the stdio MCP companion

- [x] **Bundle a separate Node.js companion.**
  - Use the official MCP v2 server package and stdio transport only.
  - Register static tool definitions.
  - Package it with the extension.

- [x] **Prove the companion has no forbidden authority.**
  - Add package/import checks rejecting `vscode`, `ssh2`, SecretStorage/private-key access, direct SSH/SFTP access, TCP/HTTP listeners, or daemon behavior.

- [x] **Keep companion behavior bounded and stateless.**
  - Local schema validation is only fast feedback; extension validation is authoritative.
  - Do not cache connections, policies, or results.
  - Map extension failures to bounded stable MCP errors without stack/cause/IPC internals.

- [x] **Handle companion termination correctly.**
  - SIGINT, SIGTERM, and stdin close cancel outstanding requests and close IPC.

---

## 4. Create per-activation discovery and socket state

- [x] **Generate fresh activation identity.**
  - Fresh instance id.
  - Fresh IPC generation.
  - Cryptographically random 256-bit auth token.
  - Rotate all of them every activation.

- [x] **Create a private Unix-domain socket location.**
  - Prefer a validated user-owned `0700` directory under `$XDG_RUNTIME_DIR`.
  - Use a validated private short-path temp fallback if necessary.
  - Reject unsafe ownership/permissions/path conditions.
  - Never fall back to TCP/HTTP.

- [x] **Write a strict discovery file under extension global storage.**
  - Mode `0600`.
  - Contains only protocol version, instance id, socket path, token, creation time, and expiry.
  - No credentials or long-lived client bearer token.

- [x] **Clean activation artifacts reliably.**
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

- [x] **Authenticate and bind the IPC connection on its first frame.**
  - Validate protocol and instance id.
  - Compare token in constant time.
  - Bind the connection to that identity.
  - Reject later token/instance changes and stale credentials.

- [x] **Bound request concurrency and lifecycle.**
  - Maximum 8 concurrent requests per companion connection.
  - Bound/reject duplicate request ids.
  - Associate every request with an `AbortController`.

- [x] **Propagate cancellation from every required source.**
  - MCP cancellation.
  - Socket close.
  - Agent-access disable.
  - Grant/root removal.
  - Connection deletion.
  - Extension shutdown.

- [x] **Make IPC shutdown ordered.**
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

- [x] **Enforce one exact authorization order for every call.**
  1. Validate MCP input and global bounds.
  2. Freshly resolve connection id.
  3. Freshly load policy and grant.
  4. For SFTP, canonicalize/enforce roots.
  5. Apply confirmation mode.
  6. Execute via shared services with bounds/cancellation.
  7. Append metadata-only audit outcome in `finally`.

- [x] **Make revocation immediate.**
  - Track queued/active work by connection, grant, and root as needed.
  - Disable access, remove grant/root, delete connection, or shutdown → cancel matching queued/active work immediately.
  - All subsequent matching calls fail immediately.

---

## 7. Implement confirmation behavior

- [x] **Implement `always`.**
  - Prompt before every exec call.
  - Prompt before every SFTP mutation.
  - SFTP reads may be grouped only inside one explicit request, never globally approved.

- [x] **Implement conservative `destructive`.**
  - Prompt for all SFTP mutations.
  - Prompt for exec containing or ambiguously composing destructive patterns such as `rm`, `sudo`, redirections, chmod/chown, service/package/database mutation, reboot/shutdown.
  - If uncertain, prompt.

- [x] **Implement `never` only after policy checks.**
  - No per-call prompt after authorization/path checks.
  - Enabling it requires explicit warning confirmation in the editor.

- [x] **Build safe prompts.**
  - Show client label, connection name, tool, safe command summary or exact normalized path/operation, applicable bounds, Approve/Deny.
  - Do not show secrets or file bodies.

- [x] **Bound and serialize prompts.**
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

- [x] **Canonicalize configured roots.**
  - Use SFTP `realpath` when enabling/using policy.
  - Fail closed if canonicalization is unavailable.

- [x] **Protect access to existing resources.**
  - For read/stat/list/delete/rename source: `realpath` the resource and require canonical containment in an allowed root.

- [x] **Protect creation destinations.**
  - For new write/mkdir/rename destination: walk upward using `lstat` to the nearest existing ancestor, `realpath` it, prove containment, then append validated missing segments without following newly appeared links.

- [x] **Recheck immediately before every mutation.**
  - Recheck source and destination containment to resist replacement/symlink races.
  - Rename requires both endpoints inside allowed roots on the same connection.

- [x] **Handle symlinks safely.**
  - Listing/stat may expose link metadata.
  - Read/write/delete through a link only if its canonical target independently remains allowed.
  - Recursive behavior never follows links.

---

## 9. Implement MCP tools

- [x] **Implement `remote_list_connections`.**
  - Empty-object input only.
  - Return enabled UUID/name/host/port/username, effective read/write/exec booleans, and allowed roots.
  - Never return auth details, local key paths, provenance, SecretStorage ids/status, or credentials.

- [x] **Implement bounded non-PTY `ssh_exec`.**
  - Command: 1–32,768 UTF-8 bytes, no NUL.
  - Optional absolute POSIX `cwd`.
  - Timeout default 30,000 ms; max 300,000 ms.
  - Use independent shared SSH exec channel, no PTY.
  - For `cwd`, use safe POSIX `cd -- <single-quote-escaped cwd> && <command>`; never place the command into a local shell/CLI argument.
  - Separate stdout/stderr; each hard-capped at 1 MiB raw.
  - On either overflow: terminate and return `OUTPUT_LIMIT` with observed counts, no partial bodies.
  - Return stdout/stderr/exitCode/signal/timedOut/duration when safely representable; connection failures remain errors.

- [x] **Implement `sftp_list` and `sftp_stat`.**
  - List exactly one directory; bounded name/kind/size/mtime/version metadata.
  - Stat uses `lstat`, reports containment result and opaque metadata version.

- [x] **Implement ranged `sftp_read`.**
  - `utf8` or `base64` only.
  - Optional offset/length.
  - Raw cap 4 MiB.
  - Reject invalid UTF-8 in UTF-8 mode.
  - Return data, encoding, offset, bytesRead, totalSize, eof, opaque version.
  - Version uses connection/path/mtime/size plus per-activation keyed digest so clients cannot forge fields.

- [x] **Implement versioned atomic `sftp_write`.**
  - `utf8` or canonical base64 only.
  - Decoded cap 20 MiB; reject over-limit input before unbounded allocation where possible.
  - Missing file may be created without a version.
  - Existing overwrite requires matching `expectedVersion`.
  - `force: true` bypasses version only after applicable explicit confirmation.
  - Use shared atomic writer and return a fresh opaque version.

- [x] **Implement `sftp_mkdir`, `sftp_rename`, and `sftp_delete`.**
  - mkdir: exactly one missing directory; parents already exist.
  - rename: both endpoints contained, same connection, fresh no-overwrite conflict check.
  - delete: file/link by default; directory only with `recursive: true`, strong confirmation, bounded iterative post-order traversal, cancellation, and no link following.

- [x] **Route every tool through shared services and hard bounds.**
  - Shared connection/auth/host-trust/SFTP services.
  - Stable errors, cancellation, mutation-time policy/path rechecks, targeted cache/provider updates.
  - Bound decoded/encoded sizes, list counts, recursive traversal, frames, concurrency, execution time, and returned errors before unbounded work/allocation.

---

## 10. Implement MCP setup flow

- [x] **Implement `easysshManager.configureMcp`.**
  - Verify packaged companion/discovery paths.
  - Discover or ask for Node without invoking a shell.
  - Spawn `node --version` argv-safely and enforce supported range.
  - Run companion `--self-test`.
  - Confirm before enabling/starting the extension IPC bridge.
  - Generate generic JSON config equivalent to launching `node <absolute-extension-path>/dist/mcp/companion.js --discovery <file>`, with absolute command/argument paths.
  - Allow copy/save on request.
  - Never write a client config automatically.
  - Config contains no credential/token.

- [x] **Implement bounded editor-unavailable behavior.**
  - Missing editor/discovery/socket or stale discovery fails within 5 seconds with actionable instructions to start VSCodium and enable the bridge when appropriate.
  - No orphan process/daemon remains.

---

## 11. Implement metadata-only audit

- [x] **Write bounded JSONL audit records under global storage.**
  - Fields: timestamp, requestId, optional clientLabel, connectionId, connectionNameSnapshot, tool, optional normalized operationTarget, optional keyed commandFingerprint, confirmation, outcome, optional errorCode, durationMs.

- [x] **Keep audit content non-sensitive.**
  - Never persist raw command, stdout/stderr, file data, credential/auth/key data, IPC token, or raw tool/IPC payload.

- [x] **Make audit storage robust.**
  - Serialized appends, mode `0600`, symlink-safe open/rotation, predictable flush/close, partial-final-line recovery.
  - Retain at most 30 days and 10 MiB total.

- [x] **Add audit UI commands.**
  - Paginated sanitized view.
  - Save-dialog export of the same sanitized representation.
  - Clear only after confirmation.

---

## 12. Automated verification

- [x] **Discovery/socket lifecycle suite passes.**
  - Permissions, private fallback, rotation/expiry, stale generation/token, wrong instance/protocol, startup failure, and complete cleanup.

- [x] **IPC adversarial suite passes.**
  - Oversized/truncated/invalid/prototype frames, unknown methods/fields, duplicate ids, auth rebinding, concurrency cap, cancellation, socket loss, bounded sanitized errors.

- [x] **Companion/setup suite passes.**
  - Self-test, 5-second unavailable-editor behavior, stdio mapping, SIGINT/SIGTERM/stdin close, no caching, prohibited-import checks, argv-safe Node checks, version-range enforcement, JSON path quoting, generic config, no auto mutation, no tokens/credentials.

- [x] **Policy/confirmation/revocation suite passes.**
  - Disabled/unknown/deleted connections, independent grants, invalid roots, secure defaults, approve/deny/expire/close, warnings, prompt serialization, queued re-evaluation, and immediate cancellation/rejection after every revocation case.

- [x] **Canonical-path adversarial suite passes.**
  - `/app` vs `/application`, `..`, relative/encoded/NUL input, root equality, broken/internal/external links, outside→inside links, missing nested targets, parent replacement race, cross-root rename.

- [x] **Direct-IPC bypass suite passes.**
  - Direct calls cannot bypass schemas, grants, confirmation, versions, size limits, or root containment.

- [x] **Exec suite passes.**
  - Safe-field filtering, stdout/stderr/exit/signal/timeout/cwd quoting, cancellation, per-stream overflow, Unicode, length/NUL rejection, disconnect, confirmation modes.

- [x] **SFTP suite passes.**
  - List/stat, range/eof, UTF-8/base64 validation, 4 MiB/20 MiB limits, stale/forged/matching/forced versions, create/mkdir/rename conflicts, link/file/recursive delete, cancellation, no link recursion.

- [x] **Audit/sentinel suite passes.**
  - All outcomes, concurrent append, partial-line recovery, retention, permissions, symlink attacks, pagination/export/clear.
  - Secret/command/file/output sentinels never appear in persisted audit bytes.

- [x] **Companion→extension→Docker integration passes.**
  - Discovery, exec, ranged read, create/versioned/forced overwrite, mkdir/rename/delete, denial, confirmation approve/deny/expiry, cancellation, disconnect, immediate revocation.

- [x] **Secret-boundary sentinel suite passes.**
  - Credentials, private keys/paths where prohibited, passphrases, SecretStorage ids, IPC tokens, raw commands, file bodies, stdout/stderr do not appear in unauthorized MCP results/errors, logs, audit, config, discovery, or process arguments.

- [x] **Run the full engineering gate and record it green.**
  - Formatting, lint, strict typecheck, complete suite, both bundles, package/import checks, Docker/extension integration, all previous milestone checks.

Validation record (2026-10-05): `npm run check` passed (240 unit tests, formatting, lint, strict typecheck, bundles, companion import/self-test); its standard integration phase passed the fixture test and skipped ten Docker-dependent tests. After the timing-boundary update, `EASYSSH_RUN_DOCKER=1 npm run test:integration` passed all 11 integration tests. The MCP stdio companion → authenticated Unix IPC → extension-host service → Docker SSH/SFTP path covers discovery, every declared tool, list/stat/ranged UTF-8 and base64 reads, matching/stale/forced writes, mutations, grant denial, prompt approval/denial/60-second expiry, active revocation, a six-second exec, and audit sentinels. The raw direct-IPC suite rejects malformed and unauthorized requests; the audit suite verifies the 10 MiB retained-size cap. VSCodium extension acceptance passed 2 tests; and the production VSIX packaged and passed archive inspection after the timing fix. The companion is exercised over real stdio and authenticated Unix IPC, including fresh results across repeated calls and stale/unreachable discovery rejection. The Docker path caught and fixed an exec response that omitted `signal: null`, which had been rejected by IPC validation. The IPC unavailable timeout now ends once a connection is established, allowing method-specific execution and confirmation deadlines to govern connected calls.

Manual acceptance status (2026-10-06): An isolated X11 VSCodium session loaded the extension. The disposable `MCP acceptance fixture` connection passed the editor's SSH/SFTP Test Connection flow, including access to its configured default path. A generic MCP client initialized, listed all tools, and called `remote_list_connections`; scoped SFTP reads, path denials, writes, mutations, audit viewing, policy disable/future-call rejection, and supported/unsupported Node selection were also exercised live. An active `sleep 120` request canceled on editor close, returned `UNAVAILABLE` to the client, and left no remote process; discovery artifacts were removed. A Docker integration assertion now checks that active revocation also leaves no remote `sleep` process.

---

## 13. Manual acceptance

- [x] **Configure and connect one MCP client.**
  - [x] Fixture connection test: SSH authentication, SFTP subsystem, and configured default remote path succeeded for the disposable local fixture.
  - [x] Supported Node.js (26.10.0) passed the extension's companion self-test; the generated generic configuration connected and initialized a client without editing client configuration files.
  - [x] Unsupported Node.js (20.19.0) was rejected by the editor's Configure MCP flow.
  - Validate supported/unsupported Node versions, run self-test, generate generic config, connect without automatic config edits.

- [x] **Verify disabled-policy behavior.**
  - [x] Disabling all agent access removed the fixture from discovery and rejected a later SFTP call with `POLICY_DISABLED`.
  - [x] Guessed UUID and direct-IPC bypass cases are covered by the IPC adversarial and bypass suites; errors omit connection/auth details.

- [x] **Verify read-root containment manually.**
  - [x] List/stat and full UTF-8 plus ranged base64 reads inside the fixture root returned expected metadata and content.
  - [x] Reading the fixture's parent directory was rejected with `PATH_NOT_ALLOWED`.
  - [x] Lexical traversal and a symlink to `/etc/passwd` were rejected with `PATH_NOT_ALLOWED`; encoded traversal and a broken link returned bounded `NOT_FOUND` errors without file content.
  - Attempt lexical, traversal, encoded, broken-link, and symlink escape cases.

- [x] **Verify exec with default Always Ask.**
  - [x] An approved `pwd` ran in the fixture root; its audit row records confirmation mode `always`.
  - [x] Automated exec coverage verifies approval, denial, expiry, cancellation, timeout, overflow, and serialized prompts.

- [x] **Verify versioned writes.**
  - [x] Read version → modify externally → stale write fails with `STALE_VERSION` → matching write succeeds.
  - [x] Forced overwrite on harmless fixture data passes the Docker integration suite.

- [x] **Verify write mutations.**
  - [x] Created directories, renamed a file, rejected a conflicting rename, deleted a file, and recursively deleted a disposable test tree.
  - [x] Automated mutation coverage verifies symlink unlink, file delete, and bounded, confirmed recursive delete without following links.

- [x] **Verify revocation.**
  - [x] Disabling all agent access removed the connection from discovery and rejected a subsequent SFTP call with `POLICY_DISABLED`.
  - [x] Docker integration revokes policy during active `ssh_exec`, returns `CANCELLED`, and verifies no remote `sleep` process survives.
  - [x] Automated policy tests remove individual grants/roots and all access during queued and active work, then verify immediate cancellation and future rejection.

- [x] **Verify audit/privacy.**
  - [x] Viewed the live audit in the editor; it contained metadata/outcomes, and the stored JSONL had no executed-command or file-content sentinels.
  - [x] Automated audit coverage verifies sanitized view/export, confirmed clear, rotation, permissions, retention, and content sentinels.
  - [x] Secret-boundary tests scan logs, config, process args, discovery/socket metadata, responses, exports, and audit bytes for secret/content sentinels.

- [x] **Verify editor-close cleanup.**
  - [x] After closing the temporary editor, discovery and socket artifacts disappeared and a stale generic client failed with `UNAVAILABLE` immediately; the audit scan found no command/file-content sentinels.
  - [x] Closing the editor during active `ssh_exec` returned `UNAVAILABLE`, terminated the remote command, and removed its discovery/socket artifacts.
  - [x] The companion fails within the documented bound; active work cancels; no daemon or useful runtime artifacts remain.

- [x] **Smoke-test generic semantics with one MCP client now.**
  - Initialized the generic client, listed all nine tools, and successfully called `remote_list_connections`.
  - Reserve the required second MCP-capable client cross-check for Milestone 08.

Validation record (2026-10-06): Final `npm run check` passed with 242 unit tests, formatting, lint, strict typecheck, standard integration, production bundles, and companion checks. The Docker-backed integration suite passed all 11 tests; its MCP active-revocation case also verified that the remote command process exits. A transient Docker host-key test failure on one run passed on immediate suite rerun. `npm run package` produced and inspected `artifacts/easyssh-manager.vsix`; `npm run test:acceptance` passed all five extension acceptance tests.

---

## 14. Milestone 07 completion gate

- [x] Companion has no credential/network authority beyond stdio MCP handling plus authenticated local IPC.
- [x] Every request is freshly authorized, root-contained where applicable, confirmation-controlled, bounded, cancellable, and metadata-audited.
- [x] Credentials/private keys never cross IPC/MCP, and raw commands/file bodies never enter persistent audit storage.
- [x] Discovery, exec, and every declared SFTP tool pass contract, adversarial, and Docker integration tests.
- [x] Revocation is immediate for queued, active, and future work.
- [x] Socket/discovery/audit permissions and shutdown cleanup pass on supported Linux environments.
- [x] All previous milestone workflows/package checks remain green.
- [x] Every Milestone 07 requirement, risk mitigation, test, documentation item, and non-goal boundary is satisfied with no remaining work.
