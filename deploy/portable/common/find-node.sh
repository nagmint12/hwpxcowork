# 시작 스크립트가 . 으로 읽는다: 쓸 수 있는 Node.js(22 이상)를 NODE 에 넣는다 — 이 폴더의 runtime/bin/node 가 먼저, 다음은 PATH 의 node.
# 없으면 NODE 는 비고, PATH 의 node 가 너무 옛 판이면 NODE_OLD 에 그 판 번호가 든다. HERE 는 부른 쪽이 정한다.
NODE=""
NODE_OLD=""
# 폴더에 파일이 있어도 구형 macOS에서 실행 불가하거나 22 미만이면 다음 후보를 쓴다.
for candidate in "$HERE/runtime/bin/node" "$(command -v node 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  major=$("$candidate" -p 'parseInt(process.versions.node)' 2>/dev/null) || { NODE_OLD='실행 불가'; continue; }
  if [ "$major" -ge 22 ] 2>/dev/null; then NODE=$candidate; break; else NODE_OLD=$major; fi
done
