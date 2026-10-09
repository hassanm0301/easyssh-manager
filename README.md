# EasySSH Manager

EasySSH Manager is a Linux-first desktop extension for VSCodium and VS Code
with native Windows 11 x64 client support. It brings SSH connection management
and integrated remote terminals into the editor. It runs in the local UI extension host so credentials, private keys,
SSH agent access, host trust, and connection state remain on the user's
machine, including when a remote workspace is open.

## Implemented features

The current release provides local connection management, secure SSH
terminals, and SFTP browsing, editing, and transfers.

- Native **EasySSH Manager** Activity Bar container with an ordered, nested,
  drag-and-drop **Connections** TreeView and complete connection/folder menus.
- Versioned, validated connection metadata in VS Code global state, including
  corruption recovery and serialized atomic updates.
- Passwords and key passphrases stored only through VS Code SecretStorage, with
  explicit keep, replace, clear, duplicate, and recursive-delete behavior.
- CSP- and nonce-protected connection editor with strict host-side request
  validation and independent MCP read, write, and exec policy controls.
- Read-only OpenSSH config discovery and preview with guarded includes,
  wildcard/default inheritance, safe token expansion, warnings, duplicate
  handling, and per-profile import choices.
- Event-driven desktop activation and clean extension lifecycle management.
- Validated configuration for connection timeouts, keepalives, SFTP idle time,
  transfer-size limits, and log level.
- Central composition root with explicit ownership and reverse-order disposal
  of services.
- Typed command registry with correlation IDs and user-safe error messages.
- Structured **EasySSH Manager** output logging with secret redaction and safe
  handling of arbitrary objects.
- Strict TypeScript, esbuild bundles, ESLint, Prettier, Vitest unit tests, and
  an extension-host test harness.
- Development and production VSIX packaging with an archive-content safety
  check.
- Docker OpenSSH fixture and Linux integration-test entry point for SSH/SFTP
  transport validation.
- Password, single-key, encrypted-key, and Linux/Windows OpenSSH-agent authentication with
  no implicit credential fallback.
- Extension-owned trust-on-first-use host-key verification, persisted SHA-256
  fingerprints, and blocking changed-key confirmation.
- Independent integrated SSH pseudoterminals with input buffering, Unicode and
  ANSI passthrough, PTY resize, keepalives, bounded connection timeouts, and
  deterministic cleanup.
- Saved and unsaved **Test Connection** flows that authenticate, open SFTP,
  resolve and list the configured default path, and report stage latency.
- Accessible remote SFTP browser with lazy navigation, sorting, create/rename/
  delete actions, atomic remote editing, safe download planning, and explicit
  conflict handling.
- Lazy multi-root Workspace pane for trusted workspaces, host-authorized
  internal drag/drop, file/folder pickers, bounded workspace-to-remote uploads,
  operation-local conflict choices, streamed local sources, and atomic commits.

## Current scope

The desktop client connects to Linux/POSIX SSH and SFTP servers. Remote Windows
servers, Pageant, Windows ARM64 and macOS are outside the validated support scope.
Windows release validation is tracked in
[the Windows acceptance checklist](docs/windows-support.md); passing Linux checks
alone does not validate a Windows release.

MCP support is available on Linux and enabled explicitly with **EasySSH Manager: Configure MCP**.
The extension bundles a separate Node.js stdio companion and exposes a
session-scoped Unix-domain IPC bridge only after confirmation. The companion
has no SSH, SFTP, credential, host-trust, or policy authority; all calls are
validated and authorized again in the extension host. Connections remain
hidden from MCP until agent access is enabled for them. File access requires
allowed remote roots. Exec and file mutations follow each connection's
confirmation mode. The extension never edits MCP client configuration files;
the command offers a generic launch configuration to copy or save.

The bridge runs only while VSCodium is open. It uses private filesystem
permissions and a fresh activation token. A compromise of the same local user
is outside the enforceable boundary; the controls protect against accidental
and cross-user access. Interactive shell/terminal attachment, TCP/HTTP or
remote MCP, and background daemons are not supported. **View MCP Audit**,
**Export MCP Audit**, and **Clear MCP Audit** manage the metadata-only audit.
The extension includes no telemetry and never consults or writes OpenSSH
`known_hosts`.

## Windows setup

Install the VSIX in native Windows VS Code or VSCodium. Password and private-key
authentication use the same connection editor as Linux. Keys stay on disk; key
paths support drive roots, UNC shares, spaces, Unicode, `~/` and `~\`.
The default import location is the current user's `.ssh/config` under their home
directory. Quoted config paths are useful when directories contain spaces.

For agent authentication, enable/start the Windows OpenSSH Authentication Agent
service using Windows' OpenSSH setup, then load your key with `ssh-add` and check
it with `ssh-add -l`. EasySSH uses `\\.\pipe\openssh-ssh-agent` when
`SSH_AUTH_SOCK` is absent. If you set `SSH_AUTH_SOCK`, it must identify a Windows
named pipe. An unavailable agent causes an authentication error; EasySSH never
falls back to a password or a default key. Restart the editor after changing
its environment.

Workspace navigation accepts drive-absolute and UNC paths. Drive-relative
inputs such as `C:folder` and current-drive-rooted inputs such as `\folder`
are rejected; choose a workspace root for relative paths.
Downloads to Windows local files reject unsupported filenames and destinations
that collide ignoring case before writing anything. Names are never silently
renamed. A locked destination can prevent replacement; the original is retained
and cleanup failures are reported. Virtual filesystem providers retain their
own URI and transfer-limit behavior.

Windows MCP setup and audit commands report that MCP is unavailable in this
release, before creating bridge, discovery or audit files. Linux MCP remains
supported. A separate Windows security port is required before enabling MCP.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
