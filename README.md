# EasySSH Manager

EasySSH Manager is a Linux desktop extension for VSCodium and VS Code that will
bring SSH and SFTP connection management into the editor. It runs in the local
UI extension host so future credentials, private keys, SSH agent access, and
connection state remain on the user's machine, including when a remote
workspace is open.

## Implemented features

The current release provides the extension foundation and local connection
management. It intentionally does not establish SSH or SFTP connections yet.

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
- Docker OpenSSH fixture skeleton and Linux GitHub Actions checks for future
  SSH/SFTP integration testing.

## Current scope

SSH terminals, host trust, SFTP browsing, remote editing, transfers, and MCP
access are planned for subsequent milestones. Connection actions remain clear
placeholders until their transport milestones. The extension performs no
network connection and includes no telemetry or background service.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
