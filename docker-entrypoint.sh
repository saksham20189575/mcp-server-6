#!/bin/sh
# Ensure a mounted persistent disk at /data is writable by the app user, then
# drop privileges before starting Node. Render (and similar hosts) mount disks
# as root; without this, seeding /data/token.json fails under USER node.
set -eu

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    chown -R node:node /data
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
