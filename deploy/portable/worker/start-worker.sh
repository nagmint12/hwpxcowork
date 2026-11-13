#!/bin/sh
# 개인 AI 실행기 켜기(macOS·Linux). 설정은 worker-settings.txt, 토큰은 환경 변수 HWPX_COWORK_TOKEN(API 방식이면 키 변수도).
# 덧붙인 인자는 실행기에 그대로 넘긴다(예: ./start-worker.sh --check).
# Node: 이 폴더의 runtime/bin/node, 없으면 설치된 Node.js 22 이상. 둘 다 없으면 ./install-node.sh 를 한 번 실행한다.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/app/portable/find-node.sh"
if [ -z "$NODE" ]; then
  echo "[설정 필요] Node.js 22 이상이 없습니다${NODE_OLD:+(설치된 판: $NODE_OLD)}. $HERE/install-node.sh 를 한 번 실행하세요." >&2
  exit 1
fi
if [ -f "$HERE/app/portable/install-dependencies.mjs" ] && ! "$NODE" "$HERE/app/portable/install-dependencies.mjs" --check; then
  echo "[설치 필요] sh $HERE/install-dependencies.sh 를 먼저 실행하세요." >&2
  exit 1
fi
HWPX_COWORK_URL=""; WORKER_ARGS=""
# KEY=VALUE 줄만 읽는다('#' 줄은 설명, Windows 줄 끝 허용)
while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in ''|'#'*) continue ;; esac
  key=${line%%=*}; value=${line#*=}
  case "$key" in
    HWPX_COWORK_URL) HWPX_COWORK_URL=$value ;;
    WORKER_ARGS) WORKER_ARGS=$value ;;
  esac
done < "$HERE/worker-settings.txt"
export HWPX_COWORK_URL
if [ -z "${HWPX_COWORK_TOKEN:-}" ]; then
  echo "[설정 필요] export HWPX_COWORK_TOKEN='관리자에게 받은 본인 토큰' 뒤 다시 실행하세요." >&2
  exit 1
fi
# shellcheck disable=SC2086
exec "$NODE" "$HERE/app/scripts/ai-worker.mjs" $WORKER_ARGS "$@"
