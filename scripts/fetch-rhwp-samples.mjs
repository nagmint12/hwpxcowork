// rhwp 공개 시료(GitHub edwardkim/rhwp 의 samples/ 아래 HWPX)를 내려받는다 — layout-combos.mjs 의 비교 말뭉치.
// 저장소의 시료는 이슈 재현 문서가 많아 "어떤 조합이 있을 수 있나"를 넓히는 데 쓴다(빈도는 실문서와 다르다).
//
//   node scripts/fetch-rhwp-samples.mjs --out <폴더> [--ref devel]
// 받은 파일은 자료일 뿐이다 — 읽기만 하고 실행하지 않는다. 같은 크기의 파일은 건너뛴다.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const out = opt('--out', null);
if (!out) { console.error('사용: node scripts/fetch-rhwp-samples.mjs --out <폴더> [--ref devel]'); process.exit(1); }
const ref = opt('--ref', 'devel');
const H = { headers: { 'User-Agent': 'hwpx-cowork' } };
const api = async (u) => { const r = await fetch(u, H); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); };

const top = await api(`https://api.github.com/repos/edwardkim/rhwp/git/trees/${ref}`);
const samples = top.tree.find((x) => x.path === 'samples');
const tree = await api(`https://api.github.com/repos/edwardkim/rhwp/git/trees/${samples.sha}?recursive=1`);
const files = tree.tree.filter((x) => x.type === 'blob' && /\.hwpx$/i.test(x.path));
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '_list.json'), JSON.stringify({ commit: top.sha, files: files.map((f) => f.path) }, null, 1));
let i = 0, got = 0, skip = 0, fail = 0;
async function worker() {
  while (i < files.length) {
    const f = files[i++];
    const dst = path.join(out, f.path);
    if (fs.existsSync(dst) && fs.statSync(dst).size === f.size) { skip++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      const r = await fetch(`https://raw.githubusercontent.com/edwardkim/rhwp/${top.sha}/samples/${f.path.split('/').map(encodeURIComponent).join('/')}`);
      if (!r.ok) throw new Error(String(r.status));
      fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
      got++;
    } catch (e) { fail++; console.error('실패', f.path, e.message); }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`rhwp ${top.sha.slice(0, 9)} samples HWPX ${files.length}개 — 받음 ${got} · 이미 있음 ${skip} · 실패 ${fail} → ${out}`);
