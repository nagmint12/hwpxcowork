#!/bin/sh
HERE=$(cd "$(dirname "$0")" && pwd)
exec sh "$HERE/install-dependencies.sh" "$@"
