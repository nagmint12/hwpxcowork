// 화면 시험 도우미(tests/ui_collab.py 가 부른다) — 편집기 껍데기의 자동 저장에 기대지 않고 서버 상태를 만든다.
//   node tests/helpers/make_draft.mjs build --out <파일> [--filler N]
//     → 시험 문서: tests/fixtures/tool_memo_tracked.hwpx 를 평탄화하고 문단 5개를 더한 깨끗한 문서(변경 추적 없음, 메모 1 — s0/p0).
//       --filler N 이면 끝에 긴 채움 문단 N개를 더한다(여러 쪽 — 편집기 스크롤 시험용).
//       stdout 한 줄 JSON { out, paragraphs: [{ ref, text }] }
//   node tests/helpers/make_draft.mjs draft --base http://127.0.0.1:<port> --doc <id> --edits '<JSON>'
//     → 지금 기준 최종본(GET /file?kind=working, X-Doc-Version)을 엔진으로 고쳐(편집기 내보내기 자리) PUT /drafts/mine?base=<버전>.
//       토큰은 환경 변수 HWPX_TEST_TOKEN(명령줄·프로세스 목록에 남기지 않게).
//       edits: [{ ref, from, to }] — 그 문단 글 안의 from 을 to 로 / [{ after: 's0/p3', text }] — 본문 문단 뒤에 새 문단
//       stdout 한 줄 JSON = 서버 응답 { cr, unchanged } + { version }
// 진짜 config.json·data/ 는 건드리지 않는다(서버 주소·토큰은 시험이 띄운 임시 서버 것).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpxDoc } from '../../engine/doc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = path.join(root, 'tests', 'fixtures', 'tool_memo_tracked.hwpx');
const PREP = { author: '준비' };
const ED = { author: '편집기' };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i++; } else out._.push(a);
  }
  return out;
}

/** 시험 문서(api_cr.mjs 의 buildMainDoc 과 같은 모양) */
async function buildDoc(filler = 0) {
  const d = await (await HwpxDoc.load(fs.readFileSync(FX))).flattened();
  const extra = ['넷째 문단: 사업 개요를 적습니다.', '다섯째 문단: 추진 일정은 3월부터 12월까지입니다.', '여섯째 문단: 예산은 총 1억 원입니다.', '일곱째 문단: 기대 효과를 정리합니다.', '여덟째 문단: 맺음말입니다.'];
  extra.forEach((t, i) => d.insertParagraphAfter(0, 2 + i, t, PREP));
  const line = '이 문단은 편집기 스크롤 시험을 위한 채움 글입니다. 쪽을 여러 장 만들려고 같은 글을 되풀이합니다. ';
  for (let k = 0; k < filler; k++) d.insertParagraphAfter(0, 2 + extra.length + k, `채움 ${k + 1}: ${line.repeat(3)}`, PREP);
  d.acceptAll();
  return d;
}

async function build(o) {
  if (!o.out) throw new Error('--out <파일> 이 필요합니다');
  const filler = Math.max(0, Math.min(2000, Number(o.filler) || 0));
  const d = await buildDoc(filler);
  const bytes = Buffer.from(await d.save());
  fs.writeFileSync(o.out, bytes);
  const back = await HwpxDoc.load(bytes);
  const paragraphs = back.sections[0].bodyParas.map((_, i) => ({ ref: `s0/p${i}`, text: back.text(`s0/p${i}`) }));
  return { out: o.out, paragraphs };
}

async function draft(o) {
  const token = process.env.HWPX_TEST_TOKEN;
  if (!o.base || !o.doc || !token) throw new Error('--base · --doc · 환경 변수 HWPX_TEST_TOKEN 이 필요합니다');
  const edits = JSON.parse(o.edits || '[]');
  const auth = { Authorization: `Bearer ${token}` };
  const r = await fetch(`${o.base}/api/docs/${encodeURIComponent(o.doc)}/file?kind=working`, { headers: auth });
  if (!r.ok) throw new Error(`작업본을 받지 못했습니다: HTTP ${r.status}`);
  const version = Number(r.headers.get('x-doc-version'));
  const doc = await HwpxDoc.load(Buffer.from(await r.arrayBuffer()));
  const w = await doc.clone();
  // 문단 넣기는 뒤에서부터(앞 번호가 흔들리지 않게)
  const inserts = edits.filter((e) => e.after).sort((a, b) => Number(/p(\d+)$/.exec(b.after)[1]) - Number(/p(\d+)$/.exec(a.after)[1]));
  for (const e of edits.filter((x) => x.ref)) {
    const t = w.text(e.ref);
    if (!t.includes(e.from)) throw new Error(`${e.ref} 에 「${e.from}」 이(가) 없습니다: ${t}`);
    w.mergeParagraphText(e.ref, t.replace(e.from, e.to), ED);
  }
  for (const e of inserts) {
    const m = /^s(\d+)\/p(\d+)$/.exec(e.after);
    if (!m) throw new Error(`after 는 본문 문단 ref 여야 합니다: ${e.after}`);
    w.insertParagraphAfter(Number(m[1]), Number(m[2]), e.text, ED);
  }
  const flat = await w.flattened();
  const bytes = Buffer.from(await flat.save());
  const put = await fetch(`${o.base}/api/docs/${encodeURIComponent(o.doc)}/drafts/mine?base=${version}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: bytes });
  const body = await put.json().catch(() => null);
  if (!put.ok) throw new Error(`수정본 저장 실패: HTTP ${put.status} ${JSON.stringify(body)}`);
  return { ...body, version };
}

const o = args(process.argv.slice(2));
const cmd = o._[0];
try {
  const out = cmd === 'build' ? await build(o) : cmd === 'draft' ? await draft(o) : null;
  if (!out) throw new Error('쓰는 법: make_draft.mjs build --out <파일> | draft --base <주소> --doc <id> --edits <JSON>');
  process.stdout.write(`${JSON.stringify(out)}\n`);
} catch (e) {
  process.stderr.write(`[make_draft] ${e.message}\n`);
  process.exit(1);
}
