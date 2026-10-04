# Milestone 06 — Workspace Uploads, Resilience, and Hardening

## Objective

Complete the human-facing v1 workflow by adding a lazy Workspace pane and reliable workspace-to-remote file/folder uploads. Consolidate transfer planning, conflict policy, progress, cancellation, atomic commits, reconnect boundaries, and resource disposal so common failures leave understandable and recoverable state.

The supported drag path is entirely inside the SFTP webview. Dragging from the built-in Explorer may be added only as a convenience and cannot be an acceptance dependency.

## Prerequisites

- Milestones 01–05 exit criteria pass.
- SFTP browser exposes stable protocol/selection/context actions.
- Atomic remote writer, download conflict model, caches, provider events, and workspace-trust declaration exist.

## Deliverables

- Lazy, multi-root Workspace pane backed only by `vscode.workspace.workspaceFolders` and `vscode.workspace.fs`.
- Typed, host-validated workspace-item drag payload and explicit Upload Files/Upload Folder commands.
- Iterative upload planner supporting files, folders, empty directories, multiple selections, and virtual workspaces.
- File and directory conflict decisions scoped to one operation.
- Atomic upload executor with streaming/buffering strategy, progress, cancellation, cleanup, and change events.
- Explicit untrusted-workspace restrictions and trust-change behavior.
- Cross-subsystem resilience pass: reconnect bounds, concurrency, cache invalidation, shutdown, performance, and end-to-end human workflow tests.

## Architecture and interfaces

### Workspace pane protocol

The webview never reads workspace data. It receives opaque URI strings only after the extension host enumerates a known workspace root.

```ts
interface WorkspaceRootView {
  name: string;
  uri: string;
}

interface WorkspaceEntryView {
  name: string;
  uri: string;
  kind: 'file' | 'directory' | 'symbolicLink' | 'other';
}

interface WorkspaceDragPayload {
  type: 'workspace-items';
  uris: string[];
}
```

- List only current `workspaceFolders` at pane initialization; list a directory's immediate children only after expansion.
- Use `vscode.workspace.fs.stat/readDirectory/readFile` for all schemes. Use Node filesystem streams only after confirming `uri.scheme === 'file'`.
- Host-side URI authorization requires each selected URI to be equal to or a descendant of a current workspace folder under URI-aware scheme/authority/path comparison.
- Reject query/fragment changes, unknown schemes/providers, duplicate selections, ancestor+descendant duplicate roots, NUL, excessive item counts, and URIs not previously returned to this panel generation.
- Webview drag payloads are hints, not authority. Re-stat each resource immediately before planning/reading.
- Refresh/invalidate workspace nodes on workspace-folder changes and relevant `workspace.fs` watcher events where available; correctness never depends on watchers.

### Workspace Trust

- If `workspace.isTrusted` is false, render a disabled Workspace pane explaining that connection management and direct SSH/SFTP remain available but local workspace browsing/uploads require trust.
- Reject upload messages/commands again in the extension host with a stable `WORKSPACE_UNTRUSTED` error.
- On trust grant, initialize roots without requiring panel recreation.
- If trust becomes unavailable or roots change, cancel not-yet-committed planning, clear issued URI authorizations, and refresh the pane. Already committed remote files are reported, not rolled back.
- Never prompt users to trust automatically as a side effect of opening SFTP.

### Upload planning

```ts
interface UploadPlan {
  operationId: string;
  connectionId: string;
  targetDirectory: string;
  roots: UploadSourceRoot[];
  entries: UploadPlanEntry[];
  totalFiles: number;
  totalBytes?: number;
}

type UploadPlanEntry =
  | { kind: 'directory'; source: vscode.Uri; targetPath: string }
  | { kind: 'file'; source: vscode.Uri; targetPath: string; size: number };
```

- Drop on a remote directory uploads inside it. Drop on a file targets that file's parent. Empty-space drop targets the currently displayed directory.
- Preserve each selected root basename and relative hierarchy. Normalize every derived remote target and prove it is a descendant of the chosen target directory.
- Traverse directories iteratively and lazily enough to remain cancellable. Do not use recursive call stacks.
- Inspect `FileType.SymbolicLink` before directory bits; skip links with a final summary. Never resolve/recurse them.
- Preserve empty directories.
- Remove descendant selections when an ancestor directory is also selected so content is not uploaded twice.
- Default caps: 100,000 entries and a maximum normalized relative-path depth of 256. Crossing a cap aborts before mutation and explains the limit.
- Local file sizes contribute to byte progress when known. Unknown/changed sizes remain valid but progress must not claim precise bytes.

### Conflict policy

```ts
type FileConflictDecision =
  | 'overwrite'
  | 'overwriteAll'
  | 'skip'
  | 'skipAll'
  | 'cancel';

type DirectoryConflictDecision = 'merge' | 'mergeAll' | 'skip' | 'skipAll' | 'cancel';
```

- Preflight remote targets with `lstat`; recheck each destination immediately before commit because preflight is not a lock.
- A missing directory is created. An existing directory requires Merge/Skip/Cancel unless a current-operation `mergeAll` exists.
- Merge never deletes destination entries and file conflicts inside still require their own decision.
- A file-file collision requires Overwrite/Skip/Cancel unless the operation holds an applicable all decision.
- File-vs-directory or directory-vs-file collisions are type conflicts: Skip or Cancel only in v1. Never delete one kind to replace it with another.
- “All” choices live only inside `UploadOperation`; never persist them and never apply them to later operations.
- Cancel stops scheduling new work, lets the currently committing atomic unit settle safely, cleans its temp, and returns completed/skipped/failed counts.

### Upload execution

```ts
interface UploadService {
  uploadWorkspaceItems(input: {
    connectionId: string;
    sourceUris: vscode.Uri[];
    targetRemotePath: string;
    cancellation: vscode.CancellationToken;
  }): Promise<TransferSummary>;
}
```

- Process directory creation in parent-before-child order and files with bounded concurrency defaulting to 3 per SFTP connection.
- Serialize conflict prompts and commits targeting the same path. Never show overlapping modal prompts for one operation.
- For `file:` sources, prefer Node read streams into an SFTP write stream/temp file, respecting backpressure and cancellation.
- For virtual sources, `workspace.fs.readFile` is allowed only when size is at or below `maxBufferedTransferMiB` (default 64 MiB). Reject larger virtual resources before allocation with an actionable message.
- Upload to the atomic writer's same-directory temp file. Verify bytes written/remote temp size when available, fresh-check the destination, then rename commit.
- Do not automatically replay a failed mutation after reconnect. A failure summary allows the user to retry the entire consciously selected upload later.
- Invalidate destination-parent caches and emit provider events after each committed file/directory; coalesce burst refresh messages to the panel.
- Progress reports current relative path, completed/total files, and bytes when known through `window.withProgress({ cancellable: true })`.
- A transfer summary distinguishes uploaded, created directories, merged, skipped, skipped links, failed, cancelled, and cleanup warnings.

### Explicit upload commands and optional Explorer drops

- **Upload Files...** uses `showOpenDialog({ canSelectFiles: true, canSelectMany: true })` and targets the current/selected remote directory.
- **Upload Folder...** uses `showOpenDialog({ canSelectFolders: true })` and the same service.
- Picker-selected resources outside current workspace roots are permitted only through these explicit commands and only after the host picker returns them; they never become webview-authorized drag URIs.
- If direct Explorer-to-webview data transfer is supported reliably by the current stable API/browser, translate it into validated URIs and route it through the same service. Hide/ignore it when unavailable; do not add proposed API dependencies.

### Cross-subsystem resilience

- Centralize per-connection operation accounting so pool disposal never interrupts active reads/writes.
- Limit concurrent list/read/write operations and queue with cancellation; prevent one large upload from starving an editor save.
- Give editor writes and interactive user navigation higher scheduling priority than background batch transfers.
- Generation-tag pool/cache/panel state; callbacks from invalidated clients cannot mutate new state.
- All timers are owned by disposable services and use bounded delays. Deactivation first rejects new work, cancels batches, closes panels/terminals, drains safe commits for a short bounded interval, then destroys pools.
- User Refresh always reaches the server. Transfer commits invalidate exact target and parent entries only.
- Never recursively enumerate an entire workspace or server at panel open.

## Milestone completion checklist

This checklist is the authoritative completion gate for Milestone 06. Check an item only after its implementation and applicable tests/evidence satisfy the detailed requirements below. The milestone is complete only when every item is checked; no implementation, test, documentation, or verification work described by this milestone may remain.

### Entry gate and contracts

- [ ] Re-run and record all Milestones 01–05 exit criteria, tests, and package checks as passing before starting the Milestone 06 completion sign-off.
- [ ] Verify the SFTP browser protocol/selection/actions, atomic remote writer, download conflict model, provider events, caches, and workspace-trust declaration expose every behavior required by this milestone.
- [ ] Define and runtime-validate the `WorkspaceRootView`, `WorkspaceEntryView`, `WorkspaceDragPayload`, `UploadPlan`, `UploadPlanEntry`, conflict-decision, `UploadService`, and `TransferSummary` contracts with explicit size/count limits.
- [ ] Keep workspace enumeration, URI authorization, source reads, policy decisions, conflict prompts, and remote mutations in the extension host; treat every webview payload as an untrusted hint.

### Workspace pane, authorization, and trust

- [ ] Add an accessible multi-root Workspace pane with no-workspace, empty-directory, loading, provider-error, and untrusted states using only current `workspace.workspaceFolders`.
- [ ] Load roots at initialization and immediate children only on expansion; never recursively enumerate a workspace or remote server when the panel opens.
- [ ] Use `workspace.fs.stat/readDirectory/readFile` for every scheme and permit Node filesystem streams only after an exact `file:` scheme check.
- [ ] Implement panel-generation-scoped URI authorization for values actually issued by the host, with URI-aware scheme/authority/path containment under a current workspace root.
- [ ] Reject unknown/revoked URIs, unavailable providers, query/fragment mutation, NUL/encoded separator tricks, excessive selections, duplicates, and ancestor-plus-descendant duplicate roots.
- [ ] Freshly re-stat every authorized resource immediately before planning and reading so drag payloads never become authority.
- [ ] Refresh/invalidate affected workspace nodes on root changes and available filesystem watcher events while preserving explicit refresh correctness when watchers are absent or late.
- [ ] Render an explanatory disabled Workspace pane when the workspace is untrusted while leaving connection management, SSH, and direct remote SFTP browsing usable.
- [ ] Enforce `WORKSPACE_UNTRUSTED` again for every upload message/command in the extension host and never prompt for trust merely because the SFTP panel opened.
- [ ] Initialize roots in-place after trust is granted; on trust/root loss, cancel uncommitted planning, revoke issued URI authorizations, refresh the pane, and truthfully report already committed remote work.
- [ ] Implement accessible workspace selection and typed internal HTML5 drag payloads without exposing arbitrary local paths or accepting raw webview URI authority.

### Upload planning and targeting

- [ ] Resolve drop targets so a remote directory receives children, a remote file uses its parent, and empty space uses the currently displayed remote directory.
- [ ] Preserve every selected root basename, relative hierarchy, and empty directory in the upload plan.
- [ ] Normalize every derived remote target and prove segment-aware containment beneath the chosen destination before any mutation.
- [ ] Traverse source directories iteratively and cancellably without recursive call stacks, inspecting symbolic-link bits before directory bits.
- [ ] Skip and report symbolic-link files/directories and unsupported resource types without resolving, recreating, or traversing them.
- [ ] Deduplicate repeated selections and remove descendant roots selected beneath an ancestor directory so no content uploads twice.
- [ ] Enforce the default 100,000-entry and 256-level normalized-depth caps before mutation with actionable limit errors.
- [ ] Compute file/byte totals when source metadata permits and downgrade progress truthfully when sizes are unknown or change.
- [ ] Detect source deletion/type/size changes during planning/execution and produce a precise skip/failure result without unsafe fallback behavior.

### Conflict policy and upload execution

- [ ] Preflight remote targets with `lstat` and fresh-check every destination immediately before its atomic commit.
- [ ] Implement operation-local Merge, Merge All, Skip, Skip All, and Cancel handling for directory collisions without deleting existing destination content.
- [ ] Implement operation-local Overwrite, Overwrite All, Skip, Skip All, and Cancel handling for file collisions.
- [ ] Treat file-versus-directory and directory-versus-file as Skip-or-Cancel type conflicts only; never delete one kind to replace it.
- [ ] Serialize conflict prompts and work targeting the same remote path, prevent prompt storms, and discard all “All” decisions when the operation ends.
- [ ] Create directories in parent-before-child order and schedule files with a per-connection bounded concurrency default of three.
- [ ] Stream `file:` sources through backpressure-aware, cancellable local read and SFTP temp-write streams.
- [ ] For virtual sources, preflight the default 64 MiB `maxBufferedTransferMiB` bound before `workspace.fs.readFile` allocation and return actionable errors above the limit.
- [ ] Write each file through the same-directory atomic temp writer, verify written bytes/temp size when available, recheck the destination, and commit by rename.
- [ ] Stop scheduling on cancellation, allow the current atomic unit to settle safely, clean its tracked temp artifact, retain prior committed work, and avoid claiming rollback.
- [ ] Never automatically replay a failed or ambiguous mutation after reconnect; require a consciously initiated retry.
- [ ] Invalidate exact destination/parent cache entries and emit precise provider events after each committed file/directory while coalescing burst panel refreshes.
- [ ] Report cancellable progress with current relative path, completed/total files, and bytes only when known accurately.
- [ ] Return a truthful summary separating uploaded files, created directories, merges, skips, skipped links, failures, cancellation, and cleanup warnings.

### Commands, drag/drop, and resilience

- [ ] Wire internal pane drops and Upload Files/Upload Folder actions from the toolbar, valid context menus, and command palette to the same `UploadService`.
- [ ] Implement Upload Files with a multi-file picker and Upload Folder with a folder picker, using the current/selected remote directory as the target.
- [ ] Permit picker-returned resources outside workspace roots only for that explicit command invocation and never add them to the panel's reusable drag authorization set.
- [ ] Support built-in Explorer-to-webview drops only when positively detected through stable APIs; hide/ignore the capability otherwise and introduce no proposed-API dependency.
- [ ] Centralize per-connection operation accounting so disposing an idle pool owner cannot interrupt active reads, writes, saves, or transfers.
- [ ] Bound and cancellably queue list/read/write work, serialize identical destinations, and prioritize editor saves and interactive navigation above batch upload work.
- [ ] Generation-tag pool, cache, authorization, and panel state so callbacks from invalidated clients/generations cannot mutate current state.
- [ ] Ensure user Refresh reaches the server and transfer commits invalidate only exact targets and parents rather than flushing unrelated state.
- [ ] Make every timer/service disposable with bounded delays and implement deactivation ordering: reject new work, cancel batches, close panels/terminals, briefly drain safe commits, then destroy pools.
- [ ] Audit pools, terminals, panels, providers, requests, streams, temp trackers, credential leases, timers, watchers, and webview listeners for deterministic cleanup.

### Automated verification

- [ ] Add workspace-pane tests for multi-root/duplicate names, root add/remove, lazy expansion, empty/Unicode/inaccessible folders, no eager recursion, and watcher-independent refresh.
- [ ] Add URI authorization tests across schemes/authorities for segment containment, prefix confusion, encoded separators, query/fragment mutation, duplicate/ancestor selections, unknown/revoked generations, and picker-only external resources.
- [ ] Add workspace-trust tests for disabled UI, command/message rejection, trust-grant initialization, and trust/root/provider removal during planning.
- [ ] Add planner tests for individual/multiple files, deep and empty directories, hierarchy/basename preservation, changed/deleted sources, links/other types, deduplication, cancellation, entry/depth limits, and remote containment.
- [ ] Add conflict tests for every file/directory decision, operation-scoped “All” behavior, type collisions, destination races, serialized prompts, cancellation, and merge preservation of unrelated remote content.
- [ ] Add executor tests for local streaming/backpressure, virtual reads at and beyond the buffer limit, zero/large/Unicode files, source/permission/disconnect failures, byte/temp verification, destination recheck, and cleanup.
- [ ] Add scheduling tests for concurrency bounds, per-path serialization, editor-save/navigation priority, cancellation safe points, no automatic replay, progress accuracy, and truthful summaries.
- [ ] Add provider/cache tests proving exact events and invalidations for directory/file creation and overwrite, including coalesced panel refreshes and stale-generation rejection.
- [ ] Add end-to-end Docker/extension tests covering connection CRUD/reorder, SSH terminal, SFTP navigate/edit/save, download, file/nested-folder upload, every collision class, cancellation, disconnect/manual retry, and editor shutdown.
- [ ] Add deactivation leak assertions proving all managed clients, channels, streams, temp trackers, timers, watchers, panels, requests, and credential leases return to zero.
- [ ] Add performance/memory smoke tests for synthetic 10,000-entry workspace and remote directories, bounded rendering/processing, and absence of startup recursion.
- [ ] Run the complete automated suite plus formatting, lint, typecheck, build, package-content, secret-leak, and all previous milestone checks and record all results as passing.

### Manual acceptance and completion gate

- [ ] Verify single-root and multi-root workspaces expand only requested directories and handle duplicate root names, empty folders, unavailable providers, and root changes.
- [ ] Drag one file, multiple files, an empty folder, and a nested folder from the Workspace pane to current-directory, directory-row, and file-row targets and verify exact hierarchy.
- [ ] Repeat uploads to exercise Merge, Merge All, Overwrite, Overwrite All, Skip, Skip All, Cancel, and both type-conflict directions without destination-tree replacement.
- [ ] Cancel during planning and mid-upload; verify valid completed files, preserved prior versions, honest summaries, and no avoidable temp artifacts.
- [ ] Upload a large local `file:` source and virtual-workspace resources below, at, and above the buffering limit while observing accurate progress and memory bounds.
- [ ] Include source symlinks and unsupported entries and verify they are reported/skipped without target traversal or materialization.
- [ ] Repeat uploads through file/folder pickers and prove external picker resources do not become generally authorized to the webview.
- [ ] Toggle workspace trust and roots during use and verify uploads/authorizations stop or initialize correctly while direct SSH/SFTP features remain available.
- [ ] Disconnect during upload, reconnect manually, retry explicitly, and confirm there was no automatic mutation replay.
- [ ] Close/reload/deactivate VSCodium during active operations and verify bounded safe shutdown, truthful partial results, zero leaked resources, and safe remote/temp state.
- [ ] Run the complete human v1 workflow against Docker and a non-production Linux SSH host, including connection management, auth/trust, terminal, remote editing, download, upload, reconnect, and shutdown.
- [ ] Confirm no credential, private-key content, local/remote file body, or unauthorized URI appears in webview state, logs, errors, transfer summaries, tests, or package artifacts.
- [ ] Re-run every previous milestone gate and confirm every Milestone 06 deliverable, exit criterion, risk mitigation, and stated non-goal boundary is satisfied with no remaining implementation, test, documentation, or verification task before MCP work begins.

## Automated tests

### Workspace/authorization tests

- Multi-root rendering, duplicate root names, add/remove roots, lazy expansion, empty folders, Unicode, inaccessible providers, and watcher-independent refresh.
- URI containment across schemes/authorities, prefix-confusion paths, encoded separators, query/fragment mutation, revoked generations, unknown URIs, ancestor deduplication, and non-workspace picker authorization.
- Untrusted view state, command/message rejection, trust grant initialization, and trust/root removal during planning.

### Planner/conflict tests

- Files, deep/empty directories, multiple roots, duplicate selections, files changed/deleted during planning, symbolic-link files/directories, other types, entry/depth cap, cancellation, and remote target containment.
- File and directory conflicts, each decision, operation-scoped All behavior, type collisions, concurrent destination change, prompt serialization, and cancellation.
- Merge preserves unrelated remote content and never calls recursive delete.

### Executor tests

- Local streaming backpressure, virtual buffered reads at/beyond limit, zero-byte files, large files, Unicode bytes, source read failure, remote permission failure, disconnect, temp cleanup, and destination recheck.
- Concurrency bound, per-path serialization, priority for editor save, progress accuracy, cancelled safe boundary, and truthful summary.
- Exact provider events/cache invalidations for new directories/files and overwrites.
- No automatic replay after ambiguous mutation failure.

### End-to-end tests

- Create/edit/delete/reorder connection, SSH terminal, SFTP navigate/edit/save, download, file upload, nested folder upload, collisions, cancellation, reconnect, and editor shutdown.
- Verify all extension-managed clients, channels, streams, temp trackers, timers, panels, and credential leases reach zero after deactivation.
- Memory/performance smoke test with a synthetic 10,000-entry workspace directory and remote listing without startup recursion.

## Manual acceptance tests

1. Open a single-root and multi-root workspace; expand only selected directories and confirm no eager full-tree enumeration.
2. Drag one file, multiple files, an empty folder, and a nested folder from the Workspace pane to current and row-specific remote directories.
3. Repeat uploads and exercise Merge, Merge All, Overwrite, Overwrite All, Skip, Skip All, Cancel, and type conflicts.
4. Cancel planning and mid-upload; inspect remote destinations for valid completed files, preserved previous versions, and no avoidable temp files.
5. Upload a large local `file:` resource and a virtual resource around the buffering threshold.
6. Include symlinks in a source tree and verify they are reported/skipped without target traversal.
7. Repeat through explicit file/folder pickers and confirm external picker resources do not become generally authorized in the webview.
8. Mark the workspace untrusted and verify Workspace pane/uploads stop while saved connections, SSH terminals, and remote SFTP browsing remain usable.
9. Disconnect during upload, reconnect manually, retry, then close VSCodium during active operations and inspect cleanup.

## Exit criteria

- Workspace pane is lazy, multi-root, virtual-filesystem aware, accessible, and trust-aware.
- Supported in-webview drag/drop and explicit picker workflows both use one validated upload service.
- Recursive uploads preserve hierarchy/empty directories, never follow links, and never silently overwrite or replace directories.
- Streaming/buffering, conflicts, progress, cancellation, atomic commit, cleanup, caches, and change events behave deterministically.
- Full human v1 workflow passes end to end against Docker and a non-production Linux SSH host.
- Resource-leak, performance, secret-leak, and all prior milestone gates pass.

## Risks and mitigations

- **Malicious webview URI:** require issued-URI authorization plus current root containment and fresh stat.
- **Large virtual resource memory:** preflight size and hard-reject above configurable buffering limit.
- **Partial batch semantics:** commit each file atomically, never claim rollback, and return exact completed/skipped/failed state.
- **Concurrency corrupting targets:** serialize per destination and fresh-check immediately before rename.
- **Editor API drag regressions:** make internal pane drag/drop and explicit pickers the only required paths.

## Non-goals

- Bidirectional sync, watch-based mirroring, remote-to-workspace drag/drop, or automatic retry/resume.
- Following, recreating, or dereferencing symbolic links.
- Uploading from arbitrary paths supplied as webview strings.
- Replacing destination directory trees, delta transfer, compression, SCP, or permission preservation.
