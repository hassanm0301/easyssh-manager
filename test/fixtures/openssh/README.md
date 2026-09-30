# OpenSSH integration fixture

This intentionally credential-free image is the shared integration fixture. It
enables password, public-key, and SFTP authentication on port 2222, but the test
user remains locked in the image. Tests create passwords, Ed25519 keys, agent
sockets, and host-key rotations ephemerally at runtime. No private material is
committed or packaged.
