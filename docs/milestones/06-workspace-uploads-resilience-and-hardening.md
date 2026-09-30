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

## Implementation checklist

- [ ] Add Workspace pane markup, accessibility behavior, empty/no-workspace/untrusted states, and lazy expansion.
- [ ] Implement URI authorization registry scoped to panel generation and current workspace roots.
- [ ] Implement trust/root/provider change handling and host-side enforcement.
- [ ] Add selection and HTML5 drag/drop payloads entirely within the webview.
- [ ] Implement UploadPlanner with containment, ancestor deduplication, link skipping, empty folders, depth/count caps, cancellation, and size accounting.
- [ ] Implement operation-local directory/file conflict state machines and serialized prompts.
- [ ] Implement streaming local and bounded-buffer virtual readers feeding the atomic remote writer.
- [ ] Add bounded scheduler/backpressure, progress, cancellation, cleanup, event/cache invalidation, and transfer summaries.
- [ ] Wire drop targets plus Upload Files/Folder actions from toolbar/context/command palette.
- [ ] Add optional Explorer-drop capability only behind positive stable-runtime detection.
- [ ] Audit pools, terminals, panels, providers, timers, requests, streams, credential leases, and webview listeners for deterministic disposal.
- [ ] Run complete human-workflow end-to-end scenarios and fix regressions before MCP work begins.

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
