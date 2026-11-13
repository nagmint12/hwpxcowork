#!/bin/sh
# 공식 Node.js(이 배포물에서 시험한 판 __NODE_VERSION__)를 nodejs.org 에서 받아 SHA-256 을 확인하고 이 폴더의 runtime/ 에 넣는다(약 30 MB).
# 시스템 설치·PATH 변경 없음. 지우려면 runtime/ 을 지운다. 이미 Node.js 22 이상이 있으면 필요 없다.
# 주의: Ubuntu 22.04 의 apt 'nodejs' 는 12판이라 쓸 수 없다 — 이 스크립트나 NodeSource 22+ 를 쓴다.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
VERSION=${HWPX_COWORK_NODE_VERSION:-__NODE_VERSION__}
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "[오류] 지원하지 않는 CPU: $(uname -m)" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "[오류] 지원하지 않는 운영체제: $(uname -s)" >&2; exit 1 ;;
esac
NAME="node-v$VERSION-$OS-$ARCH.tar.gz"
BASE="https://nodejs.org/dist/v$VERSION/"
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1"; }
else echo "[오류] curl 또는 wget 이 필요합니다: sudo apt install -y curl" >&2; exit 1; fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "  공식 Node.js $VERSION ($OS-$ARCH) 확인: $BASE"
fetch "${BASE}SHASUMS256.txt" "$WORK/SHASUMS256.txt"
EXPECTED=$(awk -v n="$NAME" '$2 == n { print $1 }' "$WORK/SHASUMS256.txt")
[ -n "$EXPECTED" ] || { echo "[오류] SHASUMS256.txt 에 $NAME 이 없습니다" >&2; exit 1; }
echo "  내려받는 중: $NAME"
fetch "$BASE$NAME" "$WORK/$NAME"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$WORK/$NAME" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$WORK/$NAME" | awk '{print $1}'); fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo "[오류] SHA-256 이 공식 값과 다릅니다 — 받은 파일을 쓰지 않습니다" >&2; exit 1; }
echo "  SHA-256 확인 완료"
tar -xzf "$WORK/$NAME" -C "$WORK"
mkdir -p "$HERE/runtime/bin"
mkdir -p "$HERE/runtime/lib/node_modules"
cp "$WORK/node-v$VERSION-$OS-$ARCH/bin/node" "$HERE/runtime/bin/node"
cp -R "$WORK/node-v$VERSION-$OS-$ARCH/lib/node_modules/npm" "$HERE/runtime/lib/node_modules/"
cp -P "$WORK/node-v$VERSION-$OS-$ARCH/bin/npm" "$HERE/runtime/bin/npm"
cp -P "$WORK/node-v$VERSION-$OS-$ARCH/bin/npx" "$HERE/runtime/bin/npx"
cp "$WORK/node-v$VERSION-$OS-$ARCH/LICENSE" "$HERE/runtime/LICENSE"
chmod 755 "$HERE/runtime/bin/node"
echo "  설치 완료: $HERE/runtime/bin/node ($("$HERE/runtime/bin/node" -v))"
