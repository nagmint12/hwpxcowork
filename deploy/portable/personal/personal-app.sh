#!/bin/sh
# hwpx-cowork 개인용 앱(Linux·macOS) — 이 PC 에서만 열리는 서버를 켜고 기본 브라우저로 연다. 앞에서 실행하며 Ctrl+C 로 끈다.
#   ./personal-app.sh [폴더 …] [--name 이름] [--ai "--provider codex"] [--no-window]
# Node: 이 폴더의 runtime/bin/node, 없으면 설치된 Node.js 22 이상. 둘 다 없으면 ./install-node.sh 를 한 번 실행한다.
# 설정·기록: HWPX_COWORK_USERDATA(없으면 이 폴더의 userdata-personal/). 문서 파일은 연결한 폴더에 그대로 있다.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/app/portable/find-node.sh"
if [ -z "$NODE" ]; then
  if [ -n "$NODE_OLD" ]; then echo "[오류] 설치된 Node.js 가 ${NODE_OLD}판이라 쓸 수 없습니다(22 이상 필요)." >&2
  else echo "[오류] Node.js 22 이상이 없습니다." >&2; fi
  echo "       $HERE/install-node.sh 를 한 번 실행하면 공식 Node.js 를 이 폴더 runtime/ 에 받습니다(약 30 MB)." >&2
  exit 1
fi
if [ -f "$HERE/app/portable/install-dependencies.mjs" ] && ! "$NODE" "$HERE/app/portable/install-dependencies.mjs" --check; then
  echo "[설치 필요] sh $HERE/install-dependencies.sh 를 먼저 실행하세요." >&2
  exit 1
fi
export HWPX_COWORK_USERDATA="${HWPX_COWORK_USERDATA:-$HERE/userdata-personal}"
exec "$NODE" "$HERE/app/portable/personal.mjs" "$@"
