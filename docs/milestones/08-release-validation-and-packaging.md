# Milestone 08 — Release Validation and Packaging

## Goal

Turn the feature-complete prerelease into a defensible Linux `1.0.0` release. This milestone adds no new product surface. Fix discovered defects in their owning subsystem, add regression tests, freeze public contracts, execute the complete release matrix, finalize documentation, and publish a reproducible checksummed VSIX on GitHub.

Native Windows client support adds the separate
[Windows acceptance checklist](../windows-support.md) to these Linux-first gates.
Windows support must pass both CI and manual Windows 11 x64 validation before
publication. Windows MCP remains unavailable pending its own security port.

Do not publish to Visual Studio Marketplace or Open VSX in v1.

## Goal-mode rules

- Work top-to-bottom.
- Treat new features/UI redesign/scope expansion as out of scope.
- Check an item only when implementation plus recorded evidence pass.
- Fix every release defect in the owning subsystem and add a regression test.
- Record exact versions for every editor/server/client/runtime used in release evidence.
- Do not create tag `v1.0.0` until every earlier release gate is complete.

---

## 1. Entry gate and traceability

- [ ] **Re-run Milestones 01–07 on the intended release commit and record them green.**
  - Exit criteria, automated suites, human workflows, package checks, and security gates.

- [ ] **Confirm release infrastructure is available.**
  - GitHub Actions can run Docker and Xvfb and upload artifacts.
  - A separate non-production Linux OpenSSH host is available for final real-host tests.

- [ ] **Complete the README/roadmap traceability map.**
  - Every row has an owner and links to its milestone exit criterion, implementation, automated evidence, manual evidence, and release artifact where applicable.
  - Resolve every missing row/evidence link and every security-critical/release-blocking issue before continuing.

- [ ] **Record the exact release inputs.**
  - Commit SHA, lockfile hash, development/CI Node and npm versions, `engines.vscode` floor, companion Node range, and all compatibility-test versions.

---

## 2. Freeze public v1 contracts

- [ ] **Inventory and freeze every public contract.**
  - Commands, settings/defaults, view ids, context keys, menus, activation events/capabilities, storage keys/schema versions, URI scheme, webview messages, IPC version, MCP schemas.

- [ ] **Reconcile contracts with docs/tests.**
  - Remove undocumented aliases and dead commands.
  - Any necessary post-freeze breaking change requires explicit version/migration review and blocks release until resolved.

- [ ] **Validate state-version behavior.**
  - Empty v1, populated v1, malformed v1, and future-version fixtures.
  - Upgrades/reconciliation must neither expose nor unexpectedly delete secrets.
  - Include SecretStorage reconciliation tests.

- [ ] **Keep reserved future functionality unavailable.**
  - `allowInteractiveShell` and equivalent deferred fields remain false/inaccessible through v1 UI, config, IPC, and tools.

---

## 3. Required CI pipeline

- [ ] **Static job is least-privilege and green.**
  - `npm ci`, formatting, ESLint, strict `tsc --noEmit`, manifest validation, generated-contract freshness.

- [ ] **Unit/Coverage job is deterministic and green.**
  - Fixed time/random/UUID fixtures.
  - Coverage applies to declared unit-testable domain/application modules, not a misleading whole-repo average.
  - Thresholds: ≥85% lines, ≥85% statements, ≥80% branches.
  - Adapter/webview exclusions are documented line-by-line and backed by extension/manual evidence.

- [ ] **Security-critical modules have explicit scenario tests regardless of coverage percentage.**
  - Credentials, host verifier, URI/path validation, transfer conflict engines, agent policy/root enforcement, IPC auth, version tokens, audit redaction, and revocation.
  - No snapshot contains credentials, private keys, raw host keys, remote file bodies, stdout/stderr, or raw agent commands.

- [ ] **Security/Supply-chain job is green.**
  - Production/development dependency audits, license allowlist, secret scan, prohibited API/string checks (`sshpass`, plaintext secret keys, remote webview sources), SBOM/notices generation.

- [ ] **Docker Integration job is green.**
  - Auth, trust, terminal, SFTP/provider/browser, transfers, MCP, and injected permission/disconnect/conflict/limit failures.
  - No external production service or repository-secret SSH credential dependency.

- [ ] **Extension-host job is green.**
  - Xvfb + `@vscode/test-electron` against API floor.
  - Scheduled/release job against latest compatible stable VS Code.
  - Activation, TreeView/public contributions, provider read/save, panel restoration, workspace-trust gating, deactivation leak assertions.

- [ ] **Package job is green.**
  - Clean production build, VSIX creation, content allowlist, normalized reproducibility check, clean-profile install/activation smoke, SHA-256.

- [ ] **Enforce the required branch/tag gates.**
  - PRs require Static, Unit/Coverage, Security, Docker, and Extension-host jobs.
  - Release tags require every job plus recorded manual sign-off.
  - Expose normal local suites under `npm run check`; keep Docker/extension/release jobs separately callable/documented.

---

## 4. Final automated regression set

- [ ] **Freeze manifest/state contracts in tests.**
  - Snapshot exact public ids/settings/defaults/menus/activation events/capabilities.
  - State migration/corruption/future-version and SecretStorage reconciliation tests.

- [ ] **Run fixed-seed fuzz/property suites.**
  - Path, URI, OpenSSH, webview-message, and IPC inputs.
  - Keep every discovered minimal regression permanently.

- [ ] **Run privacy/package reproducibility suites.**
  - Secret/privacy sentinels, VSIX allowlist/content, normalized archive comparison, clean-profile install/activate command smoke.

- [ ] **Run every CI/local automated gate on the release commit.**
  - Record links/logs/artifacts.
  - No ignored, flaky, unexpectedly skipped, or failing required test remains.

---

## 5. Compatibility matrix

- [ ] **Editors pass on Linux.**
  - VS Code: pinned `engines.vscode` floor and latest compatible stable.
  - VSCodium: corresponding floor build where available and latest stable.
  - Record exact versions/results.

- [ ] **Node/server targets pass.**
  - Exact development/CI Node LTS.
  - MCP companion minimum supported Node and current supported LTS.
  - Docker OpenSSH fixture and one separate non-production Linux OpenSSH host.

- [ ] **Workspace modes pass.**
  - No workspace.
  - Trusted local single-root.
  - Trusted local multi-root.
  - Untrusted.
  - Writable non-`file:` provider.

- [ ] **Authentication modes pass.**
  - Password, stored/non-stored password, unencrypted Ed25519, encrypted Ed25519, Linux SSH agent.

- [ ] **Unsupported-platform expectations are accurate.**
  - Shared code has no gratuitous Windows/macOS path assumptions.
  - Windows, macOS, and browser-hosted editors are clearly documented unsupported for v1.
  - Their failures do not block Linux v1 unless they expose a shared defect relevant to Linux.

---

## 6. Clean-profile end-to-end human workflows

- [ ] **First-run and connection management pass.**
  - Welcome; add folders/connections; reorder/reparent; edit/duplicate/delete; reload persistence.

- [ ] **Authentication and host-trust flows pass.**
  - Stored/non-stored password, encrypted/unencrypted key, SSH agent.
  - First-use trust, matching reconnect, changed-key block/retrust, Test Connection success/failures.

- [ ] **SSH terminal flows pass.**
  - Concurrent terminals, input, ANSI, full-screen app, resize, remote disconnect, local close.

- [ ] **SFTP editor/browser flows pass.**
  - Navigation/restoration/status/reconnect, create/open/edit/save/conflict/rename/delete.
  - Binary/large-file warnings and normal image/text handling.

- [ ] **Download flows pass.**
  - Files/folders, hierarchy, conflicts, progress, cancellation, links, virtual destinations, disconnect, truthful partial-failure summary.

- [ ] **Upload flows pass.**
  - Trusted multi-root drag/picker, hierarchy, merges, overwrites, skips, cancellation, links, large local/virtual files, disconnect, truthful partial-failure summary.

- [ ] **Workspace-trust and shutdown behavior pass.**
  - Untrusted workspace restrictions do not disable direct connection management, SSH terminals, or remote SFTP.
  - Reload/deactivation during active network/transfer work produces bounded truthful results and zero managed-resource leaks.

- [ ] **Record evidence for every workflow.**
  - Execute the human workflow matrix on the supported VS Code and VSCodium floor/latest builds required by the release matrix.
  - Repeat critical SSH/SFTP flows against both Docker OpenSSH and the separate non-production Linux OpenSSH host.
  - Record editor/server/client versions and pass/fail evidence.
  - No supported flow requires leaving the editor to manually shuttle a remote file.

---

## 7. OpenSSH import release matrix

- [ ] **Run the full import parser matrix.**
  - Concrete aliases, global/wildcard/negated defaults, case/precedence, includes/globs/loops/limits, tokens, multiple identities, duplicates, missing/invalid fields.

- [ ] **Verify unsupported connectivity directives remain safe.**
  - ProxyJump, ProxyCommand, and Match-related connectivity remain visible but blocked with actionable remediation.

- [ ] **Prove source files are immutable.**
  - Hash every source/include before and after; byte-for-byte equality required.

- [ ] **Prove import does not create/copy secrets.**
  - Scan state, logs, webview data, snapshots, and packages for invented/imported passwords or copied private-key content.

---

## 8. MCP release matrix

- [ ] **Test MCP setup with two clients.**
  - Codex plus at least one other MCP-capable client.
  - Record client and Node versions.

- [ ] **Test policy and limits.**
  - Disabled discovery/direct calls, read-only roots, independent write/exec grants, all confirmation modes, approval/denial/expiry, size/time/concurrency limits, bounded clear errors.

- [ ] **Run adversarial MCP cases.**
  - Traversal, lexical-prefix and encoded-separator tricks, symlink escape/race, guessed ids, stale/forged versions, oversized frames, wrong/stale IPC credentials, direct mutation without permission.

- [ ] **Run full MCP workflows.**
  - Discovery, exec, ranged UTF-8/base64 read, atomic create/versioned/forced write, mkdir/rename/delete/recursive delete, cancellation, editor disconnect, immediate revocation.
  - Exercise with both clients where supported.

- [ ] **Verify editor-close behavior.**
  - No daemon/socket/discovery remains useful.
  - Companion returns documented bounded editor-unavailable error.

- [ ] **Verify MCP audit/privacy.**
  - Audit rotation/view/export/clear.
  - Scan raw audit/config/discovery/log/process data for secret, raw-command, stdout/stderr, and file-content sentinels.

---

## 9. Security and privacy review

- [ ] **Create a unique sentinel corpus.**
  - Password, passphrase, private key, host key, IPC token, command, stdout, stderr, file content.
  - Exercise relevant success and failure paths.

- [ ] **Scan every persistence/output/package surface.**
  - Global/workspace state and recovery data.
  - SecretStorage ids/fakes without exposing values.
  - Logs/output/notifications.
  - Webview state/messages/developer-tools-visible initialization.
  - URIs, command arguments, process list/config snippets, errors/stacks.
  - Audit/discovery/socket metadata and exports.
  - Snapshots, coverage, bundles/maps, VSIX, SBOM/notices, release logs.
  - Investigate every sentinel match.

- [ ] **Prove the intended secret-storage boundary.**
  - Only password/passphrase values reside in SecretStorage.
  - Private-key content is read transiently from its configured path.
  - Credentials/private keys never cross MCP IPC.
  - Explicit command/file/output payloads cross only for the active authorized call and are never persistently audited/logged.

- [ ] **Prove no hidden runtime transport/telemetry exists.**
  - No telemetry, analytics, crash reporting, update beacon, third-party runtime web request, unauthenticated listener, or background daemon.
  - Operational transports are SSH/SFTP remote traffic plus user-invoked local MCP IPC.

- [ ] **Prove webview safety.**
  - Strict CSP, no remote source, safe DOM writes, exact message validation, no Node access, no unintended credential/content exposure.

- [ ] **Prove explicit decisions remain required.**
  - Host-key changes, credential copies, overwrites, recursive deletes, and relaxed agent confirmation.

---

## 10. Accessibility and UX review

- [ ] **Complete core flows keyboard-only.**
  - Connection editor, import preview, SFTP, workspace, download, upload.

- [ ] **Verify accessibility semantics.**
  - Focus order/restoration, names/roles/live regions, context menus, error association, progress/cancellation summaries.
  - No icon-only, color-only, hover-only, or drag-only meaning for core supported workflows.

- [ ] **Test display/input variants.**
  - Dark, light, high-contrast, 200% zoom, reduced motion, narrow panels, long names/paths, Unicode/RTL, screen-reader announcements.

- [ ] **Verify notification quality.**
  - Includes connection/path context and actionable remediation.
  - No sensitive payload/raw low-level error exposure.
  - No modal prompt storms.

---

## 11. Performance and resilience review

- [ ] **Measure activation baseline.**
  - Fixture: 1,000 profiles / 100 folders.
  - No network work on activation; roots render lazily.

- [ ] **Measure SFTP panel baseline.**
  - Initial open performs one remote listing and no recursive local/remote scan.

- [ ] **Measure large-directory browsing.**
  - Synthetic 10,000-entry directory remains responsive with bounded/incremental rendering or pagination.

- [ ] **Verify operation prioritization and leak cleanup.**
  - Concurrent save + navigation + three-worker upload keeps save/navigation priority.
  - Repeated panel/terminal open-close and reconnect cycles return handles/listeners/timers to baseline.

- [ ] **Verify limits fail before unbounded work.**
  - Large-file warnings before full reads.
  - Virtual buffering and MCP output/frame limits before unbounded allocation.
  - Fuzzed URI/path/webview/IPC/OpenSSH inputs terminate under defined size/depth/time limits.

- [ ] **Resolve all release blockers.**
  - Accessibility, performance, resilience, privacy, and security.
  - Document accepted non-blocking limitations.

---

## 12. Documentation and production hardening

- [ ] **Finalize end-user documentation against frozen behavior.**
  - README: installation, prerequisites, connection/auth/trust, terminal, SFTP, download/upload, MCP, security/privacy, troubleshooting/support.

- [ ] **Finalize maintainer/release documentation.**
  - `CHANGELOG.md`, `SECURITY.md`, privacy statement, architecture, troubleshooting, MCP setup, development, contribution, release process.

- [ ] **Document the supported/rejected scope accurately.**
  - Linux/editor/Node/OpenSSH matrices, known limitations, deferred features, recovery behavior, data/storage locations, no telemetry/cloud accounts.
  - No claims of Windows/macOS/browser/mobile support, marketplace publication, telemetry, sync, or deferred features.

- [ ] **Harden production logging/commands.**
  - Remove development-only commands/flags.
  - Prohibit sensitive debug payloads.
  - Production logging defaults to `info` with sanitized metadata only.

- [ ] **Complete exact dependency/license review.**
  - Production/development vulnerabilities and licenses.
  - Generate final SBOM/notices.
  - Update/remove unacceptable dependencies or record explicit maintainer acceptance for non-critical findings.

---

## 13. Freeze package metadata and contents

- [ ] **Set and verify release manifest metadata.**
  - Version `1.0.0`.
  - Publisher `hassanm0301`.
  - Name `easyssh-manager`.
  - Display name `EasySSH Manager`.
  - License `GPL-3.0-only`.
  - Correct repository/issues/homepage links.

- [ ] **Restrict VSIX contents to the production allowlist.**
  - Include runtime bundles, manifest, README/CHANGELOG/LICENSE/security/privacy docs, approved icons/media, required notices.
  - Exclude tests/fixtures, Docker keys/config, coverage, local settings, `.env`, audit/discovery/log/runtime files, Git data, unintended planning docs, unapproved source maps, and all user/site state.
  - Global/storage/SecretStorage state is created only at runtime.

- [ ] **Complete Open VSX readiness only.**
  - Validate manifest/license/icon/README compatibility.
  - Document future publish command/credentials.
  - Do not publish to Open VSX or Visual Studio Marketplace.

---

## 14. Build and prove the release artifact

- [ ] **Build the first candidate from a clean checkout.**
  - `npm ci`.
  - Build `hassanm0301.easyssh-manager-1.0.0.vsix`.
  - Record Node/npm versions, commit SHA, lockfile hash, VSIX size, complete content list.

- [ ] **Build a second candidate from another clean checkout/environment.**
  - Prefer byte-for-byte equality.
  - If VSIX timestamp metadata prevents it, document the cause and prove normalized archive contents/file hashes are identical.

- [ ] **Smoke-test the candidate VSIX in clean profiles.**
  - Clean VS Code and VSCodium install/activation.
  - Representative SSH, SFTP, upload, and MCP workflows.

- [ ] **Generate final release metadata.**
  - SHA-256 and independent verification.
  - Matching final SBOM/notices.
  - Release notes covering features, trust/security model, prerequisites, supported matrix, known limitations, deferred work, install/uninstall, checksum verification.

---

## 15. Approval and GitHub publication

- [ ] **Obtain explicit maintainer sign-off on the exact release set.**
  - Approved commit, test evidence, accepted risks, release notes, VSIX, checksum, SBOM/notices, normalized reproducibility result.

- [ ] **Create tag `v1.0.0` only after sign-off.**
  - Release GitHub Actions rebuilds/verifies instead of substituting an unreviewed local artifact.

- [ ] **Publish the GitHub release only.**
  - Attach intended VSIX, matching `.sha256`, SBOM/notices, and release notes.
  - Publish to no marketplace.

- [ ] **Verify the exact downloaded release artifacts.**
  - Download from GitHub.
  - Independently verify SHA-256/content.
  - Install the downloaded VSIX in clean VS Code and VSCodium profiles, restart, run release smoke workflows, uninstall, and verify no process/socket remains.

- [ ] **Record permanent release evidence.**
  - GitHub tag/release/artifacts point to the approved commit and approved artifact set.
  - Store permanent evidence links in the release checklist.

---

## 16. Milestone 08 / `1.0.0` completion gate

- [ ] Every README coverage row has passing implementation/test evidence and every prior milestone remains green.
- [ ] Coverage is ≥85% lines, ≥85% statements, and ≥80% branches for declared unit-testable modules; critical paths also have explicit branch/scenario evidence.
- [ ] Required editor, Node, server, workspace, and authentication matrices pass with recorded versions.
- [ ] Codex and at least one other MCP-capable client pass the required release matrix.
- [ ] Security/privacy review finds no credential/private-key/raw-key/content leakage, unauthorized path/tool access, unauthenticated listener, telemetry, analytics, crash reporting, update beacon, or background daemon.
- [ ] Accessibility, performance, and resilience reviews have no release-blocking issue; accepted limitations are documented.
- [ ] Clean `1.0.0` VSIX installs and passes smoke tests; contents, normalized reproducibility, SBOM/notices, and SHA-256 are verified.
- [ ] GitHub tag `v1.0.0` points to the approved commit and the release contains the intended VSIX/checksum/SBOM/notes.
- [ ] No marketplace publication occurred.
- [ ] No new product surface was added in this milestone.
- [ ] Every documented risk mitigation and non-goal boundary is satisfied.
- [ ] No implementation, defect, test, documentation, packaging, approval, or release task remains.
