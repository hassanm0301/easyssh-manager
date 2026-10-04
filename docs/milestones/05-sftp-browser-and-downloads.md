# Milestone 05 — SFTP Browser and Downloads

## Objective

Deliver the secure main-editor SFTP browser for remote navigation and human-initiated remote operations. The browser must remain visible while a selected file opens beside it through the `remote-sftp` provider. It also adds safe file and recursive-directory downloads to a user-selected local/workspace destination.

The browser is a presentation surface only: it sends identifiers and intent, while the extension host re-resolves the connection, validates paths/state, prompts, performs operations, and returns sanitized view models.

## Prerequisites

- Milestones 01–04 exit criteria pass.
- SFTP pool, path codec, FileSystemProvider, atomic writer, domain errors, and guarded open command are stable.
- Webview build can enforce strict CSP with no inline script, remote resource, `eval`, or Node access.

## Deliverables

- One restorable `SftpPanel` per connection managed by `SftpPanelManager`.
- Secure typed webview protocol, navigation model, accessible two-state-ready layout, and connection status.
- Remote directory listing, breadcrumb/back/forward/up/refresh, sorting, activation, and open-beside behavior.
- Context/toolbar actions for create, rename, delete, copy path, download, upload entry points, and refresh.
- Recursive remote delete service with strong confirmation and no symlink traversal.
- File and directory download service with local conflict decisions, safe temporary writes, progress, cancellation, and cleanup.
- Tests for restoration, stale requests, unsafe input, remote changes, and user-visible failures.

## Architecture and interfaces

### Panel ownership and restoration

```ts
interface SftpPanelState {
  version: 1;
  connectionId: string;
  currentPath: string;
  historyBack: string[];
  historyForward: string[];
  sort: { key: 'name' | 'size' | 'mtime'; direction: 'asc' | 'desc' };
}
```

- Key panels by connection UUID. Open SFTP reveals the existing panel; it does not create duplicates.
- Title is `SFTP: <connection name>` and updates after a rename.
- Serialize only validated non-secret navigation state. On restore, re-resolve the connection and normalize every path; discard invalid/outdated history.
- Disposing a panel cancels its pending request controllers and releases its leases, but does not close provider operations/editors using the same pool.
- Deleting a connection closes its panel after confirmation and leaves already open provider documents to fail clearly on their next operation.

### Webview security and protocol

Use a per-render nonce and CSP resembling:

```text
default-src 'none';
img-src <webview-source> data:;
style-src <webview-source>;
script-src 'nonce-<nonce>';
font-src <webview-source>;
```

No remote URLs, inline event handlers, unsafe-eval, or dynamic HTML injection. Render names/errors with `textContent`; use static templates for structure.

```ts
type SftpRequest =
  | { requestId: string; type: 'list'; path: string; force: boolean }
  | { requestId: string; type: 'navigate'; path: string }
  | { requestId: string; type: 'open'; path: string }
  | { requestId: string; type: 'createFile'; parentPath: string; name: string }
  | { requestId: string; type: 'createDirectory'; parentPath: string; name: string }
  | { requestId: string; type: 'rename'; path: string; newName: string }
  | { requestId: string; type: 'delete'; path: string }
  | { requestId: string; type: 'download'; paths: string[] }
  | { requestId: string; type: 'copyPath'; path: string };

interface SftpResponse<T> {
  requestId: string;
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; retryable: boolean };
}
```

- Runtime-validate exact union shapes and cap strings/arrays before lookup.
- Ignore any message-supplied connection id; bind all work to the panel's host-side connection id.
- Treat paths as untrusted, normalize through the codec, and verify child names contain no `/`, NUL, `.` or `..`.
- Associate each list/navigation request with a monotonically increasing generation. A late response cannot replace a newer directory view.
- Cancellation/stale responses complete their promises without global loading-state corruption.

### Remote view model and navigation

The extension returns only display data:

```ts
interface RemoteEntryView {
  name: string;
  path: string;
  kind: RemoteEntryKind;
  size?: number;
  mtimeMs?: number;
  linkTarget?: string;
}
```

- List one directory at a time. Never recurse or preload descendants.
- Breadcrumb segments navigate exact ancestor paths. Root's Up action is disabled.
- Back/forward stacks deduplicate consecutive paths and cap at 100 entries.
- Refresh always bypasses directory cache. Mutation success invalidates and refreshes only affected parents.
- Default sort is directories first then locale-aware name ascending. User sort key/direction persists in panel state; symbolic links/other entries form stable groups.
- Double-click/Enter on a directory navigates. A link is shown distinctly and only navigated/opened after an explicit single-resource operation resolves its target; recursive actions never follow it.
- Double-click/Enter on a file calls the guarded open command with `ViewColumn.Beside`, preserving panel visibility/focus behavior.

### Connection state

Expose `connecting`, `connected`, `disconnected`, and `error` with text plus icon—not color alone.

- A user action may initiate a bounded pool connection.
- On loss, finish the current request with a useful error and show Reconnect. Do not loop in the background.
- Reconnect invalidates the old pool entry and performs one fresh list request after success.
- Authentication/host-key prompts remain owned by shared services and cannot render inside webview HTML.

### Remote mutations

- **New file:** validate name, fail if target exists, atomically create zero bytes, emit events, and open beside the panel.
- **New folder:** validate name, fail if target exists, call one mkdir, refresh parent.
- **Rename:** construct target in the same parent, reject existing target and root rename. Before any file/directory rename, scan `workspace.textDocuments` and visible tab inputs for the exact resource and descendants; v1 blocks rename while the resource is open and instructs the user to close it.
- **Delete file/link:** show exact normalized path and require Delete.
- **Delete directory:** first `lstat`, then require Delete Recursively with descendant warning. Traverse iteratively/depth-first with entry/byte/time safety counters, never follow links, unlink children, remove directories post-order, and support cancellation between operations.
- **Copy path:** use `vscode.env.clipboard`; the webview never receives clipboard access.
- Every conflict or destructive confirmation occurs in the extension host immediately before mutation, then destination/source state is rechecked.

### Download service

```ts
type LocalConflictDecision =
  | 'overwrite'
  | 'overwriteAll'
  | 'skip'
  | 'skipAll'
  | 'cancel';

interface DownloadPlanItem {
  sourcePath: string;
  destination: vscode.Uri;
  kind: 'file' | 'directory' | 'symbolicLink';
}
```

- Use `showOpenDialog({ canSelectFolders: true })` to select a destination. It may be a local or writable virtual filesystem URI supported by `workspace.fs`.
- Preflight selected roots iteratively, never follow symlinks, reject a source root/link escape, preserve empty directories, and cap planned entries (default 100,000) before starting.
- For local `file:` destinations, stream remote files into a same-directory temporary file when practical, then rename/replace after conflict authorization.
- For non-file destinations, use bounded buffering limited by `maxBufferedTransferMiB`; reject larger files before reading and state the limitation clearly.
- Existing file choices are Overwrite, Overwrite All, Skip, Skip All, Cancel. Existing directory collisions merge; skipping a directory skips its entire subtree. Never delete a destination directory to replace it.
- Keep batch decisions within one download operation only.
- Use `window.withProgress` with file count, bytes when known, current relative path, and cancellation.
- On cancellation, complete/abort the active safe unit, remove its known temp artifact where possible, retain prior completed downloads, and return a summary.
- A downloaded symbolic link is skipped with a reported reason in v1; it is never materialized or followed.
- Prevent remote relative paths from escaping the chosen destination after URI joining/normalization.

### Browser UI and accessibility

- Remote pane includes toolbar, breadcrumb, column headers, file list, empty/loading/error states, and status label.
- Use VS Code theme tokens and codicons/local packaged assets only.
- Implement roving tabindex/listbox or treegrid semantics, visible focus, Enter activation, Space selection, context-menu key/Shift+F10, Escape cancellation, and toolbar labels.
- Do not rely solely on icons, hover, color, drag, or double-click. Every operation has a keyboard/context/toolbar route.
- Context menus may be custom webview menus but must dismiss/focus correctly and contain only actions valid for the selected kind.
- Empty-space actions: New File, New Folder, Upload Files, Upload Folder, Refresh. Upload commands become functional in Milestone 06.

## Milestone completion checklist

This checklist is the authoritative completion gate for Milestone 05. Check an item only after its implementation and applicable tests/evidence satisfy the detailed requirements below. The milestone is complete only when every item is checked; no implementation, test, documentation, or verification work described by this milestone may remain.

### Entry gate and contracts

- [ ] Re-run and record all Milestones 01–04 exit criteria, tests, and package checks as passing before starting the Milestone 05 completion sign-off.
- [ ] Verify the SFTP pool, URI/path codec, FileSystemProvider, atomic writer, domain-error mapping, and guarded remote-open command expose every behavior required by this milestone.
- [ ] Define the versioned `SftpPanelState`, `SftpRequest`, `SftpResponse`, and `RemoteEntryView` contracts in shared code without exposing secrets or transport objects.
- [ ] Implement independent extension-host runtime validation for every request variant, including exact shapes, type allowlists, string/array limits, prototype-shaped input rejection, child-name validation, and path normalization.
- [ ] Bind every panel to its host-owned connection UUID and prove message-supplied identifiers or paths cannot override connection identity or bypass fresh connection lookup.

### Panel lifecycle, protocol, and security

- [ ] Implement one `SftpPanel` per connection in `SftpPanelManager`, including create-or-reveal behavior, connection-rename title updates, and duplicate-panel prevention.
- [ ] Implement panel serialization/restoration with version checking, connection re-resolution, normalized current/history paths, invalid-state/history removal, and a clear deleted-connection outcome.
- [ ] Dispose panel-scoped controllers, listeners, leases, and pending requests without closing provider/editor work that still shares the connection pool.
- [ ] Close the associated panel after confirmed connection deletion and make already-open provider documents fail clearly on their next operation.
- [ ] Build packaged HTML/CSS/TypeScript webview assets with a per-render nonce and the specified strict CSP, with no remote sources, inline handlers, `unsafe-eval`, Node access, or unsafe dynamic HTML.
- [ ] Render all remote names and errors through safe DOM APIs/static templates and verify no untrusted value can enter executable markup.
- [ ] Implement request/response correlation for concurrent work, monotonically increasing list/navigation generations, cancellation, disposal handling, retryable sanitized errors, and loading-state accounting.
- [ ] Ensure stale, cancelled, and post-disposal responses settle their work but cannot replace the current view or corrupt global/panel loading state.

### Browser behavior and accessibility

- [ ] Implement one-directory-at-a-time remote listing without recursive/preload behavior and return display-only entry view models.
- [ ] Implement exact-path breadcrumbs, Back, Forward, Up, and Refresh, including root behavior, consecutive-history deduplication, 100-entry history caps, and forced cache bypass on Refresh.
- [ ] Implement stable sorting by name/size/mtime and direction, with default directories-first locale-aware name ordering, distinct stable link/other groups, and persisted sort state.
- [ ] Implement selection and file/directory/link activation, resolving links only for explicit single-resource operations and never following links recursively.
- [ ] Route file activation through the guarded provider open command with `ViewColumn.Beside` so the browser remains visible and focus behavior stays correct.
- [ ] Implement connecting/connected/disconnected/error status using text and icon, bounded user-initiated connection, useful loss errors, and a visible Reconnect action without background retry loops.
- [ ] Make Reconnect invalidate the old pool entry and issue exactly one fresh listing after success while leaving authentication and host-key prompts in shared extension-host services.
- [ ] Build toolbar, breadcrumb, column headers, list, status, empty/loading/error states, and only local codicons/assets using VS Code theme tokens.
- [ ] Implement roving focus with appropriate listbox/treegrid semantics, visible focus, Enter activation, Space selection, context-menu key/Shift+F10, Escape, labelled toolbar controls, and correct focus restoration.
- [ ] Provide keyboard, context-menu, and toolbar routes for every operation; make custom menus dismiss correctly and expose only actions valid for the current selection/kind.
- [ ] Provide empty-space New File, New Folder, Upload Files, Upload Folder, and Refresh actions, with upload entry points clearly non-functional placeholders until Milestone 06.

### Remote mutations

- [ ] Implement New File with validated names, fresh non-existence checks, zero-byte atomic creation, targeted events/cache invalidation, parent refresh, and open-beside behavior.
- [ ] Implement New Folder with validated names, fresh non-existence checks, one `mkdir`, targeted invalidation, and parent refresh.
- [ ] Implement same-parent rename with root/existing-target rejection and fresh source/destination checks immediately before mutation.
- [ ] Block file or directory rename when the exact provider resource or any descendant is present in open text documents or visible tab inputs, with actionable close-editor guidance.
- [ ] Implement file/link deletion with the exact normalized path in an extension-host Delete confirmation and guarantee that deleting a link never affects its target.
- [ ] Implement directory deletion with `lstat`, explicit Delete Recursively confirmation, iterative depth-first post-order traversal, entry/byte/time bounds, cancellation points, partial-failure reporting, and no symlink traversal.
- [ ] Recheck state after every destructive/conflict confirmation and before the mutation, then emit only the precise provider events and affected-parent refreshes.
- [ ] Implement Copy Path exclusively through `vscode.env.clipboard`, without granting clipboard access to the webview.

### Downloads

- [ ] Implement destination selection with `showOpenDialog` for local and writable virtual `workspace.fs` destinations.
- [ ] Implement iterative multi-root download preflight that preserves relative layout and empty directories, caps planned entries at the documented default, detects source/link escape, and never follows symlinks.
- [ ] Prove every joined remote-relative destination remains contained by the selected destination after URI-aware joining and normalization.
- [ ] Implement same-directory temporary-file streaming and authorized rename/replace for local `file:` destinations.
- [ ] Implement bounded buffering for non-`file:` destinations, pre-reject files above `maxBufferedTransferMiB`, and return an actionable limitation without reading oversized content.
- [ ] Implement operation-scoped Overwrite, Overwrite All, Skip, Skip All, and Cancel decisions; merge directory collisions, skip whole subtrees when selected, and never recursively replace a destination directory.
- [ ] Skip symbolic links with an explicit reported reason and never materialize or dereference them.
- [ ] Implement cancellable progress with current relative path, file counts, and truthful byte progress when known.
- [ ] On cancellation/failure, safely settle the active unit, remove known temporary artifacts where possible, retain prior completed files, and return an exact completed/skipped/failed/cancelled/cleanup summary.

### Automated verification

- [ ] Add protocol/security tests for CSP sources/nonces, safe DOM construction, exact schema rejection, size limits, invalid paths/names, connection override attempts, and prototype-shaped values.
- [ ] Add broker/lifecycle tests for concurrent request correlation, stale/cancelled/post-disposal responses, one-panel-per-connection behavior, state restoration, invalid/deleted connections, title updates, and disposal isolation.
- [ ] Add browser-state tests for history/root/up/breadcrumb behavior, sorting stability/persistence, forced refresh, connection transitions, controlled reconnect, selection/activation, and open-beside routing.
- [ ] Add accessibility DOM tests for keyboard-only operation, focus restoration, menu visibility/dismissal, roles, labels, status announcements, theme tokens, and high-contrast behavior.
- [ ] Add mutation tests covering new file/folder success plus conflict/permission/disconnect, rename same/open/missing/existing/root cases, targeted events/refreshes, and zero mutation when blocked.
- [ ] Add delete tests covering confirmation/cancel, link-target preservation, empty/deep directory trees without call-stack recursion, post-order behavior, symlink non-follow, cancellation, traversal caps, and truthful partial-error summaries.
- [ ] Add download tests for files, nested/empty/Unicode directories, multi-selection layout, every conflict decision and its operation scope, directory merge, subtree skip, and no implicit recursive replacement.
- [ ] Add download safety/failure tests for containment/traversal, symlink skip, local streaming, virtual buffering limits, temp cleanup, permission/read/write failures, disconnect, cancellation, and exact progress/summary values.
- [ ] Add Docker/extension integration tests for navigation, forced external-change refresh, create/rename/delete, open-beside, download, stop/restart with one controlled reconnect, and panel restoration without persisted secrets.
- [ ] Run the complete automated suite plus formatting, lint, typecheck, build, and package-content checks and record all results as passing.

### Manual acceptance and completion gate

- [ ] Verify opening SFTP twice for one connection reveals the same panel and a connection rename updates its title.
- [ ] Verify deep navigation, breadcrumb/Back/Forward/Up, sorting, selection, and forced refresh entirely with the keyboard, including a remote change made outside the extension.
- [ ] Verify opening a text file keeps the browser visible and opens the provider-backed document beside it in a normal editor.
- [ ] Verify create, rename, copy-path, and delete behavior for files, directories, empty directories, links, conflicts, and permission-denied locations.
- [ ] Verify rename is blocked for an open file and an open descendant of a directory until all affected editors/tabs are closed.
- [ ] Verify file and nested-directory downloads into local and writable virtual destinations, including every batch conflict choice, empty directories, link skips, cancellation, and partial summaries.
- [ ] Verify mid-list and mid-download disconnects, explicit reconnect, safe destination/temp state, actionable errors, and absence of reconnect loops.
- [ ] Reload the editor and verify valid panel/navigation/sort restoration, deleted/invalid state handling, and no persisted secret data.
- [ ] Complete core flows at 200% zoom in light, dark, and high-contrast themes using keyboard-only interaction and confirm visible focus and screen-reader-friendly names/status.
- [ ] Confirm all targeted mutations invalidate only affected cache entries/parents, all panel-owned resources return to baseline after close/deactivation, and no credential or remote file content appears in webview state, logs, errors, or package artifacts.
- [ ] Re-run every previous milestone gate and confirm every Milestone 05 deliverable, exit criterion, risk mitigation, and stated non-goal boundary is satisfied with no remaining implementation, test, documentation, or verification task.

## Automated tests

### Protocol/panel tests

- CSP contains only expected sources/nonce; generated content never interpolates names/errors into executable HTML.
- Runtime schemas reject unknown types, oversized arrays/strings, invalid names/paths, connection overrides, and prototype-shaped values.
- Request IDs correlate concurrent responses; stale list results and post-disposal responses are ignored.
- Create/reveal ensures one panel per connection; serialize/restore validates state and handles deleted connections.
- History/root/up/breadcrumb, sorting stability, forced refresh, state transitions, and reconnect behavior.
- Keyboard model, focus restoration, context menu visibility, and screen-reader labels.

### Mutation tests

- New file/folder success/conflict/permission/disconnect and precise refresh/events.
- Rename same/open/missing/existing/root cases; no mutation occurs while source or descendant is open.
- File/link deletion confirmation/cancel and link-target preservation.
- Recursive directory delete post-order, empty tree, deep tree without call-stack recursion, symlink non-follow, cancel, partial error summary, and traversal caps.

### Download tests

- File/folder/empty directory/Unicode trees and multi-selection relative layout.
- Overwrite/overwrite-all/skip/skip-all/cancel scope, directory merge, and no implicit recursive replacement.
- Destination traversal/name validation, source symlink skip, local streaming, virtual buffering limit, temp cleanup, mid-stream disconnect, and cancellation.
- Progress counts/bytes and truthful partial-completion summary.

### Docker/extension integration

- Navigate, force refresh, create, rename, delete, open-beside, and download against Docker OpenSSH.
- Modify the remote directory externally and prove Refresh bypasses cached results.
- Stop/restart the server and verify one controlled reconnect.
- Restore a panel after editor reload without persisting secret data.

## Manual acceptance tests

1. Open SFTP twice for one connection and verify the same panel is revealed.
2. Navigate deep paths using rows, breadcrumbs, back/forward/up, keyboard only, and refresh.
3. Open a text file and confirm the panel remains in one group and the normal editor opens beside it.
4. Exercise create/rename/delete on files, directories, empty directories, links, and permission-denied locations.
5. Try renaming an open file and an open file's parent; verify blocking until editors close.
6. Download a file and nested folder, repeat into existing targets, and exercise every batch decision and cancellation.
7. Disconnect mid-list and mid-download; verify truthful errors, no reconnect loop, and safe destination/temp state.
8. Reload the window and confirm valid panel restoration and connection state.
9. Inspect the webview with light, dark, and high-contrast themes and complete core operations using only the keyboard.

## Exit criteria

- The SFTP browser is a secure, restorable editor tab with complete accessible remote navigation.
- Remote files always open through the provider in a normal editor beside the browser.
- All remote mutations revalidate state, prompt appropriately, emit targeted changes, and never follow links recursively.
- File/directory downloads preserve hierarchy, handle collisions explicitly, support cancellation/progress, and cannot escape the destination.
- Disconnect/reconnect, stale message, permission, and restoration scenarios are deterministic and tested.
- All previous tests/package checks pass with no credential or content exposure to the webview.

## Risks and mitigations

- **Webview spoofing/path injection:** bind connection identity host-side and normalize/re-resolve all paths immediately before operations.
- **Stale asynchronous UI:** generation-tag directory loads and ignore responses after navigation/disposal.
- **Recursive damage:** use lstat, iterative bounded traversal, strong confirmation, and no link following.
- **Virtual destination limitations:** preflight sizes and fail before reading files that exceed bounded buffering.
- **Panel/editor layout variation:** request `ViewColumn.Beside` and test expected behavior without trying to recreate editor groups in the webview.

## Non-goals

- Workspace tree and functional upload/drop workflows (Milestone 06).
- Remote-to-workspace drag/drop, symlink materialization, permissions/chmod, or server-side watch.
- Tabs for multiple remote directories within one connection panel.
- Custom source editor, preview renderer, diff, or three-way merge.
