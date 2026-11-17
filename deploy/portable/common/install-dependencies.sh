#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/app/portable/find-node.sh"
if [ -z "$NODE" ]; then
  sh "$HERE/install-node.sh"
  . "$HERE/app/portable/find-node.sh"
fi
[ -n "$NODE" ] || { echo 'Node.js 22 이상이 필요합니다.' >&2; exit 1; }
exec "$NODE" "$HERE/app/portable/install-dependencies.mjs"
