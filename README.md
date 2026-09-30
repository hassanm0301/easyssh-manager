# EasySSH Manager

EasySSH Manager is a Linux desktop extension for VSCodium and VS Code that
brings SSH connection management and integrated remote terminals into the
editor. It runs in the local UI extension host so credentials, private keys,
SSH agent access, host trust, and connection state remain on the user's
machine, including when a remote workspace is open.

## Implemented features

The current release provides local connection management and secure SSH
terminals. SFTP is used by **Test Connection** to validate the configured
remote path; browsing and editing arrive in a later milestone.

- Native **EasySSH Manager** Activity Bar container with an ordered, nested,
  drag-and-drop **Connections** TreeView and complete connection/folder menus.
- Versioned, validated connection metadata in VS Code global state, including
  corruption recovery and serialized atomic updates.
- Passwords and key passphrases stored only through VS Code SecretStorage, with
  explicit keep, replace, clear, duplicate, and recursive-delete behavior.
- CSP- and nonce-protected connection editor with strict host-side request
  validation and agent-access policy controls.
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

## Current scope

SFTP browsing, remote editing, transfers, and MCP access are planned for
subsequent milestones. The extension includes no telemetry or background
service and never consults or writes OpenSSH `known_hosts`.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
