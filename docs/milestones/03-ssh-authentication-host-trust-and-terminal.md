# Milestone 03 — SSH Authentication, Host Trust, and Terminal

## Objective

Turn saved profiles into secure, independently managed SSH connections and usable integrated terminals. Centralize connection resolution, credentials, host-key policy, timeout behavior, and lifecycle management so SFTP and MCP reuse the same security boundary later.

At completion, Open SSH creates a functioning `Pseudoterminal`, Test Connection verifies both SSH and SFTP access, changed host keys are blocked, and closing an editor terminal leaves no SSH client or credential reference behind.

## Prerequisites

- Milestones 01–02 exit criteria pass.
- Docker OpenSSH fixture supports password, unencrypted key, encrypted key, agent, SFTP, delayed handshake, disconnect, and host-key rotation cases.
- `ssh2` and its type declarations are pinned, bundled, license-checked, and smoke-tested from the VSIX.

## Deliverables

- `ConnectionResolver`, `CredentialResolver`, `SshClientFactory`, `HostKeyVerifier`, and `SshSessionManager` implementations.
- Extension-owned TOFU host-key store and first-use/change confirmation flows.
- Exactly configured password, single private-key, or Linux SSH-agent authentication.
- Full Test Connection command.
- Independent `Pseudoterminal`-backed SSH terminals with resize and deterministic cleanup.
- Network/domain error mapping, bounded timeouts/keepalives, cancellation, and concurrency tests.

## Architecture and interfaces

### Resolved connection boundary

UI and MCP callers pass only a connection UUID. The resolver loads fresh metadata for each new transport, confirms the profile still exists/enabled, and returns a non-secret snapshot.

```ts
interface CredentialLease extends AsyncDisposable {
  readonly password?: string;
  readonly privateKey?: Uint8Array;
  readonly passphrase?: string;
  readonly agentSocket?: string;
}

interface ConnectionResolver {
  resolve(connectionId: string): Promise<Readonly<RemoteConnection>>;
}

interface CredentialResolver {
  acquire(
    connection: RemoteConnection,
    scope: { kind: 'terminal' | 'sftp'; scopeId: string },
  ): Promise<CredentialLease>;
}
```

- Password/private-key/passphrase values are never properties of `RemoteConnection` and never included in thrown errors.
- Stored values come from SecretStorage. Missing values prompt with a password-masked native input and live only for the requesting terminal or pooled SFTP scope.
- Private-key paths expand `~`, normalize locally, reject directories, read only when connecting, and cap key input to 1 MiB. Key bytes and passphrases remain inside the lease and transport initialization.
- Agent mode uses a non-empty Unix socket path from `SSH_AUTH_SOCK`; it does not fall back to default keys or password.
- Exactly the selected auth mode is supplied to `ssh2`; `tryKeyboard` remains false in v1.

### SSH client factory

```ts
interface SshConnectionHandle extends AsyncDisposable {
  readonly id: string;
  readonly connectionId: string;
  readonly client: ssh2.Client;
  readonly onDidClose: vscode.Event<SshCloseReason>;
  openShell(options: PtyOptions): Promise<SshShellHandle>;
  openSftp(): Promise<SftpSubsystemHandle>;
  exec(options: ExecOptions): Promise<ExecHandle>;
}

interface SshSessionManager {
  connect(connectionId: string, purpose: ConnectionPurpose): Promise<SshConnectionHandle>;
  disposeConnection(handleId: string): Promise<void>;
  disposeAll(): Promise<void>;
}
```

- Each terminal receives its own SSH client. Later SFTP pools receive separate clients.
- Connection phases—resolve, credential, TCP/handshake, host verification, auth, ready—have bounded state transitions and one cleanup path.
- Use global/per-profile `readyTimeout`, keepalive interval, and `keepaliveCountMax`. No retry occurs during initial authentication; callers explicitly retry after an actionable failure.
- Cancellation ends the client, rejects once with `CANCELLED`, and ignores late library callbacks.
- Register error/close/end/timeout listeners before calling `connect`, remove them on disposal, and make disposal idempotent.

### Host-key verification

Store accepted non-secret fingerprints inside the versioned state envelope:

```ts
interface TrustedHostKey {
  hostIdentity: string; // normalized lower-case DNS/IP plus port
  algorithm: string;
  sha256Fingerprint: string;
  firstTrustedAt: number;
  lastSeenAt: number;
}
```

- Compute `SHA256:<base64-without-padding>` from the raw key bytes presented to `ssh2`'s verifier. Do not log/store raw keys.
- Normalize DNS case, IPv4, bracketed IPv6, and port into an unambiguous identity; never key trust by mutable connection name/UUID.
- First use pauses connection completion and displays host, port, algorithm, and fingerprint with Trust and Continue or Cancel.
- A matching record continues and updates `lastSeenAt` without prompting.
- A different fingerprint or algorithm for the same host identity is a blocking mismatch showing expected and received fingerprints. Trust New Key is a separate destructive confirmation, then atomically replaces trust records.
- Concurrent first-use attempts for the same identity share one prompt/promise so contradictory decisions cannot race.
- v1 never consults or writes `~/.ssh/known_hosts`.

### Test Connection

The form may test an unsaved candidate using in-memory form credentials; saved profile tests use the UUID resolver. The operation:

1. validates metadata and acquires a credential lease;
2. connects and completes host trust/authentication;
3. opens SFTP;
4. `realpath`s and lists the configured default remote path;
5. reports each successful stage and total latency;
6. closes SFTP, SSH, lease, listeners, and timers in `finally`.

Failures identify the stage without exposing low-level payloads. A successful TCP handshake alone is never success.

### Pseudoterminal design

```ts
interface SshTerminalSession extends vscode.Pseudoterminal, AsyncDisposable {
  readonly sessionId: string;
  readonly connectionId: string;
}
```

- `open()` initiates the connection and emits a status line with CRLF terminal endings.
- Request an `xterm-256color` PTY using the latest known rows/columns, defaulting to 80×24.
- `handleInput(data)` writes exactly to the shell stream only after open; bounded pre-open input is queued up to 64 KiB, then rejected/belled rather than growing indefinitely.
- Shell data and stderr-like extended data are decoded/forwarded without reinterpreting ANSI sequences. Normalize only extension-generated status messages.
- `setDimensions` validates positive dimensions and calls the channel window-resize API; retain the latest size if called before the shell opens.
- Remote EOF/close writes a concise reason and closes the pseudoterminal once. VS Code terminal close ends/destroys the shell and client.
- A terminal registry maps terminal/session/handle IDs for cleanup but exposes no general attachment surface to agents.
- Multiple terminals for the same profile are isolated; closing one cannot affect another or a later SFTP pool.

### Error mapping

Map library events/codes into stable failures: DNS/unreachable, timeout, host mismatch, user trust rejection, missing credential/key/agent, invalid key/passphrase, authentication rejected, channel rejected, connection lost, and cancellation. Include connection display name and host context where useful, never the credential or raw configuration object.

## Implementation checklist

- [x] Add typed Promise adapters around `ssh2` connection, shell, exec, and SFTP callbacks with exactly-once settlement.
- [x] Implement credential leases for stored and transient password/passphrase/key/agent material.
- [x] Implement host identity normalization, SHA-256 fingerprinting, serialized TOFU prompts, trust replacement, and state persistence.
- [x] Implement SshClientFactory with exact auth-mode configs, timeout/keepalive settings, cancellation, and safe diagnostics.
- [x] Implement SshSessionManager registry and idempotent reverse-order cleanup.
- [x] Replace connection TreeView Open SSH/Test placeholders with real commands.
- [x] Wire saved and unsaved connection-editor Test Connection paths without persisting form secrets prematurely.
- [x] Implement the pseudoterminal bridge, buffered pre-open input, resize, status output, and all close directions.
- [x] Add session counts to debug diagnostics without exposing stream data.
- [x] Ensure application deactivation closes terminals/channels/clients, releases credential leases, and waits only for a bounded shutdown period.

## Automated tests

### Unit/contract tests

- Credential selection never mixes auth modes; no password fallback occurs for key/agent failures.
- Stored and transient leases dispose once; no sentinel credential reaches logger, errors, client snapshots, or test serialization.
- Private-key path expansion, size cap, read failure, invalid/encrypted key, wrong passphrase, and deletion during connection.
- Host identity normalization for DNS, IPv4, IPv6, and non-default ports.
- Fingerprint known/missing/changed flows, concurrent prompt coalescing, cancel, trust replacement, and persistence failure.
- Promise adapters ignore duplicate callback/event completion and clean listeners on timeout/cancel.
- Terminal pre-open input cap, binary/Unicode stream chunks, resize-before/after-open, local close, remote EOF, error, and repeated disposal.

### Docker integration tests

- Password login and rejection.
- Unencrypted and encrypted Ed25519 key login; wrong/missing passphrase.
- SSH-agent login via a test agent socket and clear failure with no agent.
- First trust, reconnect match, fixture host-key rotation mismatch, explicit retrust, and cancellation.
- Test Connection authenticates, opens SFTP, lists the default path, and closes every socket.
- Interactive shell executes commands, returns ANSI output, handles Unicode/input, receives PTY resize, and terminates cleanly.
- Two terminals for one profile and terminals for different profiles remain independent.
- Delayed handshake triggers configured timeout; forced server disconnect maps to one useful terminal message.

## Manual acceptance tests

1. Create password, unencrypted-key, encrypted-key, and agent profiles against non-production test hosts.
2. Trust each first-use fingerprint, restart the editor, and verify matching reconnects do not prompt.
3. Rotate a fixture host key and confirm connection is blocked until Trust New Key receives explicit confirmation.
4. For stored credentials, restart and connect without re-entry. For non-stored credentials, verify one prompt per terminal/session and no persistence.
5. Run `whoami`, `pwd`, `ls`, `top`, Ctrl+C, Unicode input, and terminal clear in the integrated terminal.
6. Resize repeatedly and verify full-screen interactive programs track rows/columns.
7. Open multiple sessions, close them in different orders, stop the server, and inspect diagnostics for orphan-free cleanup.
8. Run Test Connection for a valid profile, invalid default path, wrong credential, absent agent, and refused host key.

## Exit criteria

- All three configured auth modes work against Docker/real Linux fixtures with no implicit fallback.
- TOFU and changed-key blocking work for every entry point and store no raw host key.
- Integrated terminals support normal and full-screen interactive use, resize, concurrent sessions, and clean close.
- Test Connection validates actual authentication plus SFTP/default-path access.
- Forced failure/cancellation/deactivation leaves zero managed SSH clients, channels, timers, listeners, or transient credential leases.
- All credential sentinel leak tests and prior milestone gates pass; the VSIX remains installable.

## Risks and mitigations

- **ssh2 event races:** wrap lifecycle in explicit state machines and exactly-once settle/dispose helpers.
- **Credential retention:** scope material through leases, avoid closure capture beyond connect, and clear buffers/references on disposal where practical.
- **Host-key algorithm changes:** include algorithm in the record and require an explicit retrust instead of silently accepting a new presentation.
- **Terminal backpressure:** respect stream writability, bound pre-open buffering, and never buffer unbounded remote output in the extension.
- **Authentication ambiguity:** supply only the selected mode and return a precise remediation message.

## Non-goals

- Keyboard-interactive/MFA orchestration, certificate management, multiple fallback credentials, agent forwarding, ProxyJump, or port forwarding.
- Terminal reconnect or session persistence across editor restart.
- Agent attachment to visible terminals.
- A main-editor SFTP browser or writable remote filesystem.
- Windows named-pipe/Pageant and macOS-specific agent support guarantees.
