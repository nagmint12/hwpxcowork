# 시작 스크립트가 . 으로 읽는다: 쓸 수 있는 Node.js(22 이상)를 NODE 에 넣는다 — 이 폴더의 runtime/bin/node 가 먼저, 다음은 PATH 의 node.
# 없으면 NODE 는 비고, PATH 의 node 가 너무 옛 판이면 NODE_OLD 에 그 판 번호가 든다. HERE 는 부른 쪽이 정한다.
NODE=""
NODE_OLD=""
if [ -x "$HERE/runtime/bin/node" ]; then
  NODE="$HERE/runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  major=$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)
  if [ "$major" -ge 22 ] 2>/dev/null; then NODE=$(command -v node); else NODE_OLD=$major; fi
fi
