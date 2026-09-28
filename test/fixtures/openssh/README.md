# OpenSSH integration fixture

This intentionally credential-free image is the shared starting point for later
integration tests. It enables SFTP and public-key authentication on port 2222.
Milestones 02–06 add ephemeral test users, encrypted Ed25519 keys, password
fixtures, permission layouts, host-key rotation, and forced disconnect scenarios
at test runtime. No private material is committed or packaged.
