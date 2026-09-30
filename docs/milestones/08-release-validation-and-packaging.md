# Milestone 08 — Release Validation and Packaging

## Objective

Convert the feature-complete prerelease into a defensible Linux v1 release. Close requirement gaps, execute the full automated/manual/security/accessibility/performance matrix, freeze public contracts, finalize user and maintainer documentation, and produce a reproducible checksummed `1.0.0` VSIX attached to a tagged GitHub release.

This milestone adds no new product surface. Any discovered defect is fixed in its owning subsystem and receives a regression test before release.

## Prerequisites

- Milestones 01–07 exit criteria pass on the development branch.
- Every roadmap item has an owner, automated/manual evidence, and no unresolved security-critical issue.
- GitHub Actions can run Docker and Xvfb and can upload workflow/release artifacts.
- A non-production Linux SSH target is available for final real-host tests in addition to Docker fixtures.

## Deliverables

- Completed traceability audit from README requirements to implementation, tests, and release evidence.
- Green static, unit, Docker integration, extension-host, webview, transfer, MCP, security, accessibility, performance, and manual suites.
- Coverage meeting thresholds for unit-testable domain services.
- Final end-user, security, privacy, troubleshooting, MCP, architecture, contribution, and release documentation.
- Exact dependency/license/SBOM review and clean production package-content audit.
- Version `1.0.0`, release notes, reproducible VSIX, SHA-256 checksum, and tagged GitHub release artifact.
- Complete but unpublished Open VSX metadata/readiness checklist.

## Architecture and interfaces

The public extension, storage, URI, webview, IPC, and MCP contracts established by earlier milestones are frozen for `1.0.0`. This milestone validates those interfaces as an integrated release and defines the artifact/compatibility contracts below.

### Compatibility matrix

Run automated or recorded smoke tests on Linux for:

| Component | Required targets |
| --- | --- |
| VS Code | Pinned `engines.vscode` floor and latest stable compatible release |
| VSCodium | Corresponding floor build where available and latest stable release |
| Node for development/CI | Exact supported LTS line from lockfile/tooling |
| Node for MCP companion | Minimum supported version and current supported LTS |
| SSH server | Docker OpenSSH fixture and one non-production Linux OpenSSH host |
| Workspace | No workspace, trusted local single-root, trusted local multi-root, untrusted, and writable non-`file:` test provider |
| Auth | Password, unencrypted Ed25519, encrypted Ed25519, Linux SSH agent |

Windows and macOS must remain free of gratuitous path assumptions in shared code, but failures there do not block v1 and are documented as unsupported. Browser-hosted editors are explicitly unsupported.

### Required CI pipeline

Use separate least-privilege jobs with immutable lockfile installs:

1. **Static:** `npm ci`, formatting check, ESLint, strict `tsc --noEmit`, manifest validation, generated-contract freshness.
2. **Unit/coverage:** Vitest with deterministic time/random/UUID fixtures and coverage thresholds.
3. **Security/supply chain:** production/development dependency audit, license allowlist review, secret scan, prohibited API/string checks (`sshpass`, plaintext secret keys, remote webview sources), and SBOM generation.
4. **Docker integration:** OpenSSH fixture matrix for auth/trust/terminal/SFTP/transfers/MCP and forced-failure cases.
5. **Extension host:** Xvfb plus `@vscode/test-electron` against the API floor; a scheduled or release job also runs latest stable.
6. **Package:** clean production build, VSIX creation, content inspection, clean-profile install/activation smoke, and SHA-256 generation.

Pull requests require jobs 1–5. Release tags require every job plus manual release sign-off evidence. Tests must not rely on external production services or repository secrets for SSH credentials.

### Coverage policy

- Unit-testable domain/application services: at least 85% lines, 85% statements, and 80% branches, enforced by configured include paths rather than a misleading repository-wide average.
- Security-critical modules—credential boundaries, host verifier, URI/path validation, upload/download conflict engines, agent policy/root enforcement, IPC authentication, version tokens, and audit redaction—must have explicit success/failure/limit/revocation tests even when aggregate thresholds already pass.
- VS Code adapter/webview rendering code may use focused extension/manual evidence where meaningful unit instrumentation is impractical; exclusions are documented line-by-line, never broad directory omissions.
- No snapshot may contain a credential, private key, raw host key, remote file body, stdout/stderr, or raw agent command.

### Release artifact contract

- `package.json` version is `1.0.0`, publisher is `hassanm0301`, extension name is `easyssh-manager`, display name is `EasySSH Manager`, license is `GPL-3.0-only`, and repository/issues/homepage links are correct.
- Production package includes only runtime bundles, manifest, README/CHANGELOG/LICENSE/security/privacy docs, icons/media, and necessary notices.
- Exclude source tests, fixtures, Docker keys/config, coverage, local settings, `.env`, audit/discovery files, logs, Git metadata, planning docs unless deliberately linked for maintainers, and development source maps not approved by inspection.
- The installed extension may create global state/storage/SecretStorage only at runtime; the VSIX contains no user/site configuration.
- Build from a clean checkout with `npm ci`; record Node/npm versions, commit SHA, dependency-lock hash, VSIX SHA-256, size, and content list.
- A second clean build must produce semantically identical content. If byte-for-byte reproducibility is blocked by VSIX timestamp metadata, document it and compare normalized archive contents/hashes.
- Attach `hassanm0301.easyssh-manager-1.0.0.vsix`, matching `.sha256`, SBOM, and release notes to GitHub tag `v1.0.0`.
- Do not publish to Visual Studio Marketplace or Open VSX in v1. Validate Open VSX manifest/license/icon/README compatibility and document the later publish command/credential requirements without executing them.

## Validation workstreams

### Requirements and interface freeze

- Walk every row in the README coverage map and link it to a milestone exit criterion plus automated/manual evidence.
- Compare public commands, settings, view ids, context keys, storage keys/schema version, URI scheme, webview protocols, IPC version, and MCP tool schemas with docs/tests.
- Remove undocumented aliases and dead commands. Treat post-freeze breaking changes as release blockers requiring version/migration review.
- Load state fixtures for empty v1, populated v1, malformed v1, and future version; prove upgrades never expose/delete secrets unexpectedly.
- Verify reserved future fields such as `allowInteractiveShell` remain false and unavailable in v1 UI/tools.

### End-to-end human workflow matrix

Run from a clean editor profile:

1. First-run welcome, add folders/connections, manual reorder/reparent, edit/duplicate/delete, and reload persistence.
2. Stored/non-stored password and encrypted/unencrypted key plus agent authentication.
3. First-use trust, matching reconnect, changed-key block/retrust, Test Connection success/failures.
4. Concurrent SSH terminals, input/ANSI/full-screen app/resize/remote disconnect/local close.
5. SFTP panel navigation, restoration, status/reconnect, create/open/edit/save/conflict/rename/delete.
6. Binary/large-file warnings and normal image/text handling.
7. File/folder downloads with conflicts, progress, cancellation, links, virtual destination, and disconnect.
8. Trusted multi-root workspace upload by drag and picker with merges/overwrites/skips/cancel, links, large local/virtual files, and disconnect.
9. Untrusted-workspace restrictions without disabling direct connection/SSH/SFTP features.
10. Window reload/deactivation during active network/transfer work and zero-resource cleanup.

Record editor/server versions and pass/fail evidence. No step may require leaving the editor to manually shuttle a remote file.

### OpenSSH import matrix

- Concrete aliases, global/wildcard/negated defaults, directive case/precedence, includes/globs/loops/limits, tokens, multiple identities, duplicates, and missing/invalid fields.
- Unsupported ProxyJump/ProxyCommand/Match connectivity remains visible but blocked with remediation.
- Hash every source/include before/after and prove byte-for-byte equality.
- Search state, logs, webview data, snapshots, and packages to prove no password was invented/imported and no private-key content was copied.

### MCP workflow matrix

- Generate generic config, connect Codex and at least one other MCP-capable client manually, and record client versions.
- Test disabled discovery/calls, read-only roots, write-only/exec grants, all confirmation modes, approval/denial/expiry, size/time/concurrency limits, and clear errors.
- Attempt path traversal, lexical-prefix tricks, encoded separators, symlink escape/race, guessed connection ids, stale/forged version tokens, oversized frames, wrong/stale IPC credentials, and direct mutation without permission.
- Run discovery, exec, ranged UTF-8/base64 reads, atomic create/versioned/forced write, mkdir/rename/delete, recursive delete, cancellation, editor disconnect, and immediate revocation.
- Close VSCodium and verify no daemon/socket/discovery remains useful and companion returns the documented bounded error.
- Inspect audit rotation/view/export/clear and scan raw files for secret, command, stdout/stderr, and file-content sentinels.

### Security and privacy review

Create a test corpus with unique sentinels for password, passphrase, private key, host key, IPC token, command, stdout, stderr, and file content. Exercise every failure/success path, then scan:

- global/workspace state and recovery keys;
- SecretStorage fakes/keys without revealing values in output;
- Output Channel/log captures and notifications;
- serialized webview state/messages and developer-tools-visible initialization;
- URIs, command arguments, process list/config snippets, errors/stacks;
- audit/discovery/socket metadata and exports;
- test snapshots, coverage reports, production bundles/maps, VSIX contents, SBOM, and release logs.

Required conclusions:

- Only password/passphrase values reside in SecretStorage; private-key content is read transiently from its path.
- No secret/file/command/output content crosses MCP IPC except the explicit command/file payload required for the active call; none is persistently audited/logged.
- No telemetry, analytics, crash reporting, update beacon, or third-party runtime web request exists. SSH/SFTP remote traffic and user-invoked MCP IPC are the only operational transports.
- Webviews have strict CSP, no remote source, safe DOM writes, validated messages, and no Node access.
- Host-key changes, overwrites, recursive deletes, relaxed agent confirmation, and credential copying always require their defined explicit decisions.

### Accessibility and UX review

- Complete connection editor/import preview/SFTP/workspace core flows using keyboard only.
- Verify focus order/restoration, accessible names/roles/live regions, context menus, error association, and no icon/color-only meaning.
- Test default dark/light/high-contrast themes, 200% zoom, reduced motion expectations, long names/paths, Unicode/RTL text, narrow panel groups, and screen-reader announcements.
- Ensure progress/cancellation and partial failure summaries are understandable and no modal prompt storm occurs.
- Confirm notifications give connection/path context and actionable remediation without raw low-level errors.

### Performance and resilience review

Use repeatable fixtures and capture thresholds as regression baselines, not hardware-independent promises:

- Activation with 1,000 saved profiles/100 folders performs no network work and renders roots lazily.
- Opening an SFTP panel performs one remote listing and no recursive workspace/server scan.
- Browsing synthetic 10,000-entry directories remains responsive through incremental DOM rendering or bounded pagination strategy.
- Concurrent editor save, navigation, and a three-worker upload preserve save/navigation priority.
- Repeated panel/terminal open-close and forced reconnect cycles return handles/listeners/timers to baseline.
- Large-file warnings occur before full reads; virtual buffering and MCP output/frame limits fail before unbounded allocation.
- Fuzzed URI/path/webview/IPC/OpenSSH inputs terminate under defined size/depth/time limits.

## Implementation checklist

- [ ] Create a requirements-to-test evidence checklist from the README coverage map and resolve every missing owner.
- [ ] Freeze and document commands/settings/context keys/storage/URI/webview/IPC/MCP contracts.
- [ ] Enforce coverage thresholds and add targeted tests for every security-critical branch.
- [ ] Complete compatibility, auth, workspace, transfer, import, MCP, adversarial, accessibility, and performance matrices.
- [ ] Run sentinel-based privacy scan across runtime state and release artifacts; resolve every match.
- [ ] Run dependency vulnerability/license review, generate SBOM/notices, and update or explicitly risk-accept non-critical findings.
- [ ] Finalize README usage sections plus `CHANGELOG.md`, `SECURITY.md`, privacy statement, architecture, troubleshooting, MCP setup, development, and contribution docs.
- [ ] Verify no docs claim Windows/macOS/browser/marketplace/telemetry support.
- [ ] Remove development-only commands/flags and ensure production logging defaults to `info` without payloads.
- [ ] Set `1.0.0`, build twice from clean checkouts, inspect/compare artifacts, install-smoke VSIX, and generate SHA-256/SBOM.
- [ ] Create signed-off release notes listing features, security model, prerequisites, known limitations, deferred items, and checksum verification.
- [ ] Tag `v1.0.0` only after documented maintainer approval; attach artifacts through GitHub Actions.
- [ ] Validate Open VSX readiness but do not publish.

## Automated tests

- All prior milestone suites run from one top-level `npm run check` plus clearly separated Docker/extension/release jobs.
- Manifest contribution test snapshots exact public ids/settings/defaults/menus/activation events/capabilities.
- State migration/corruption/future-version fixtures and SecretStorage reconciliation.
- End-to-end Docker matrix for auth/trust/terminal/SFTP/provider/browser/download/upload/MCP and injected disconnect/permission/conflict failures.
- Extension-host activation, TreeView, provider read/save, panel restoration, workspace-trust gating, and deactivation leak assertions.
- Webview CSP/protocol/accessibility DOM tests and malicious-message corpus.
- Path/URI/OpenSSH/IPC fuzz/property tests with fixed seeds and stored minimal regressions.
- Secret/privacy sentinel scan and VSIX allowlist/content test.
- Reproducible normalized archive comparison and clean-profile install/activate command smoke.

## Manual acceptance tests

1. Execute every human workflow matrix item on supported VSCodium and VS Code floor/latest builds.
2. Repeat critical SSH/SFTP flows against Docker and a separate non-production Linux OpenSSH host.
3. Complete connection, import, browser, download, and upload flows keyboard-only in dark/light/high-contrast themes.
4. Test generic MCP setup with Codex and another MCP client, including revocation and editor-closed behavior.
5. Inspect editor global storage/state/logs, running processes, temp/runtime directories, and packaged files using sentinel searches.
6. Install the final VSIX into clean editor profiles, restart, run release smoke workflows, uninstall, and confirm no active process/socket remains.
7. Download the GitHub artifact, verify its SHA-256, and install that exact downloaded file.

## Exit criteria

- Every README coverage row has passing implementation/test evidence and every prior milestone remains green.
- Coverage meets 85% lines/statements and 80% branches for declared unit-testable modules; critical paths have explicit branch evidence.
- Supported editor/auth/workspace/server matrices and both MCP clients pass with recorded versions.
- Security/privacy review finds no credential/private-key/raw-key/content leakage, unauthorized path/tool access, unauthenticated listener, or telemetry.
- Accessibility/performance/resilience reviews have no release-blocking issue and known limitations are documented.
- Clean `1.0.0` VSIX installs and passes smoke tests; artifact contents, normalized reproducibility, SBOM, and SHA-256 are verified.
- GitHub `v1.0.0` release contains the intended VSIX/checksum/SBOM/notes. No marketplace publication occurred.

## Risks and mitigations

- **Late cross-cutting defects:** freeze feature scope, fix in owning layer, require regression tests, and rerun affected/full matrices based on risk.
- **Dependency vulnerability/license conflict:** exact pinning, audit/SBOM/license review, remove or replace incompatible packages before release.
- **Editor-version drift:** retain floor fixtures and execute latest on scheduled/release builds.
- **False confidence from coverage:** enforce adversarial scenario evidence for security-critical boundaries independent of percentages.
- **Non-reproducible VSIX metadata:** compare normalized content and document tool metadata while preserving commit/lock/checksum provenance.
- **Accidental publication or telemetry:** release workflow attaches artifacts only; automated tests prohibit marketplace commands and runtime analytics endpoints.

## Non-goals

- New features, UI redesigns, or expansion beyond the frozen v1 contracts.
- Open VSX or Visual Studio Marketplace publication.
- Formal Windows/macOS support or browser/mobile builds.
- Telemetry, crash reporting, background daemons, auto-update services, or cloud accounts.
- Implementing any item listed as deferred in the README.
