#!/bin/sh
# hwpx-cowork 서버(Linux·macOS) 켜기 — 앞에서 실행하며 Ctrl+C 로 끈다. 서비스로 돌리려면 deploy/hwpx-cowork.service 를 쓴다.
# Node: 이 폴더의 runtime/bin/node, 없으면 설치된 Node.js 22 이상. 둘 다 없으면 ./install-node.sh 를 한 번 실행한다.
# 설정·문서: HWPX_COWORK_USERDATA(없으면 이 폴더의 userdata/)
# 듣는 주소는 첫 실행 설정의 127.0.0.1(같은 서버의 HTTPS 프록시용). 바로 LAN 에 열려면 HWPX_COWORK_HOST=0.0.0.0 을 준다.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/app/portable/find-node.sh"
if [ -z "$NODE" ]; then
  if [ -n "$NODE_OLD" ]; then echo "[오류] 설치된 Node.js 가 ${NODE_OLD}판이라 쓸 수 없습니다(22 이상 필요 — Ubuntu 22.04 apt 의 nodejs 는 12판)." >&2
  else echo "[오류] Node.js 22 이상이 없습니다." >&2; fi
  echo "       $HERE/install-node.sh 를 한 번 실행하면 공식 Node.js 를 이 폴더 runtime/ 에 받습니다(약 30 MB)." >&2
  exit 1
fi
if [ -f "$HERE/app/portable/install-dependencies.mjs" ] && ! "$NODE" "$HERE/app/portable/install-dependencies.mjs" --check; then
  echo "[설치 필요] sh $HERE/install-dependencies.sh 를 먼저 실행하세요." >&2
  exit 1
fi
export HWPX_COWORK_USERDATA="${HWPX_COWORK_USERDATA:-$HERE/userdata}"
set +e
"$NODE" "$HERE/app/portable/portable.mjs" init
rc=$?
set -e
if [ "$rc" -eq 3 ]; then exit 0; fi
if [ "$rc" -ne 0 ]; then exit "$rc"; fi
export HWPX_COWORK_CONFIG="$HWPX_COWORK_USERDATA/config.json"
exec "$NODE" "$HERE/app/server/launcher.js"
