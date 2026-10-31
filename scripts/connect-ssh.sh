#!/bin/sh
# Read a private kit's simple SSH fields; never source the credential document.
set -eu
kit_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -ne 5 ]; then
  printf '%s\n' 'Usage: sh connect-ssh.sh HOST USER SSH_PORT LOCAL_PORT REMOTE_PORT' >&2
  exit 2
fi
chmod 600 "$kit_dir/id_ed25519"
retry_seconds=1
trap 'exit 0' INT TERM
while :; do
  began_at=$(date +%s)
  ssh -F none -N -T -p "$3" -i "$kit_dir/id_ed25519" \
    -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o "UserKnownHostsFile=$kit_dir/known_hosts" -o UpdateHostKeys=no \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 \
    -L "127.0.0.1:$4:127.0.0.1:$5" "$2@$1" && exit 0
  [ "$(($(date +%s) - began_at))" -lt 30 ] || retry_seconds=1
  printf 'Reconnecting in %ss...\n' "$retry_seconds" >&2
  sleep "$retry_seconds"
  retry_seconds=$((retry_seconds * 2))
  [ "$retry_seconds" -le 15 ] || retry_seconds=15
done
