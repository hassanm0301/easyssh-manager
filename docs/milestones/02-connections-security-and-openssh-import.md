# Milestone 02 — Connections, Security, and OpenSSH Import

## Objective

Deliver the complete non-network connection-management experience: versioned persistence, secure credential handling, ordered nested folders, a native connection tree, a secure editor, and read-only OpenSSH import. SSH/SFTP actions remain visible placeholders until Milestone 03, but every saved profile must already be valid for the later transport layer.

The central invariant is that normal state contains only non-secret metadata. Passwords and encrypted-key passphrases cross the connection-editor boundary only when newly entered, enter `SecretStorage` directly, and are never returned to a webview.

## Prerequisites

- Milestone 01 exit criteria pass.
- `ExtensionContext.globalState` and `ExtensionContext.secrets` are available in extension-host tests through controlled fakes.
- The chosen `ssh-config` package is pinned exactly and reviewed for license/runtime compatibility.

## Deliverables

- Stable v1 connection, folder, host-trust, UI-preference, and agent-policy types.
- Atomic schema envelope in `globalState` with validation, migration, and corruption recovery.
- SecretStorage-backed password/passphrase service, transient session credential cache contract, and secure duplicate/delete behavior.
- Ordered native TreeView with arbitrary folder depth, inline SSH/SFTP actions, drag reorder/reparent, and full context menus.
- Nonce-protected connection editor and SSH import preview webviews with typed runtime validation.
- Read-only OpenSSH discovery/import with wildcard inheritance, guarded includes, supported-directive resolution, preview warnings, and duplicate handling.
- Unit and extension-host coverage for all state, hierarchy, secret, form, and import rules.

## Architecture and interfaces

### Persisted model

Use UUID v4 strings for every connection and folder. Persist one validated envelope under `easysshManager.state` so a logical update cannot leave separate keys out of sync.

```ts
type Authentication =
  | { type: 'password'; hasStoredPassword: boolean }
  | {
      type: 'privateKey';
      privateKeyPath: string;
      hasStoredPassphrase: boolean;
    }
  | { type: 'agent' };

interface AgentAccessPolicy {
  enabled: boolean;
  allowReadFiles: boolean;
  allowWriteFiles: boolean;
  allowExec: boolean;
  allowInteractiveShell: false;
  confirmationMode: 'always' | 'destructive' | 'never';
  allowedRoots: string[];
}

interface RemoteConnection {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
  host: string;
  port: number;
  username: string;
  defaultRemotePath: string;
  authentication: Authentication;
  importedFromSshConfig?: { sourcePath: string; hostPattern: string };
  agentAccess: AgentAccessPolicy;
  options: { keepAliveIntervalMs?: number; readyTimeoutMs?: number };
  createdAt: number;
  updatedAt: number;
}

interface ConnectionFolder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface PersistedStateV1 {
  schemaVersion: 1;
  connections: RemoteConnection[];
  folders: ConnectionFolder[];
  hostKeys: TrustedHostKey[];
  uiPreferences: UiPreferences;
}
```

`hasStoredPassword` and `hasStoredPassphrase` are display hints reconciled against SecretStorage on load; they are never credential substitutes. Agent access defaults to disabled, all grants false, `always`, and no roots. Enabling file access is invalid until at least one normalized absolute POSIX root exists.

### Persistence and migration

```ts
interface StateRepository {
  load(): Promise<Readonly<PersistedStateV1>>;
  update(mutator: (draft: PersistedStateV1) => void): Promise<void>;
  readonly onDidChange: vscode.Event<StateChange>;
}
```

- Serialize updates through a single promise queue to prevent lost concurrent edits.
- Clone, validate, normalize, and write a complete new envelope. Emit events only after `globalState.update` succeeds.
- Reject unknown future schema versions without rewriting them. Show an actionable backup/downgrade error.
- For corrupt current state, preserve the raw value under a timestamped recovery key, initialize an empty valid envelope, and notify the user once.
- Migration functions are pure `N -> N+1` transformations with fixture tests. Never edit secrets during a metadata migration without an explicit two-phase recovery design.
- `order` is a gapless sibling-local integer. Reordering/reparenting rewrites only affected sibling sets in one repository update.

### Secret boundary

Secret keys are opaque implementation details:

```text
easysshManager.connection.<uuid>.password
easysshManager.connection.<uuid>.keyPassphrase
```

```ts
interface CredentialStore {
  getPassword(connectionId: string): Promise<string | undefined>;
  setPassword(connectionId: string, value: string): Promise<void>;
  getKeyPassphrase(connectionId: string): Promise<string | undefined>;
  setKeyPassphrase(connectionId: string, value: string): Promise<void>;
  clearPassword(connectionId: string): Promise<void>;
  clearKeyPassphrase(connectionId: string): Promise<void>;
  clearAll(connectionId: string): Promise<void>;
  copySelected(sourceId: string, targetId: string, kinds: CredentialKind[]): Promise<void>;
}
```

- Empty edit fields mean “keep existing”; clearing requires a distinct command and confirmation.
- Turning away from an auth mode asks whether to delete the now-unused stored secret; keeping it invisibly is not the default.
- Deleting a connection clears both possible keys even if its metadata claims no stored secret.
- Duplicating a connection always creates a new UUID and copies only metadata first. Prompt separately for password/passphrase copying, name exactly what will be copied, and perform it only after consent.
- Roll back newly stored secrets if metadata creation fails. If secret deletion fails after metadata deletion, record a safe cleanup task and retry without logging the secret.
- Credentials that are not stored are supplied later by `SessionCredentialCache`; its interface scopes values to one terminal or pooled SFTP session and clears them on session close/idle expiry.

### Hierarchy and ordering

`ConnectionService` is the only writer of parent and order fields.

- Validate non-empty trimmed names but allow duplicate connection and folder display names.
- A folder cannot be moved under itself or any descendant. Determine descendants from IDs with a visited set; corrupted cycles must not recurse forever.
- Dragging before/after a sibling reorders it. Dropping on a folder appends inside it. Dropping on empty/root space appends at root.
- New items append to their sibling list. Removing/moving an item compacts both source and destination order.
- Deleting a non-empty folder presents: **Move children to parent**, **Delete folder and all descendants**, or **Cancel**.
- “Move children” appends children to the parent while preserving relative order. Recursive delete shows counts, requires the strong confirmation phrase/button, deletes descendant connections' secrets, then commits metadata removal.
- All hierarchy writes are immediately persisted and followed by the smallest possible TreeView refresh.

### Connection editor

Use a webview because connection and agent policies are a cohesive form. The webview receives sanitized metadata plus booleans indicating stored credentials; it never receives stored values or SecretStorage keys.

Required fields and validation:

- Name: trimmed, non-empty, maximum 200 code points.
- Folder: existing folder UUID or root.
- Host: trimmed DNS name/IPv4/IPv6 literal without URI credentials or NUL.
- Port: integer 1–65535; default 22.
- Username: non-empty, maximum 255 code points.
- Default remote path: normalized absolute POSIX path; default `/`.
- Authentication: exactly password, one private-key path, or agent.
- Private-key path: local path with `~` expansion at use time; required only for private-key mode.
- Keepalive and ready timeout: optional validated overrides inheriting global defaults.
- Agent policy: hidden/disabled by default; root allowlists normalize duplicate/trailing slashes and forbid relative paths/NUL.

Test Connection is present but reports “available after SSH transport milestone” until Milestone 03 wires it. Save remains allowed without testing.

Webview requests use request IDs and runtime schemas. Unknown fields are rejected for mutations to prevent mass-assignment of future privileged properties.

### TreeView and command surface

Contribute and implement:

```text
easysshManager.addConnection
easysshManager.addFolder
easysshManager.editConnection
easysshManager.duplicateConnection
easysshManager.deleteConnection
easysshManager.renameFolder
easysshManager.moveItem
easysshManager.deleteFolder
easysshManager.importSshConfig
easysshManager.refreshConnections
easysshManager.openSsh       (placeholder until M03)
easysshManager.openSftp      (placeholder until M05)
easysshManager.testConnection (placeholder until M03)
```

Folder/connection `contextValue`s drive precise inline and context menus. Inline connection actions use codicons for Open SFTP and Open SSH. Keyboard commands and screen-reader labels expose the same operations as pointer menus.

### OpenSSH importer

The importer is read-only by construction: it accepts filesystem readers and returns candidates; it has no writer dependency.

```ts
interface SshImportCandidate {
  candidateId: string;
  sourcePath: string;
  hostPattern: string;
  name: string;
  host?: string;
  port: number;
  username?: string;
  identityFiles: string[];
  selectedIdentityFile?: string;
  selectedAuthentication?: 'password' | 'privateKey' | 'agent';
  blockingIssues: ImportIssue[];
  warnings: ImportIssue[];
}
```

- Discover `~/.ssh/config` on Linux and allow an explicit file picker.
- Read bytes once for an integrity fixture; decode UTF-8 with BOM support and fail clearly on invalid input.
- Parse with the pinned `ssh-config` dependency and call compute with `matchExec: false`. Never execute `Match exec`, `ProxyCommand`, shell expansion, or an external `ssh -G` command.
- Implement `Include` resolution outside the parser: paths relative to the including file, `~` expansion, safe glob expansion, deterministic lexical ordering, canonical visited paths, maximum depth 16, maximum 256 files, maximum 8 MiB aggregate input.
- Preserve OpenSSH “first obtained value” behavior and case-insensitive directives. Handle concrete aliases, `*`, `?`, and negated patterns; never create standalone candidates for wildcard-only blocks.
- Resolve at minimum `HostName`, `User`, `Port`, `IdentityFile`, `IdentitiesOnly`, and `PreferredAuthentications` for preview. Expand supported path tokens (`~`, `%d`, `%u`, `%h`, `%r`, `%n`, `%%`) without shell evaluation.
- Default a missing username to the local OS username and missing host to the concrete alias. Validate the resolved port.
- If multiple effective `IdentityFile` values exist, show all and preselect the first; require the user to select exactly one for private-key authentication.
- Mark aliases relying on `ProxyJump`, `ProxyCommand`, unresolved `Include`, conditional `Match`, unsupported tokens, or another connectivity-changing directive as non-importable with a precise blocking reason.
- Preview supports selection, rename, destination folder, auth-mode/key selection, and select-all-importable.
- Detect duplicates by source-path+host-pattern first and normalized host+port+username second. Offer Import as New, Replace Metadata, Skip, and Cancel. Replace updates non-secret fields only and never clears/copies a secret.
- Persist source path and concrete host pattern as informational provenance. Editing an imported profile affects only extension state.

## Implementation checklist

- [x] Define runtime schemas separately from TypeScript interfaces and validate all loaded/written state.
- [x] Implement queued atomic state updates, recovery snapshots, pure migrations, and state-change events.
- [x] Implement connection/folder repositories and a service enforcing hierarchy, ordering, timestamps, and delete rules.
- [x] Implement CredentialStore and transient credential cache ports with rollback/cleanup handling.
- [x] Add connection/folder TreeItems, welcome state, inline/context menus, drag controller, keyboard labels, and granular refresh.
- [x] Implement the connection editor panel with CSP, nonce scripts, state initialization, dirty-state close warning, validation, and correlation IDs.
- [x] Add explicit set/keep/clear secret operations and safe auth-mode transitions.
- [x] Implement duplicate and recursive folder-delete workflows with secret handling.
- [x] Implement safe default/selected SSH config discovery and guarded include loading.
- [x] Implement concrete-alias extraction, effective-option computation, preview issues, key selection, and duplicate policies.
- [x] Add import preview webview with no raw source content and no path/action trust delegated to the browser.
- [x] Verify import code exposes no write API and source fixtures remain byte-for-byte unchanged.

## Automated tests

### State and hierarchy

- Empty initialization, current-schema reload, sequential migrations, future-schema rejection, malformed-state recovery, and failed-write rollback.
- Concurrent update serialization and no lost connection/folder changes.
- Add/edit/delete/duplicate profiles, duplicate display names, timestamps, and UUID uniqueness.
- Nested folders, same-parent and cross-parent reordering, root moves, gapless order, cycle/self/descendant rejection, and corrupted-cycle containment.
- Move-children and recursive-delete behavior, including secret cleanup for every descendant connection.

### Secrets

- Store/get/replace/clear each secret, delete both keys, selectively duplicate after consent, rollback newly written credentials, and reconcile stale `hasStored*` hints.
- Sentinel password/passphrase never appears in serialized state, TreeItems, webview initialization, log capture, thrown errors, snapshots, or command results.
- Blank edit preserves, explicit clear removes, and non-stored credentials are not placed in any persistence fake.

### Webviews and commands

- CSP/nonce generation, request correlation, unknown/disallowed field rejection, stale response handling, and HTML text escaping.
- Editor validation for IPv6, ports, absolute POSIX paths, private-key requirements, allowed roots, and mode transitions.
- Menu/context visibility for folder, connection, root, empty state, inline actions, and untrusted workspace.

### OpenSSH import

- Concrete aliases; wildcard/negation/default inheritance; directive case; first-value semantics; default host/user/port.
- One/multiple `IdentityFile`s, tokens, explicit auth changes, unresolved auth, `IdentitiesOnly`, and `PreferredAuthentications` warnings.
- Nested/relative/glob includes, deterministic ordering, missing includes, canonical loop prevention, depth/file/byte limits, and symlink aliases.
- `Match exec` is never run, including a fixture whose command would create a sentinel file.
- `ProxyJump`, `ProxyCommand`, unsupported Match/token cases become blocking preview issues.
- Duplicate decisions update only intended metadata; stored credentials remain unchanged.
- Every input file's hash before and after import is identical.

## Manual acceptance tests

1. Create a three-level folder hierarchy, add duplicate-named connections, reorder siblings, move items to root, and restart the editor; verify exact order persists.
2. Attempt every invalid folder move and confirm the hierarchy remains unchanged.
3. Save password and encrypted-key profiles, reopen their forms, and confirm the UI shows only “Stored”. Exercise keep, replace, and clear.
4. Duplicate each secured profile; decline and then approve the explicit credential-copy prompt in separate runs.
5. Delete a non-empty folder once by moving children and once recursively; verify child placement or removal and SecretStorage cleanup.
6. Import a fixture containing defaults, wildcard patterns, negation, includes, multiple keys, and one ProxyJump alias. Verify correct candidates and blocking warnings.
7. Re-import duplicates with every decision and verify no credential is overwritten or removed.
8. Hash all imported config files before/after and confirm byte equality.
9. Inspect global state, webview developer tools, logs, and exported test snapshots for a sentinel password/passphrase.

## Exit criteria

- All connection/folder/import operations survive reload with valid versioned state and stable manual ordering.
- Credentials exist only in SecretStorage or a bounded in-memory session cache and leak tests pass.
- The connection tree and both forms are keyboard accessible, theme-correct, and protected by CSP/runtime validation.
- OpenSSH import resolves supported aliases accurately, blocks misleading unsupported routes, never executes config commands, and never changes source bytes.
- Placeholder SSH/SFTP commands fail informatively without compromising saved data.
- The extension remains buildable, testable, activatable, and packageable.

## Risks and mitigations

- **Partial metadata/secret failure:** order two-system writes carefully, compensate on failure, and test every injected failure point.
- **OpenSSH semantic complexity:** support a documented safe subset, use blocking preview issues for ambiguous connectivity, and retain exhaustive fixtures.
- **Malicious config input:** cap aggregate input, recursion, file count, and token expansion; disable all command execution.
- **Hierarchy corruption:** validate on every load/write and use iterative visited-set traversal.
- **Webview privilege escalation:** accept only operation-specific schemas and resolve all referenced IDs again in the extension host.

## Non-goals

- Establishing a network connection or validating credentials against a server.
- ProxyJump/ProxyCommand transport or multiple ordered keys per saved profile.
- Reading or writing `known_hosts`.
- Writing, formatting, or synchronizing OpenSSH config files.
- Generic JSON import/export, cloud sync, favorites, tags, or search.
- MCP tools or active agent access.
