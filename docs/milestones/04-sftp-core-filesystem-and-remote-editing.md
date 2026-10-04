# Milestone 04 — SFTP Core, Filesystem, and Remote Editing

## Objective

Implement a reliable reusable SFTP service and writable VS Code `FileSystemProvider` so remote resources behave like first-class editor documents. The critical milestone proof is opening a `remote-sftp:` text document in the normal editor, modifying it, and saving it with `Ctrl+S` while preserving host trust, credential, overwrite, cache, and error invariants.

No custom file editor is permitted. All remote contents flow through the provider and VS Code document model.

## Prerequisites

- Milestones 01–03 exit criteria pass.
- Shared SSH connection creation and credential leases are stable.
- Docker fixture exposes files, directories, symlinks, permissions, large/binary content, disconnect injection, and controllable mtimes.

## Deliverables

- Promise-based SFTP client adapter with normalized domain types and errors.
- Per-connection SFTP pool with reference leases, idle expiry, bounded reconnect, and clean invalidation.
- POSIX-only remote path/URI codec with exhaustive encoding tests.
- Targeted metadata/directory/file caches and invalidation events.
- Writable `remote-sftp` FileSystemProvider implementing all required operations and change events.
- Atomic file writer and basic optimistic remote-change protection.
- Binary/large-file classification and guarded open commands.
- Automated and manual proof of normal-editor read/save behavior.

## Architecture and interfaces

### Remote path and URI invariants

All remote paths are absolute POSIX paths independent of the local OS.

```ts
interface ParsedSftpUri {
  connectionId: string;
  remotePath: string;
}

interface SftpUriCodec {
  create(connectionId: string, remotePath: string): vscode.Uri;
  parse(uri: vscode.Uri): ParsedSftpUri;
}
```

- Scheme is exactly `remote-sftp`; authority is a canonical UUID; path is an encoded absolute POSIX path.
- Reject userinfo, query, fragment, missing/unknown connection ids, NUL, relative paths, and traversal that would escape `/`.
- Normalize repeated separators and `.`; resolve `..` without crossing root. Preserve case and Unicode code points.
- Use `path.posix` only. Never use local `path.join` for remote resources.
- Round-trip spaces, `%`, `#`, `?`, Unicode, leading dots, and nested paths without double encoding.
- URIs never contain usernames, hostnames, credentials, local key paths, or trust fingerprints.

### Domain SFTP adapter

Hide every callback and protocol-specific object behind a narrow Promise API:

```ts
type RemoteEntryKind = 'file' | 'directory' | 'symbolicLink' | 'other';

interface RemoteStat {
  kind: RemoteEntryKind;
  size: number;
  mode?: number;
  uid?: number;
  gid?: number;
  atimeMs?: number;
  mtimeMs: number;
}

interface RemoteDirectoryEntry {
  name: string;
  stat: RemoteStat;
}

interface SftpClient {
  lstat(path: string): Promise<RemoteStat>;
  stat(path: string): Promise<RemoteStat>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readDirectory(path: string): Promise<RemoteDirectoryEntry[]>;
  readFile(path: string, range?: { offset: number; length: number }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: RemoteWriteOptions): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(source: string, target: string, overwrite: boolean): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  close(): Promise<void>;
}
```

- Use `lstat` whenever deciding whether to recurse/delete; never recurse through a symbolic link.
- Validate SFTP attributes for safe integer sizes/times and map unknown modes to `other`.
- Map protocol errors into not found, already exists, permission denied, not directory, is directory, unsupported, connection lost, timeout, and generic remote I/O errors.
- Exactly-once Promise adapters must handle callback, error, end, and close races.

### Pool and leases

```ts
interface SftpLease extends AsyncDisposable {
  readonly connectionId: string;
  readonly client: SftpClient;
  touch(): void;
}

interface SftpConnectionPool {
  acquire(connectionId: string, cancellation?: vscode.CancellationToken): Promise<SftpLease>;
  invalidate(connectionId: string, reason: string): Promise<void>;
  disposeAll(): Promise<void>;
}
```

- Maintain at most one pooled SFTP subsystem/client per connection, separate from all interactive terminal clients.
- Coalesce concurrent initial connects. Each caller receives a ref-counted lease; idle expiry starts only at zero active leases.
- Default idle timeout is 180 seconds and updates from configuration without abandoning active operations.
- A definitive connection-lost error invalidates the pool entry. The next new operation may reconnect once; do not replay a possibly mutating operation automatically.
- Authentication/host-key/permission failures never auto-retry.
- Closing a panel/editor does not close a session still leased by another caller. Extension deactivation cancels work then disposes all entries.

### Version tokens and cache

```ts
interface RemoteVersion {
  mtimeMs: number;
  size: number;
}

interface RemoteFileCache {
  getVersion(uri: vscode.Uri): RemoteVersion | undefined;
  rememberVersion(uri: vscode.Uri, version: RemoteVersion): void;
  invalidatePath(connectionId: string, path: string): void;
  invalidateParent(connectionId: string, path: string): void;
}
```

- Metadata/directory caches use short TTLs only for responsiveness; reads required for conflict decisions bypass stale cache.
- `readFile` records mtime+size from a fresh stat associated with the content read. If stat/read/stat indicates change during read, retry once or return a conflict.
- Before overwriting a previously read document, fresh-stat and compare with its remembered version. Missing/changed metadata prompts Overwrite Remote or Cancel Save.
- After a successful write, fetch fresh stat, update the version, invalidate the parent listing, and emit precise file changes.
- If the server's timestamp granularity prevents certainty, the documented v1 check remains metadata-based; it must never be described as cryptographic versioning.

### Atomic writer

All normal writes use a same-directory temporary name such as `.<name>.easyssh-upload-<random>`.

1. Validate target/options and fresh destination state.
2. Write the entire temp file using exclusive create where supported.
3. Close/flush the remote handle and stat the temp file.
4. If replacing, recheck destination version immediately before commit.
5. Rename temp to target atomically when supported.
6. If the server cannot overwrite by rename, use the least-destructive supported fallback only after the user has authorized overwrite; report the non-atomic limitation.
7. Best-effort unlink the known temp file on failure/cancel, without wildcard cleanup.

Never delete an existing directory to satisfy a file write. Temp names are never exposed as provider change events unless cleanup fails, in which case log only their path at debug level.

### FileSystemProvider contract

Register once with `{ isCaseSensitive: true, isReadonly: false }` and implement:

- `stat`: `lstat` mapping to `vscode.FileStat`; symbolic links include `FileType.SymbolicLink` and applicable base type only when safely known.
- `readDirectory`: one non-recursive listing, filtering `.`/`..`, validating names, stable sorting only at consumers.
- `readFile`: exact bytes with configured inline-size protection enforced by the open command, not corrupting the provider API.
- `writeFile`: honor `create` and `overwrite` precisely, apply conflict rules, use atomic writer, and surface write failure so VS Code retains dirty state where supported.
- `createDirectory`: create one directory; recursive parent creation belongs to higher services.
- `delete`: unlink file/link; delete an empty directory only unless explicit recursive behavior was separately confirmed by browser service.
- `rename`: require same connection authority, honor overwrite, and reject cross-server moves.
- `watch`: return an idempotent no-op disposable; document lack of server-side watch.

Provider methods do not display general UI except the required external-change overwrite decision. Browser-specific destructive prompts live in Milestone 05 services.

Emit minimal events:

- create: target `Created`, parent `Changed`;
- write: target `Changed`, parent `Changed` only if it was newly created;
- delete: target `Deleted`, parent `Changed`;
- rename: old `Deleted`, new `Created`, both distinct parents `Changed`.

Batch related events in one microtask and deduplicate identical URI/type pairs.

### Open behavior, binary detection, and limits

The contributed internal/open command, later called by the browser:

1. stats the resource;
2. if over `maxInlineFileSizeMiB` (default 20), offers Open Anyway, Download, or Cancel;
3. samples at most 8 KiB for NUL/control-byte and UTF-8 validity checks;
4. lets recognized images open through VS Code's normal custom/image handling where supported;
5. for probable binary content offers Download, Open Anyway, or Cancel;
6. opens via `workspace.openTextDocument(remoteUri)` and `showTextDocument(..., ViewColumn.Beside)`.

“Open Anyway” bypasses only that invocation's warning, not global limits or future opens. Download is wired in Milestone 05; until then it reports that the action is unavailable.

## Implementation checklist

- [x] Implement and fuzz-test remote path normalization and URI parsing/creation.
- [x] Add Promise wrappers for SFTP handles, streams/callbacks, and status codes.
- [x] Implement `lstat`, `stat`, `realpath`, `readlink`, listing, range/full read, write, mkdir, rename, unlink, and rmdir.
- [x] Implement SFTP pool entry state machine, ref-counted leases, coalesced connect, timers, invalidation, and deactivation.
- [x] Implement metadata/directory/version caches with narrow invalidation.
- [x] Implement temporary writer, commit/fallback policy, conflict recheck, cancellation, and cleanup.
- [x] Implement provider methods and exact change-event emission.
- [x] Register the `remote-sftp` provider during activation before commands can open remote URIs.
- [x] Implement guarded open command, binary/size classification, normal editor split, and safe errors.
- [x] Add a developer-only/manual command to open a known remote URI before the browser exists.
- [x] Verify all operations acquire/release leases in `finally` and do not retain entire file buffers in caches.

## Automated tests

### Unit tests

- URI round trips for root/nested paths, spaces, `%`, `#`, `?`, Unicode, dot segments, IPv6-like names, malformed authorities, queries/fragments, NUL, and traversal.
- SFTP error mapping and callback/event races.
- Pool concurrent acquire, failed connect, ref counting, idle timer reset, invalidate-on-loss, no mutation replay, and dispose-all.
- Cache TTL, fresh conflict bypass, targeted parent invalidation, and isolation by connection UUID.
- Atomic writer create/overwrite, temp collision retry, disconnect mid-write, cancel, rename unsupported/failure, destination recheck conflict, and cleanup failure.
- File classification for UTF-8, BOM, invalid UTF-8, NUL-heavy binary, images, empty files, and threshold boundaries.
- Every FileSystemProvider method's option/error semantics and exact emitted event sequence.

### Docker integration tests

- List/stat/lstat/read/realpath/readlink for regular files, directories, links, broken links, Unicode names, and permission-denied paths.
- Create/write/overwrite/rename/delete and verify bytes/metadata from a separate SFTP client.
- Simulate mid-upload connection loss and prove the prior destination remains intact where atomic rename is supported.
- Pool reuse across sequential calls, concurrent reads, idle disconnect, forced disconnect, and controlled next-operation reconnect.
- Open a text document through the provider, save it, and verify remote bytes.
- Externally modify the file between read/save and verify Cancel preserves the external content while Overwrite Remote commits the editor content.

## Acceptance tests

The originally manual scenarios are repeatable in the Docker-backed VS Code extension-host suite (`npm run test:acceptance`) and the Docker transport suite (`EASYSSH_RUN_DOCKER=1 npm run test:integration`).

- [x] Exercise root/directory rejection, nested and Unicode text, image, binary, and over-20-MiB guarded-open behavior.
- [x] Open through a writable filesystem provider in the normal editor, select syntax tooling, become dirty, and save through the VS Code save command to the server.
- [x] Modify a file externally before save and exercise both Cancel Save and Overwrite Remote.
- [x] Remove directory write permission, verify save fails with the remote URI/reason, and confirm the editor remains dirty until permission is repaired.
- [x] Edit and save remote documents concurrently through two connection profiles.
- [x] Force disconnect/invalidation and verify bounded next-operation reconnection without mutation replay or retry loops.
- [x] Close editors and verify idle/deactivation cleanup closes all pooled SSH sessions.

## Validation record

- [x] Unit suite: 139 tests passed.
- [x] Docker OpenSSH integration suite: 10 tests passed, including 9 live transport/SFTP cases.
- [x] VS Code extension-host suite: activation, command registration, and Docker-backed normal-editor acceptance passed.
- [x] Typecheck, lint, formatting, production build, and inspected development VSIX packaging passed.

## Exit criteria

- `remote-sftp:` resources are valid first-class VS Code resources with correct provider semantics and events.
- Normal-editor `Ctrl+S` is reliable, atomic where supported, conflict-aware, and never silently overwrites external changes.
- SFTP pooling reduces reconnects without coupling terminals or leaking sessions.
- Link handling cannot cause recursion, and remote paths remain POSIX-correct on all local platforms.
- Binary/large warnings and all read/write/error cases are tested without implementing a custom editor.
- All earlier milestone checks and package smoke tests continue to pass.

## Risks and mitigations

- **SFTP server variation:** isolate extension/vendor behavior inside the adapter and exercise fallback paths explicitly.
- **Provider/UI mismatch:** keep provider semantics deterministic; use separate commands/services for user prompts and recursive actions.
- **False conflict negatives:** document metadata-based detection and always perform a fresh pre-commit stat.
- **Memory pressure:** do not cache bodies; sample classification; warn before editor opens; use streams for local/remote file transfers in later milestones.
- **Stale pool callbacks:** generation-tag pool entries so old close events cannot invalidate a newly connected client.

## Non-goals

- Server-side file watching, three-way merge, content-hash versioning, or Compare UI.
- Recursive delete/download/upload and a polished main-editor browser.
- Chmod/chown, ACL, owner/group editing, remote search, or symlink creation.
- Cross-connection rename/copy or directory synchronization.
