#!/bin/sh

# Keep PID 1 stable so integration tests can replace host keys and restart only
# sshd without replacing the container or its published port.
while :; do
  rm -f /etc/ssh/ssh_host_*
  ssh-keygen -A
  /usr/sbin/sshd -D -e
  status=$?
  if [ -f /run/easyssh-fixture-stop ]; then
    exit "$status"
  fi
  sleep 0.1
done
