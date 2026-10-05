# EasySSH Manager

EasySSH Manager is a Linux desktop extension for VSCodium and VS Code that
brings SSH connection management and integrated remote terminals into the
editor. It runs in the local UI extension host so credentials, private keys,
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
- Password, single-key, encrypted-key, and Linux SSH-agent authentication with
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

MCP support is enabled explicitly with **EasySSH Manager: Configure MCP**.
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

## License

GPL-3.0-only. See [LICENSE](LICENSE).
