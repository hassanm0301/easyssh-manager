# Milestone 01 — Foundation and Architecture

## Objective

Create a production-shaped, activatable EasySSH Manager extension skeleton whose build, test, dependency, configuration, logging, lifecycle, and packaging boundaries are stable enough for all later milestones. No real SSH or SFTP connection is made in this milestone.

The deliverable must run in the local desktop UI extension host, compile under strict TypeScript, expose an empty native connection view, and produce an installable development VSIX. Every service introduced later must have a defined ownership and disposal boundary rather than accumulating in `extension.ts`.

## Prerequisites

- Linux development host with current Node.js LTS, npm, Git, Docker, and VSCodium/VS Code.
- GitHub Actions enabled for the repository.
- Decisions in the repository README treated as fixed requirements.

## Deliverables

- npm project and committed lockfile for extension id `hassanm0301.easyssh-manager`.
- GPL-3.0-only `LICENSE`, package metadata, development scripts, and `.vscodeignore`.
- Strict TypeScript builds for extension-host, webview, and later MCP entry points using esbuild plus a separate `tsc --noEmit` gate.
- Native Activity Bar container and empty `easysshManager.connections` TreeView with welcome content.
- Central composition root, configuration facade, typed command registry, domain-error base types, secret-redacting logger, and disposable ownership utility.
- Vitest unit harness, `@vscode/test-electron` extension-host harness, Docker OpenSSH fixture skeleton, and Linux GitHub Actions workflow.
- Development and production VSIX packaging commands with an artifact-content inspection step.

## Architecture and interfaces

### Package and runtime contract

- `package.json` uses `main` only; it has no browser entry point.
- Set `extensionKind: ["ui"]` so credentials, private keys, SSH agent access, IPC, and connection state live on the user's local machine even for remote workspaces.
- Set `capabilities.untrustedWorkspaces.supported` to `limited` and describe the workspace upload restriction. Milestone 06 enforces that restriction.
- Select the stable VS Code API version current at implementation bootstrap as `engines.vscode`. Record it in the lockfile/CI matrix and test both that floor and latest stable in Milestone 08.
- Activation is event-driven through the contributed view, commands, and `remote-sftp` filesystem use; never use an unconditional startup activation event.
- Public ids use `easysshManager.*`. The future filesystem scheme remains `remote-sftp`.

### Build boundaries

Use independent esbuild entry points so code is not accidentally shared across trust boundaries:

```text
src/extension.ts                       -> dist/extension.js
src/views/**/webview/main.ts           -> dist/webview/*.js
src/mcp/companion.ts                   -> dist/mcp/companion.js (Milestone 07)
```

- Externalize `vscode` from extension-host builds.
- Webview bundles must not include Node built-ins or extension-host services.
- Production builds disable inline source embedding. If source maps ship for diagnostics, inspect them for fixtures, absolute local paths, and secrets before packaging.
- esbuild performs bundling only; `tsc --noEmit` remains the authoritative type gate.

### Composition and lifecycle

`activate(context)` constructs a single `ExtensionApplication` composition root. The root owns services in dependency order and disposes them in reverse order.

```ts
interface AsyncDisposable {
  dispose(): void | Promise<void>;
}

interface ConfigurationService {
  getSnapshot(): Readonly<EasySshConfiguration>;
  readonly onDidChange: vscode.Event<Readonly<EasySshConfiguration>>;
}

interface CommandDefinition<TArgs extends unknown[], TResult> {
  readonly id: `easysshManager.${string}`;
  execute(...args: TArgs): Promise<TResult>;
}
```

`extension.ts` may register the composition root and delegate activation/deactivation; it must not contain persistence, SSH, SFTP, or webview business logic.

### Error model

Define a stable base with machine-readable codes and user-safe messages:

```ts
type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AUTHENTICATION'
  | 'HOST_KEY_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'CONNECTION_LOST'
  | 'CANCELLED'
  | 'OUTPUT_LIMIT';

class EasySshError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly cause?: unknown,
  ) { super(message); }
}
```

Low-level causes are logged only after redaction. Notifications receive contextual, actionable messages rather than raw `ssh2`, filesystem, or validation objects.

### Logging contract

Create one Output Channel named `EasySSH Manager` with `error`, `warn`, `info`, and `debug` levels; default to `info`.

- Structured fields use an allowlist. Never serialize arbitrary objects.
- Redact keys matching password, passphrase, privateKey, secret, token, authorization, content, stdout, and stderr, case-insensitively.
- Do not log file bodies, authentication payloads, raw host keys, IPC frames, or webview payloads.
- Hostnames, usernames, paths, and commands are operationally sensitive. Human-operation logs may include a hostname/path only at `debug`; MCP audit policy is defined separately in Milestone 07.
- Logging must not throw and must tolerate disposed output channels during shutdown.

### Configuration defaults

Declare settings with runtime validation and safe fallback values:

| Setting | Type/default | Bounds |
| --- | --- | --- |
| `easysshManager.connectTimeoutMs` | integer / `15000` | 1,000–120,000 |
| `easysshManager.keepAliveIntervalMs` | integer / `15000` | 0–300,000; 0 disables |
| `easysshManager.keepAliveCountMax` | integer / `3` | 1–20 |
| `easysshManager.sftpIdleTimeoutMs` | integer / `180000` | 10,000–1,800,000 |
| `easysshManager.maxInlineFileSizeMiB` | number / `20` | 1–1,024 |
| `easysshManager.maxBufferedTransferMiB` | number / `64` | 1–2,048 |
| `easysshManager.logLevel` | enum / `info` | error, warn, info, debug |

MCP-specific limits are contributed in Milestone 07. No setting may accept credentials.

### Initial module ownership

```text
src/
  extension.ts
  application/ExtensionApplication.ts
  commands/CommandRegistry.ts
  common/{disposables,errors,logger,validation}.ts
  configuration/ConfigurationService.ts
  connections/{types,ports}.ts
  ssh/ports.ts
  sftp/ports.ts
  views/connections/ConnectionsTreeProvider.ts
  test/{unit,integration,extension}/
```

Ports define capabilities without prematurely implementing network behavior. UI modules depend on application services or ports, never directly on `ssh2`.

## Implementation checklist

- [x] Initialize npm metadata, exact scripts, lockfile, GPL license, supported OS declaration, repository URL, and `0.1.0` prerelease version.
- [x] Pin exact production/dev dependency versions after checking their engine and license compatibility.
- [x] Configure strict TypeScript including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and casing consistency.
- [x] Configure esbuild development/watch/production modes and externalize `vscode`.
- [x] Configure ESLint and Prettier so CI checks without rewriting files.
- [x] Add commands for `clean`, `typecheck`, `lint`, `format:check`, `test:unit`, `test:integration`, `test:extension`, `coverage`, `build`, `package`, and `check`.
- [x] Contribute the Activity Bar container, TreeView, welcome text, refresh command, configuration schema, and codicon-based icons.
- [x] Implement the composition root, reverse-order disposal, logger, configuration validation, command wrapper, and top-level error presentation.
- [x] Ensure command execution catches unknown failures, maps them to a correlation id, logs safely, and shows one notification.
- [x] Add unit and extension-host fixtures without storing real credentials.
- [x] Add a deterministic Docker image/config capable of later password, Ed25519, encrypted-key, host-key rotation, SFTP, permission, and disconnect tests.
- [x] Add GitHub Actions jobs for static checks/unit tests and an Xvfb/Docker integration lane.
- [x] Package a VSIX and list its contents to prove tests, fixtures, private configs, and local environment files are excluded.

## Automated tests

- Configuration rejects invalid types/ranges and returns documented defaults.
- Logger redacts each forbidden key recursively, does not inspect arbitrary prototypes, and never emits a supplied sentinel secret.
- Command wrapper distinguishes known domain errors, cancellation, and unknown errors.
- Disposable store disposes once, in reverse order, and continues after one disposal failure.
- TreeView activates through its contributed view and renders the empty-state command.
- Extension activates/deactivates repeatedly without leaked event emitters or unhandled rejections.
- Production build contains all declared entry points and no unresolved runtime imports.
- VSIX content allowlist test fails if `.env`, SSH material, test keys, coverage output, or repository-only files enter the package.

## Manual acceptance tests

1. Run clean install, type-check, lint, unit tests, extension tests, production build, and VSIX packaging from a fresh clone.
2. Launch the extension development host in VSCodium and VS Code on Linux.
3. Open the EasySSH Manager Activity Bar view and confirm native empty-state content appears.
4. Change log level and timeout settings; confirm valid changes apply and invalid edits receive editor schema feedback.
5. Install the development VSIX in VSCodium, reload, open the view, and uninstall it cleanly.
6. Close the development host and confirm the process has no lingering timers or sockets attributable to the extension.

## Exit criteria

- All static, unit, extension-host, packaging, and VSIX-content checks pass in Linux CI.
- The extension activates, renders its empty TreeView, and deactivates without errors in both desktop editors.
- Public ids, configuration defaults, build boundaries, and lifecycle ownership are documented and have no unresolved implementation choices.
- A packaged development VSIX is installable, contains only intended runtime assets, and requires no proprietary extension.
- No real SSH/SFTP logic, credentials, telemetry, or background daemon has been introduced.

## Risks and mitigations

- **Editor API drift:** pin an engine floor and test latest separately; do not use proposed APIs.
- **Native/optional dependency packaging:** inspect bundled output and install the VSIX in a clean environment before accepting the milestone.
- **Webview code leaking Node capabilities:** enforce distinct browser builds and lint restrictions.
- **Logger secret leakage:** centralize logging, allowlist fields, and keep sentinel-based leak tests permanently in CI.
- **Overgrown composition root:** construct services centrally but keep behavior in subsystem modules.

## Non-goals

- Persisting connections or credentials.
- Parsing OpenSSH files.
- Establishing SSH/SFTP connections.
- Implementing functional connection forms, remote filesystem providers, transfers, MCP, telemetry, or marketplace publication.
