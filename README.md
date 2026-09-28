# EasySSH Manager

EasySSH Manager is a Linux desktop extension for VSCodium and VS Code that will
bring SSH and SFTP connection management into the editor. It runs in the local
UI extension host so future credentials, private keys, SSH agent access, and
connection state remain on the user's machine, including when a remote
workspace is open.

## Implemented features

The current release provides the extension foundation; it intentionally does
not establish SSH or SFTP connections yet.

- Native **EasySSH Manager** Activity Bar container with an empty
  **Connections** TreeView and refresh command.
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

Connection profiles, credential storage, OpenSSH import, SSH terminals, SFTP
browsing, remote editing, transfers, and MCP access are planned for subsequent
milestones. No credentials, network connections, telemetry, or background
services are implemented at this stage.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
