#!/usr/bin/env node
// rhwp 0.9.1 비교 묶음(2026-11-19) — 한/글 2022 실측에 맞춘 판정을 엔진 패키지 하나에 한 번에 돌린다.
//
//   node scripts/rhwp091-parity.mjs [--pkg <엔진 패키지 폴더>] [--out <새 폴더>] [--only layout,editing,…]
//   npm run test:rhwp091 -- --pkg artifacts/<후보>/engine-pkg
//
// 무엇을 보나: 11-19 에 rhwp 0.9.1 · 우리 엔진 · 한/글 2022(12.0.0.3146, COM 쪽 그림 96dpi + 재저장 HWPX)를
// 견준 입력들(`artifacts/rhwp-091-com-20261119/` — 쪽 끝 빈 쪽 #8984, 쪽 끝 개체 이월 #8660, RowBreak 100·101HU,
// 중첩 표 #8715, 한 줄로 입력 #8947, MS_WORD 호환 탭·줄 높이, 숨긴 변경 추적, 그림 자료 정리, 메모 댓글, 그림 효과,
// 각주 번호 서식 등)에서 엔진이 한/글과 같은 결과를 내는지. 기대값은 한/글 실측에서 온 것이고 판정 스크립트는
// 그 수정 작업의 것(`artifacts/rhwp-091-fixes-20261119/check-*.mjs`)과 저녁 재검의 보충 판정
// (`artifacts/rhwp-091-audit-20261119/check-layout-extra.mjs` — 묶음 이름 layout2)을 그대로 부른다 — 이 파일은 묶어 돌리고 모을 뿐이다.
//
// 판정: 모두 통과 0, 하나라도 실패 1, 자료(입력·한/글 실측·판정 스크립트)가 없어 못 돌린 묶음이 있으면 2(미검증).
// 엔진 패키지는 먼저 <out>/pin/engine-pkg 로 복사해 그 사본만 쓴다(도는 동안 운영 패키지가 바뀌어도 결과가 한 빌드의 것).
// 한/글·브라우저·빌드는 쓰지 않는다. 자료는 이 PC 의 artifacts 에 있다(공개 저장소에는 없다 → 거기서는 2).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const comparison = path.join(root, 'artifacts', 'rhwp-091-com-20261119');
const fixes = path.join(root, 'artifacts', 'rhwp-091-fixes-20261119');
const PKG_FILES = ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts', 'rhwp_bg.wasm.d.ts', 'cowork-engine.json'];
const audit = path.join(root, 'artifacts', 'rhwp-091-audit-20261119');
const SUITES = ['layout', 'layout2', 'editing', 'rendering', 'fields', 'word', 'coanchor'];
const USAGE = `쓰기: node scripts/rhwp091-parity.mjs [--pkg <엔진 패키지 폴더>] [--out <새 폴더>] [--only ${SUITES.join(',')}]`;

function parseArgs(argv) {
  const options = { pkg: process.env.RHWP_PKG || path.join(root, 'vendor', 'rhwp', 'pkg'), out: '', only: SUITES };
  for (let i = 0; i < argv.length; i += 2) {
    const [name, value] = [argv[i], argv[i + 1]];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    if (name === '--pkg') options.pkg = value;
    else if (name === '--out') options.out = value;
    else if (name === '--only') options.only = value.split(',').map((item) => item.trim()).filter(Boolean);
    else throw new Error(USAGE); // 모르는 인자는 거절한다(빌드 스크립트 사고 뒤의 약속).
  }
  const unknown = options.only.filter((item) => !SUITES.includes(item));
  if (!options.only.length || unknown.length) throw new Error(`${USAGE}\n모르는 묶음: ${unknown.join(', ')}`);
  return options;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const pkg = path.resolve(root, options.pkg);
if (!fs.existsSync(path.join(pkg, 'rhwp_bg.wasm')) || !fs.existsSync(path.join(pkg, 'rhwp.js'))) {
  console.error(`엔진 패키지가 아닙니다: ${pkg}`);
  process.exit(2);
}
const wasmSha256 = sha256(path.join(pkg, 'rhwp_bg.wasm'));
const out = path.resolve(root, options.out || path.join('artifacts', 'rhwp-091-parity-runs', `${stamp()}-${wasmSha256.slice(0, 12)}`));
if (fs.existsSync(out)) {
  console.error(`이미 있는 폴더입니다(결과를 덮어쓰지 않습니다): ${out}`);
  process.exit(2);
}
// 판정 스크립트 둘(word·coanchor)은 후보 폴더를 자료 폴더 기준 상대 경로로 받는다 — 다른 드라이브면 이을 수 없다.
if (path.parse(out).root.toLowerCase() !== path.parse(fixes).root.toLowerCase()) {
  console.error(`--out 은 ${path.parse(fixes).root} 드라이브 안이어야 합니다: ${out}`);
  process.exit(2);
}

const pin = path.join(out, 'pin');
const pinnedPkg = path.join(pin, 'engine-pkg');
fs.mkdirSync(pinnedPkg, { recursive: true });
for (const name of PKG_FILES) {
  if (fs.existsSync(path.join(pkg, name))) fs.copyFileSync(path.join(pkg, name), path.join(pinnedPkg, name));
}
if (sha256(path.join(pinnedPkg, 'rhwp_bg.wasm')) !== wasmSha256) {
  console.error('복사하는 사이 엔진 패키지가 바뀌었습니다. 다시 돌려 주세요.');
  process.exit(2);
}
const candidate = path.relative(fixes, pin);

function run(script, args, base = fixes) {
  const file = path.join(base, script);
  if (!fs.existsSync(file)) return { missing: `판정 스크립트 없음: ${path.relative(root, file)}` };
  const started = Date.now();
  const child = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', error: child.error && String(child.error), ms: Date.now() - started };
}

function record(name, child, summary) {
  const log = path.join(out, `${name}.log`);
  fs.writeFileSync(log, `${child.stdout ?? ''}\n--- stderr ---\n${child.stderr ?? ''}${child.error ? `\n${child.error}` : ''}`);
  return { exit: child.status, seconds: Math.round((child.ms ?? 0) / 100) / 10, log: path.relative(root, log), ...summary };
}

// 묶음마다: 돌리고, 그 스크립트가 남긴 결과에서 통과·실패 수를 읽는다. 결과를 못 읽으면 실패가 아니라 미검증이다.
const runners = {
  layout() {
    const child = run('check-layout.mjs', ['--pkg', pinnedPkg]);
    if (child.missing) return child;
    let counts = {};
    try {
      const report = JSON.parse(child.stdout);
      fs.writeFileSync(path.join(out, 'layout.json'), `${JSON.stringify(report, null, 2)}\n`);
      counts = { pass: report.summary.pass, fail: report.summary.fail, unverified: report.summary.unverified, wasmSha256: report.wasmSha256 };
    } catch { /* 아래에서 미검증으로 센다 */ }
    return record('layout', { ...child, stdout: counts.pass === undefined ? child.stdout : '(결과는 layout.json)' }, counts);
  },
  // 11-19 저녁 재검에서 한/글 실측을 보탠 입력(칸 안 표의 오프셋 위 공간 #8686, 그림 칸 빈 문단 #8971, 세로 정렬 글상자의 표 PK-40987)
  layout2() {
    const child = run('check-layout-extra.mjs', ['--pkg', pinnedPkg], audit);
    if (child.missing) return child;
    let counts = {};
    try {
      const report = JSON.parse(child.stdout);
      fs.writeFileSync(path.join(out, 'layout2.json'), `${JSON.stringify(report, null, 2)}
`);
      counts = { pass: report.passed, fail: report.failed, unverified: 0, knownDifferences: report.knownDifferences ?? 0, wasmSha256: report.wasmSha256 };
    } catch { /* 미검증 */ }
    return record('layout2', { ...child, stdout: counts.pass === undefined ? child.stdout : '(결과는 layout2.json)' }, counts);
  },
  editing() {
    const dir = path.join(out, 'editing');
    const child = run('check-editing.mjs', [pinnedPkg, dir]);
    if (child.missing) return child;
    return record('editing', child, countsOf(path.join(dir, 'result.json')));
  },
  rendering() {
    const child = run('check-rendering.mjs', ['--pkg', pinnedPkg]);
    if (child.missing) return child;
    // 마지막 줄이 보고서 경로다(자료 폴더의 rendering-runs/<wasm 해시>/check-*/report.json).
    const reportFile = child.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    let counts = {};
    try {
      const report = readJson(reportFile);
      const checks = report.cases.flatMap((item) => item.checks);
      counts = {
        pass: checks.filter((item) => item.status === 'pass').length,
        fail: checks.filter((item) => item.status === 'fail').length,
        unverified: checks.filter((item) => !['pass', 'fail'].includes(item.status)).length,
        wasmSha256: report.wasmSha256,
        report: path.relative(root, reportFile),
      };
    } catch { /* 미검증 */ }
    return record('rendering', child, counts);
  },
  fields() {
    const dir = path.join(out, 'field-controls');
    const child = run('check-field-controls.mjs', [pinnedPkg, dir]);
    if (child.missing) return child;
    return record('fields', child, countsOf(path.join(dir, 'result.json')));
  },
  word() {
    const child = run('check-word-line-metrics.mjs', [candidate]);
    if (child.missing) return child;
    const counts = countsOf(path.join(pin, 'word-line-metrics.json'));
    if (counts.pass !== undefined && counts.pageCountPass === false) counts.fail += 1;
    return record('word', child, counts);
  },
  coanchor() {
    const child = run('check-coanchor-roundtrip.mjs', [candidate]);
    if (child.missing) return child;
    return record('coanchor', child, countsOf(path.join(pin, 'coanchor-roundtrip', 'result.json')));
  },
};

function countsOf(file) {
  try {
    const result = readJson(file);
    const counts = { pass: result.passed, fail: result.failed, unverified: 0, wasmSha256: result.wasmSha256 };
    if ('pageCountPass' in result) counts.pageCountPass = result.pageCountPass;
    return Number.isInteger(counts.pass) && Number.isInteger(counts.fail) ? counts : {};
  } catch {
    return {};
  }
}

const dataMissing = [comparison, fixes, audit].filter((dir) => !fs.existsSync(dir));
const suites = {};
for (const name of options.only) {
  if (dataMissing.length) {
    suites[name] = { verdict: '미검증', reason: `자료 폴더 없음: ${dataMissing.map((dir) => path.relative(root, dir)).join(', ')}` };
    continue;
  }
  const result = runners[name]();
  if (result.missing) suites[name] = { verdict: '미검증', reason: result.missing };
  else if (result.pass === undefined) suites[name] = { verdict: '미검증', reason: '결과를 읽지 못함(로그 참조)', ...result };
  else if (result.wasmSha256 && result.wasmSha256 !== wasmSha256) suites[name] = { verdict: '미검증', reason: '결과의 WASM 해시가 대상과 다름', ...result };
  else if (result.fail > 0 || result.exit !== 0) suites[name] = { verdict: '실패', ...result };
  else if (result.unverified > 0) suites[name] = { verdict: '미검증', reason: '판정하지 못한 검사가 있음', ...result };
  else suites[name] = { verdict: '통과', ...result };
  console.log(`${name.padEnd(10)} ${suites[name].verdict}  통과 ${suites[name].pass ?? '-'} · 실패 ${suites[name].fail ?? '-'} · 미검증 ${suites[name].unverified ?? '-'}${suites[name].knownDifferences ? ` · 알려진 차이 ${suites[name].knownDifferences}` : ''}  (${suites[name].seconds ?? '-'}초)`);
}

const verdicts = Object.values(suites).map((suite) => suite.verdict);
const verdict = verdicts.includes('실패') ? '실패' : verdicts.includes('미검증') ? '미검증' : '통과';
const summary = {
  verdict,
  wasmSha256,
  pkg: path.relative(root, pkg),
  ranAt: new Date().toISOString(),
  basis: '한/글 2022 12.0.0.3146 COM 쪽 그림(96dpi)·재저장 HWPX — artifacts/rhwp-091-com-20261119/measurements',
  suites,
};
fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${verdict} — WASM ${wasmSha256}\n결과: ${path.relative(root, path.join(out, 'summary.json'))}`);
process.exit(verdict === '통과' ? 0 : verdict === '실패' ? 1 : 2);
