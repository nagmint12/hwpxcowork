#!/usr/bin/env node
// [hwpx-cowork] 한/글 2022 '한자로 바꾸기(F9)'·'한글로 바꾸기' 글자 단위 표 생성기 (2026-11-12, 편집·입력 영역).
//
//   node scripts/gen-hanja-table.mjs --readings <Unihan_Readings.txt> --irg <Unihan_IRGSources.txt> \
//        --other <Unihan_OtherMappings.txt> --license <license.txt> --unihan-sha256 <zip 해시>
//
// 입력: Unicode 공식 Unihan 데이터베이스(https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip, Unicode License v3 — 재배포 가능).
//   - kHangul(Unihan_Readings): 한자 → 한글 음과 표지(E = 본음(교육용 음), N = 이름·다른 뜻 등에 쓰는 음, 표지 없음 = 두음 법칙 꼴 등).
//   - kIRG_KSource 의 K0(KS X 1001) 부호: 같은 음 안의 후보 차례(KS 한자를 먼저, 부호 차례).
//   - kKoreanEducationHanja(교육용 1800자)·kKoreanName(인명용): 한/글 한자 창의 분류(교육용·인명용) 표시.
// 출력: rhwp-studio/src/ui/generated/h2022-hanja-data.ts(생성물 — 손으로 고치지 않는다), 같은 폴더 UNICODE-LICENSE-unihan.txt(고지).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const need = (name) => { const v = arg(name); if (!v) { console.error(`${name} 가 필요합니다`); process.exit(2); } return v; };
const readings = need('--readings');
const irg = need('--irg');
const other = need('--other');
const license = need('--license');
const sha = arg('--unihan-sha256') || '(미기록)';
const outDir = path.join(root, 'vendor/rhwp/rhwp-studio/src/ui/generated');

const cp = (u) => String.fromCodePoint(parseInt(u.slice(2), 16));
const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
let version = '';
for (const l of fs.readFileSync(readings, 'utf8').split(/\r?\n/, 6)) { const m = /Unicode Version (\S+)/.exec(l); if (m) version = m[1]; }

/** 한자 → [{r: 음, f: 표지}] */
const hangul = new Map();
for (const l of lines(readings)) {
  const [u, field, value] = l.split('\t');
  if (field !== 'kHangul') continue;
  hangul.set(cp(u), value.split(' ').map((x) => { const [r, src] = x.split(':'); return { r, f: (src || '').replace(/[0-9]/g, '') }; }));
}
const ks = new Map();
for (const l of lines(irg)) {
  const [u, field, value] = l.split('\t');
  if (field !== 'kIRG_KSource' || !value.startsWith('K0-')) continue;
  ks.set(cp(u), parseInt(value.slice(3), 16));
}
const edu = new Set(); const name = new Set();
for (const l of lines(other)) {
  const [u, field] = l.split('\t');
  if (field === 'kKoreanEducationHanja') edu.add(cp(u));
  else if (field === 'kKoreanName') name.add(cp(u));
}

// 차례: KS X 1001 부호 차례 → 그 밖은 코드포인트
const chars = [...hangul.keys()].sort((a, b) => (ks.get(a) ?? 1e9) - (ks.get(b) ?? 1e9) || a.codePointAt(0) - b.codePointAt(0));
// 한 줄 = 한자 + 분류 표지(k KS·e 교육용·n 인명용) + ':' + 음표지 목록(음 뒤에 E/N)
const rows = chars.map((c) => {
  const cls = `${ks.has(c) ? 'k' : ''}${edu.has(c) ? 'e' : ''}${name.has(c) ? 'n' : ''}`;
  return `${c}${cls}:${hangul.get(c).map((x) => x.r + x.f).join(',')}`;
});
const body = rows.join('\n');
const ts = `// 생성물 — 손으로 고치지 않는다. scripts/gen-hanja-table.mjs 가 Unicode Unihan ${version} 에서 만든다
// (Unihan.zip sha256 ${sha}). 라이선스: Unicode License v3 — 같은 폴더 UNICODE-LICENSE-unihan.txt.
// 줄 = 한자 + 분류(k KS X 1001 · e 교육용 · n 인명용) + ':' + 쉼표로 나눈 음(뒤 표지 E 본음 · N 이름·다른 뜻 음 · 없음 두음 법칙 꼴 등).
// 차례 = KS X 1001 부호 차례, 그 밖은 코드포인트. 한자 ${rows.length}자.
export const HANJA_DATA_VERSION = ${JSON.stringify(version)};
export const HANJA_DATA = ${JSON.stringify(body)};
`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'h2022-hanja-data.ts'), ts);
fs.writeFileSync(path.join(outDir, 'UNICODE-LICENSE-unihan.txt'),
  `이 폴더의 h2022-hanja-data.ts 는 Unicode Unihan 데이터베이스(Unicode ${version}, https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip)에서 만든 파생 자료다.\n`
  + `Unihan 은 아래 Unicode License v3 로 배포된다.\n\n${fs.readFileSync(license, 'utf8')}`);
console.log(`[gen-hanja-table] 한자 ${rows.length}자 · KS ${[...chars].filter((c) => ks.has(c)).length} · 교육용 ${edu.size} · 인명용 ${name.size} · ${Buffer.byteLength(ts)} 바이트 → ${path.relative(root, outDir)}`);
