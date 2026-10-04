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

## Milestone completion checklist

This checklist is the authoritative completion gate for Milestone 08 and the `1.0.0` release. Check an item only after its implementation and recorded evidence satisfy the detailed requirements below. The milestone is complete only when every item is checked; no implementation, defect fix, regression test, documentation, validation, packaging, approval, or release task described by this milestone may remain.

### Entry gate, traceability, and contract freeze

- [ ] Re-run and record all Milestones 01–07 exit criteria, automated suites, human workflows, package checks, and security gates as passing on the intended release commit.
- [ ] Confirm every README roadmap/coverage row has an owner plus links to its milestone exit criterion, implementation, automated evidence, manual evidence, and release artifact where applicable.
- [ ] Resolve every missing owner/evidence row and every open security-critical or release-blocking issue; fix defects in their owning subsystem and add regression tests before continuing.
- [ ] Inventory and freeze all public commands, settings/defaults, view ids, context keys, menus, activation events, capabilities, storage keys/schema versions, URI scheme, webview messages, IPC version, and MCP schemas.
- [ ] Remove undocumented aliases/dead commands and complete migration/version review for every necessary post-freeze contract change.
- [ ] Test empty, populated, malformed, and future-version state fixtures and prove upgrades/reconciliation neither expose nor unexpectedly delete secrets.
- [ ] Verify reserved future fields such as `allowInteractiveShell` remain false and unavailable through v1 UI, configuration, IPC, and tools.
- [ ] Record the exact release commit SHA, lockfile hash, supported Node/npm versions, editor/API floor, companion Node range, and all compatibility-test versions.

### CI, coverage, and automated release gates

- [ ] Implement a least-privilege immutable-install Static CI job running `npm ci`, formatting, ESLint, strict `tsc --noEmit`, manifest validation, and generated-contract freshness checks.
- [ ] Implement a deterministic Unit/Coverage CI job with fixed time/random/UUID fixtures and configured include paths for unit-testable domain/application services.
- [ ] Enforce at least 85% line, 85% statement, and 80% branch coverage for declared unit-testable modules without misleading repository-wide averaging or broad exclusions.
- [ ] Document each focused adapter/webview coverage exclusion line-by-line and add meaningful extension/manual evidence for excluded behavior.
- [ ] Add explicit success, failure, boundary, and revocation tests for credentials, host verification, URI/path checks, transfer conflict engines, agent roots/policy, IPC auth, version tokens, and audit redaction regardless of aggregate coverage.
- [ ] Implement a Security/Supply-chain CI job covering production/development audits, license allowlisting, secret scans, prohibited APIs/strings/sources, and SBOM/notices generation.
- [ ] Implement a Docker Integration CI job covering auth, trust, terminal, provider, browser, transfers, MCP, and injected permission/disconnect/conflict/limit failures without production services or repository-secret credentials.
- [ ] Implement an Xvfb Extension-host CI job against the pinned API floor and a scheduled/release run against latest compatible stable VS Code.
- [ ] Implement a Package CI job performing a clean production build, VSIX creation/content allowlist, normalized reproducibility check, clean-profile install/activation smoke, and SHA-256 generation.
- [ ] Make Static, Unit/Coverage, Security, Docker, and Extension-host jobs required for pull requests and require every job plus recorded manual sign-off for a release tag.
- [ ] Expose all prior local suites through one top-level `npm run check` with separately callable/documented Docker, extension-host, and release jobs.
- [ ] Add exact manifest contribution snapshots and state migration/corruption/future-version plus SecretStorage reconciliation tests.
- [ ] Add fixed-seed path/URI/OpenSSH/webview/IPC fuzz/property tests and retain every discovered minimal regression.
- [ ] Add secret/privacy sentinel, VSIX allowlist/content, normalized archive comparison, and clean-profile install/activate command smoke tests.
- [ ] Run every CI/local automated gate on the release commit and record links/logs/artifacts with no ignored, flaky, unexpectedly skipped, or failing required test.

### Compatibility and end-to-end human workflows

- [ ] Test the pinned `engines.vscode` floor and latest compatible stable VS Code on Linux and record exact versions/results.
- [ ] Test corresponding floor-available and latest stable VSCodium builds on Linux and record exact versions/results.
- [ ] Test the exact development/CI Node LTS plus the companion's minimum and current supported Node LTS releases.
- [ ] Test Docker OpenSSH and one separate non-production Linux OpenSSH host without using production data or credentials.
- [ ] Test no-workspace, trusted local single-root, trusted local multi-root, untrusted, and writable non-`file:` workspace-provider scenarios.
- [ ] Test password, stored/non-stored password, encrypted/unencrypted Ed25519 key, and Linux SSH-agent authentication as applicable.
- [ ] Confirm shared code has no gratuitous Windows/macOS path assumptions while clearly documenting Windows, macOS, and browser-hosted editors as unsupported for v1.
- [ ] From clean editor profiles, verify first-run UI and connection/folder add, edit, duplicate, reorder/reparent, delete, reload, and persistence workflows.
- [ ] Verify first-use host trust, matching reconnect, changed-key block/retrust, and Test Connection success/failure workflows.
- [ ] Verify concurrent SSH terminals, input, ANSI/full-screen apps, resize, remote disconnect, and local close.
- [ ] Verify SFTP navigation/restoration/status/reconnect plus create/open/edit/save/conflict/rename/delete, binary/large-file warnings, and normal image/text handling.
- [ ] Verify file/folder downloads with hierarchy, conflicts, links, virtual destinations, progress, cancellation, partial failure, and disconnect.
- [ ] Verify trusted multi-root drag/picker uploads with hierarchy, merges, overwrites, skips, cancellation, links, large local/virtual files, and disconnect.
- [ ] Verify untrusted workspace restrictions do not disable direct connection management, SSH terminals, or remote SFTP features.
- [ ] Verify window reload/deactivation during active network/transfer work produces bounded truthful outcomes and zero managed-resource leaks.
- [ ] Record editor/server/client versions plus pass/fail evidence for every workflow, and confirm no supported flow requires leaving the editor to shuttle remote files manually.

### OpenSSH import and MCP release matrices

- [ ] Run the full OpenSSH import matrix for concrete aliases, global/wildcard/negated defaults, case/precedence, includes/globs/loops/limits, tokens, identities, duplicates, and missing/invalid fields.
- [ ] Verify unsupported ProxyJump/ProxyCommand/Match connectivity remains visible but blocked with actionable remediation.
- [ ] Hash every OpenSSH source/include before and after import and prove byte-for-byte immutability.
- [ ] Scan import state, logs, webview messages, snapshots, and packages to prove no password invention/import and no copied private-key content.
- [ ] Generate generic MCP configuration and connect Codex plus at least one other MCP-capable client, recording client and Node versions.
- [ ] Test disabled discovery/direct calls, read-only roots, independent write/exec grants, all confirmation modes, approval/denial/expiry, and time/size/concurrency limits.
- [ ] Attempt traversal, lexical-prefix and encoded-separator tricks, symlink escape/race, guessed connection ids, stale/forged versions, oversized frames, wrong/stale IPC credentials, and direct mutation without permission.
- [ ] Exercise discovery, exec, ranged UTF-8/base64 read, atomic create/versioned/forced write, mkdir/rename/delete/recursive delete, cancellation, editor disconnect, and immediate revocation with both clients where supported.
- [ ] Close VSCodium and verify no daemon/socket/discovery remains useful and the companion returns its documented bounded editor-unavailable error.
- [ ] Verify audit rotation/view/export/clear and scan raw audit/config/discovery/log/process data for secret, raw-command, stdout/stderr, and file-content sentinels.

### Security, privacy, accessibility, and resilience review

- [ ] Create unique sentinels for password, passphrase, private key, host key, IPC token, command, stdout, stderr, and file content and exercise every relevant success/failure path.
- [ ] Scan global/workspace state, recovery keys, SecretStorage identifiers/fakes, logs/output/notifications, webview state/messages, URIs/arguments/processes, errors/stacks, IPC/audit/runtime metadata, snapshots/coverage, bundles/maps, VSIX, SBOM, and release logs.
- [ ] Investigate every sentinel match and prove only password/passphrase values reside in SecretStorage while private-key content is read transiently from its configured path.
- [ ] Prove credentials/private keys never cross MCP IPC and explicit command/file/output payloads cross only for the active authorized call and are never persistently audited or logged.
- [ ] Prove no telemetry, analytics, crash reporting, update beacon, third-party runtime web request, unauthenticated listener, or background daemon exists.
- [ ] Verify every webview has strict CSP, no remote source/Node access, safe DOM writes, exact validated messages, and no credential/content exposure.
- [ ] Verify host-key changes, credential copies, overwrites, recursive deletes, and relaxed agent confirmations always require their specified explicit user decisions.
- [ ] Complete connection editor, import preview, SFTP, workspace, download, and upload core flows using keyboard only.
- [ ] Verify focus order/restoration, accessible roles/names/live regions, context menus, error association, progress/cancellation summaries, and no icon/color/hover/drag-only meaning.
- [ ] Test dark, light, and high-contrast themes at 200% zoom with reduced-motion expectations, narrow groups, long paths, Unicode/RTL, and screen-reader announcements.
- [ ] Verify notifications provide connection/path context and remediation without raw low-level errors, sensitive payloads, or modal prompt storms.
- [ ] Measure activation with 1,000 profiles/100 folders and prove no startup network work and lazy root rendering.
- [ ] Measure SFTP panel open and prove one remote listing with no recursive local/remote scan.
- [ ] Exercise synthetic 10,000-entry directories with responsive bounded/incremental rendering or pagination and record regression baselines.
- [ ] Verify concurrent save/navigation/three-worker upload prioritization and repeated panel/terminal/reconnect cycles returning handles/listeners/timers to baseline.
- [ ] Verify large-file warnings and virtual/MCP limits fail before full reads or unbounded allocation.
- [ ] Fuzz URI/path/webview/IPC/OpenSSH inputs under fixed size/depth/time limits and record termination/baseline evidence.
- [ ] Resolve every release-blocking accessibility, performance, resilience, privacy, or security finding and document all accepted non-blocking limitations.

### Documentation, supply chain, and package contents

- [ ] Finalize README installation/prerequisites/connection/auth/trust/terminal/SFTP/download/upload/MCP/security/privacy/troubleshooting/support sections against the frozen product behavior.
- [ ] Finalize `CHANGELOG.md`, `SECURITY.md`, privacy statement, architecture, troubleshooting, MCP setup, development, contribution, and release-process documentation.
- [ ] Document supported Linux/editor/Node/OpenSSH matrices, known limitations, deferred features, recovery behavior, data/storage locations, and the absence of telemetry/cloud accounts.
- [ ] Verify no documentation claims Windows, macOS, browser/mobile, marketplace publication, telemetry, sync, or another deferred/unsupported feature.
- [ ] Remove development-only commands/flags, prohibit sensitive debug payloads, and verify production logging defaults to `info` with sanitized metadata only.
- [ ] Run exact production/development dependency vulnerability and license reviews, generate SBOM/notices, and update/remove dependencies or record explicit maintainer risk acceptance for non-critical findings.
- [ ] Set manifest version `1.0.0` and verify publisher/name/display name/license/repository/issues/homepage fields exactly match the release artifact contract.
- [ ] Configure the production package to include only runtime bundles, manifest, README/CHANGELOG/LICENSE/security/privacy docs, approved icons/media, and required notices.
- [ ] Prove the VSIX excludes source tests/fixtures, Docker keys/config, coverage, local settings, `.env`, audit/discovery/log files, Git data, unintended planning docs, unapproved source maps, and all user/site state.
- [ ] Validate Open VSX manifest/license/icon/README readiness and document future command/credential requirements without publishing to Open VSX or Visual Studio Marketplace.

### Reproducible artifact and release publication

- [ ] Build `hassanm0301.easyssh-manager-1.0.0.vsix` from a clean checkout using `npm ci` and record Node/npm versions, commit SHA, lockfile hash, file size, and complete content list.
- [ ] Build a second time from another clean checkout/environment and prove byte-for-byte equality or document VSIX timestamp metadata while proving normalized archive contents and hashes are identical.
- [ ] Inspect the final VSIX content allowlist and run install/activation plus representative SSH/SFTP/upload/MCP smoke workflows in clean VS Code and VSCodium profiles.
- [ ] Generate and independently verify the final VSIX SHA-256 file and generate the matching final SBOM/notices artifact.
- [ ] Write release notes covering features, security/trust model, prerequisites, supported matrix, known limitations, deferred work, install/uninstall, and checksum verification.
- [ ] Obtain and record explicit maintainer approval of the exact commit, test evidence, risk acceptances, release notes, VSIX, checksum, SBOM, and normalized reproducibility result.
- [ ] Create tag `v1.0.0` only after approval and let the release GitHub Actions workflow rebuild/verify rather than substituting an unreviewed local artifact.
- [ ] Publish the GitHub release with the intended VSIX, matching `.sha256`, SBOM, and release notes attached; publish to no marketplace.
- [ ] Download the exact GitHub artifacts, independently verify SHA-256/content, install the downloaded VSIX into clean profiles, restart, run release smoke workflows, uninstall, and verify no process/socket remains.
- [ ] Confirm the GitHub tag/release and attached artifacts point to the approved commit and record permanent evidence links in the release checklist.
- [ ] Confirm every Milestone 08 deliverable, exit criterion, compatibility/security/accessibility/performance gate, risk mitigation, and stated non-goal boundary is satisfied with no remaining implementation, defect, test, documentation, packaging, approval, or release task.

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
