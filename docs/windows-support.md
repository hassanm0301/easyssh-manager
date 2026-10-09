# Native Windows support and acceptance

The first Windows release supports Windows 11 x64 desktop VS Code and VSCodium
connecting to Linux/POSIX OpenSSH servers. Linux remains the primary release
gate. The connection schema, SecretStorage and host-trust format are unchanged.
Windows MCP, Pageant, remote Windows servers, Windows ARM64 and macOS are deferred.

## Automated gates

CI runs Node 22 static checks, portable unit tests, production builds, companion
self-tests, VSIX inspection and extension-host smoke on both platforms. Linux
also runs Docker SSH/SFTP/MCP transport tests and SFTP editor acceptance under
Xvfb. Unix socket, UID and permission tests run explicitly on Linux; portable
MCP protocol and authorization checks still run on Windows.

Run `npm run check`, `npm run package` and `npm run test:extension` on each host.
On Linux with Docker, also run `EASYSSH_RUN_DOCKER=1 npm run test:integration`
and `npm run test:acceptance` (under Xvfb when a display is unavailable).
The extension-test launcher clears `ELECTRON_RUN_AS_NODE` for its child process
and preserves `EASYSSH_TEST_EXECUTABLE` for testing another editor installation.

## Manual release checklist

Run every item on Windows 11 x64 in both VS Code and VSCodium, using the same
production VSIX and a non-production Linux OpenSSH server. Record the commit,
artifact SHA-256, Windows/editor/server versions, result and failure evidence.
Leave boxes unchecked until evidence exists.

- [ ] Install the packaged VSIX; open Connections; create, edit, duplicate,
  move and delete a connection/folder. Close/reopen the editor and confirm state.
- [ ] Import the user's `.ssh/config`, including CRLF, quoted paths with spaces,
  relative/glob includes and a UNC config/key when a share is available.
  Verify import does not write to config or execute `Match exec`/proxy commands.
- [ ] Authenticate using password, plain key, encrypted key and Windows OpenSSH
  agent. Verify wrong credentials, unloaded keys, stopped agent and incompatible
  `SSH_AUTH_SOCK` report failure without falling back to another method.
- [ ] Accept a new host fingerprint, reconnect, rotate the fixture host key,
  and verify changed-key rejection unless explicitly confirmed.
- [ ] Use terminal input/output with Unicode and ANSI sequences; resize, close,
  cancel connection and reconnect. Confirm session cleanup.
- [ ] Browse, navigate, create, rename and delete remote files/directories;
  open/edit/save a remote file, including an external-edit conflict.
- [ ] Upload/download files and folders with spaces/Unicode and zero-byte files;
  exercise multiple local drives, an available UNC share and virtual providers.
- [ ] Verify workspace navigation with absolute and relative paths. Reject
  ambiguous drive-relative paths, forged drag payloads and uploads from an
  untrusted workspace. Skip source links/junctions without following targets.
- [ ] Attempt Windows downloads of reserved names, forbidden characters,
  trailing dots/spaces, alternate-data-stream names and case-colliding trees.
  Confirm preflight fails before any destination writes and no names change.
- [ ] Verify overwrite/skip/cancel and cancel mid-transfer. Lock a destination
  and deny access to a test directory; failed replacement must preserve the
  original, remove temporary files when possible and report cleanup failures.
- [ ] Open a remote workspace while EasySSH runs locally. Confirm key access,
  agent access, credentials and connection state stay in the local UI host.
- [ ] Invoke Windows MCP setup/view/export/clear commands. Confirm the clear
  unavailable message and no bridge, discovery or audit files/processes.

## Release status and deferred MCP

Implementation checks on 2026-10-09:

- Linux Node 22.23.2: 294 unit tests passed; typecheck, lint and formatting passed.
- Linux Docker OpenSSH transport: all 11 integration tests passed, including
  password/key/agent authentication, host-key rotation, SSH/SFTP and MCP.
- Linux VS Code 1.141.0 in a disposable Debian/Xvfb container: five editor
  smoke/SFTP acceptance tests passed; two Windows-only smoke cases were skipped.
  The test harness shared the fixture's network namespace to accommodate Docker
  Desktop networking. No desktop libraries were installed on the development host.
- Windows 11 Enterprise build 22631, native Node 24.14.0: `npm ci` and
  `npm run check` passed; 270 unit tests passed and 24 Unix-only cases were skipped.
  Production VSIX packaging/inspection and the companion self-test passed.
- Native Windows VS Code 1.141.0: all four extension-host smoke tests passed,
  including drive/UNC URI behavior and the early MCP capability guard.

Windows Node 22 GitHub Actions and the manual checklist above still need release
evidence. Native Windows OpenSSH-agent authentication against a real server and
VSCodium interactive acceptance have not been validated in this session.

No publication is authorized by passing a subset of these checks. Both CI
platforms and manual acceptance must pass; any Linux regression blocks release.
Native runtime unit checks alone do not establish Windows editor, OpenSSH-agent
or cross-user security acceptance.

A later Windows MCP milestone must verify access controls for discovery/audit
files, authenticated transport, stale-state cleanup, cancellation and cross-user
denial. Retain Linux ownership/mode checks. Do not enable Windows MCP by removing
Unix checks or assuming named pipes are inherently private.
