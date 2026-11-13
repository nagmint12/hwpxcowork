// 시험 받침 시험(docs/V3_SPEC.md §6.0·§1.1·§2.2 이음매) — 서버는 받침(tests/helpers/server.mjs)으로 빈 포트에 띄운다.
//   1) 저장소(server/store.js): 원자적 쓰기·남은 임시 파일 정리·버전 번호 검사(경로 조작)·수정본(drafts) 도우미
//   1b) 서비스(server/service.js): 최종본 사본 캐시 — 실패한 _tx 의 커밋 안 된 상태가 workingSnapshot 으로 새지 않음
//   2) 서버(모의 AI): LISTENING/NONCE, /api/config(nonce·studio·studioUrl), /studio/ 캐시 머리글, /vendor/rhwp-*,
//      임시 config 토큰, /file?kind=working 의 X-Doc-Version(쓰기와 겹쳐도 바이트와 일치), 버전 n 검사,
//      요청 route(auto·server → 서버 AI, queue·agent → 대기열)·WS owner
//   3) HWPX_COWORK_AI=off 가 HWPX_COWORK_AI_MOCK=1 을 이김 + 빈 HWPX_COWORK_STUDIO_DIR → /studio/ 503, 대기열 route·owner
//   4) studio.mode=remote → studioUrl = config 값, restart(같은 포트·토큰·data, 새 nonce)
//   5) HWPX_COWORK_CONFIG 파일이 없으면 시작하지 않는다(파일도 만들지 않음)
// 진짜 config.json·data/ 는 쓰지 않는다 — 끝에 config.json 의 시각·크기와 data/docs 목록이 그대로인지 확인한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, uploadDoc, watchWs, fixture, root } from './helpers/server.mjs';
import { Store, writeFileAtomic } from '../server/store.js';
import { Service } from '../server/service.js';
import { HwpxDoc } from '../engine/doc.js';

let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); passed++; console.log('  ✓', msg); };
const section = (s) => console.log(`\n── ${s}`);

const realCfg = path.join(root, 'config.json');
const stamp = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };
function dataListing() {
  const d = path.join(root, 'data', 'docs');
  try { return fs.readdirSync(d).sort().map((id) => `${id}:${stamp(path.join(d, id, 'meta.json'))}`).join('|'); } catch { return 'none'; }
}
const before = { cfg: stamp(realCfg), data: dataListing() };
const servers = [];
const tmpDirs = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

try {
  // ───────── 1. 저장소 ─────────
  section('저장소: 원자적 쓰기·버전 번호·수정본 도우미');
  const sdir = mkTmp('hwpx-store-');
  {
    // 지난 실행이 쓰다 멈춘 임시 파일: 10분 넘은 것만 지운다
    const pre = path.join(sdir, 'docs', 'olddoc1');
    fs.mkdirSync(path.join(pre, 'versions'), { recursive: true });
    const stale = path.join(pre, 'meta.json.tmp-999-1'); const fresh = path.join(pre, 'versions', '2.hwpx.tmp-999-2');
    fs.writeFileSync(stale, 'x'); fs.writeFileSync(fresh, 'y');
    const old = new Date(Date.now() - 3600 * 1000); fs.utimesSync(stale, old, old);
    new Store(sdir);
    ok(!fs.existsSync(stale) && fs.existsSync(fresh), '시작할 때 10분 넘은 임시 파일(.tmp-<pid>-<n>)만 지움');
    fs.rmSync(pre, { recursive: true, force: true });
  }
  const store = new Store(sdir);
  const fx = fs.readFileSync(fixture('tool_memo_tracked.hwpx'));
  const meta = store.create({ fileName: '시험.hwpx', bytes: fx, by: '시험' });
  const docDir = path.join(sdir, 'docs', meta.id);
  ok(meta.version === 1 && Array.isArray(meta.changeRequests) && meta.memoThreads && meta.seq.cr === 0, '새 meta 에 changeRequests·memoThreads·seq.cr');
  const doc = await store.doc(meta.id);
  doc.addMemo('s0/p0', { start: 0, end: 2, author: '시험', text: '저장소 시험' });
  await store.commit(meta.id, doc, { by: '시험', note: '메모', meta }); store.saveMeta(meta);
  ok(meta.version === 2 && fs.readFileSync(path.join(docDir, 'current.hwpx')).equals(fs.readFileSync(path.join(docDir, 'versions', '2.hwpx'))), '커밋: current.hwpx = versions/2.hwpx');
  ok(JSON.parse(fs.readFileSync(path.join(docDir, 'meta.json'), 'utf-8')).version === 2, 'meta.json 저장(버전 2)');
  ok(store.versionBytes(meta.id, 1)?.equals(fx) && store.versionBytes(meta.id, '2') != null, 'versionBytes(1), ("2")');
  const badNs = ['../meta', '..\\..\\x', '2/../1', '0', '-1', '1.5', '1e3', ' 1', '01', '', null, undefined, ['1', '2']];
  ok(badNs.every((n) => store.versionBytes(meta.id, n) === null), `versionBytes: 양의 정수가 아니면 null(${badNs.length}가지, 경로 조작 막기)`);
  ok(['..', '../docs', 'a/b', 'a\\b', ''].every((id) => store.readMeta(id) === null), 'readMeta: 이상한 문서 id 는 null');
  const af = path.join(sdir, 'atomic.txt'); writeFileAtomic(af, 'one'); writeFileAtomic(af, Buffer.from('two'));
  ok(fs.readFileSync(af, 'utf-8') === 'two', 'writeFileAtomic 덮어쓰기');
  ok(store.readDraft(meta.id, 1) === null && store.listDrafts(meta.id).length === 0, '수정본 없음 → readDraft null, listDrafts []');
  store.writeDraft(meta.id, 3, fx); store.writeDraft(meta.id, 1, Buffer.from('draft-1')); store.writeDraft(meta.id, 3, Buffer.from('draft-3b'));
  ok(String(store.readDraft(meta.id, 3)) === 'draft-3b' && fs.existsSync(path.join(docDir, 'drafts', 'c3.hwpx')), 'writeDraft 덮어쓰기 → drafts/c3.hwpx, readDraft');
  const ld = store.listDrafts(meta.id);
  ok(ld.map((x) => x.cid).join() === '1,3' && ld[1].size === 8 && !Number.isNaN(Date.parse(ld[0].updatedAt)), `listDrafts → cid ${ld.map((x) => x.cid).join(',')}`);
  ok(store.deleteDraft(meta.id, 1) === true && store.deleteDraft(meta.id, 1) === false && store.readDraft(meta.id, 1) === null, 'deleteDraft(있으면 true, 없으면 false)');
  let threw = 0; for (const bad of ['../1', 0, -2, '1/../2', 'x', 1.5]) { try { store.draftPath(meta.id, bad); } catch { threw++; } }
  ok(threw === 6 && store.draftPath(meta.id, '7').endsWith(path.join('drafts', 'c7.hwpx')), 'draftPath: 양의 정수만(아니면 던짐)');
  const leftovers = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tmp-\d+-\d+$/.test(n)) leftovers.push(p); } };
  walk(sdir);
  ok(!leftovers.length, '쓰고 난 뒤 임시 파일이 남지 않음');

  // ───────── 1b. 최종본 사본 캐시(server/service.js) ─────────
  section('서비스: 최종본 사본 캐시 — 실패한 _tx 의 커밋 안 된 상태가 workingSnapshot 으로 새지 않음');
  {
    const svc = new Service({ store: new Store(mkTmp('hwpx-wc-')), hub: { broadcast() {}, broadcastAll() {} }, config: {}, ai: null });
    const st = svc.store;
    const wid = st.create({ fileName: '캐시.hwpx', bytes: fx, by: '시험' }).id;
    const memos = async (b) => (await HwpxDoc.load(b)).memos().length;
    const addUncommitted = async (text) => (await st.doc(wid)).addMemo('s0/p0', { start: 0, end: 2, author: '시험', text });
    const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
    const snapOk = async (s) => s.version === 1 && (await memos(s.bytes)) === 1 && (await memos(st.currentBytes(wid))) === 1;

    // (가) _tx 안에서 고친 뒤 workingCopy(캐시 없음 → 메모리 상태로 만듦) → 실패
    await svc._tx(wid, async () => { await addUncommitted('커밋 안 된 메모 1'); await svc.workingCopy(wid); throw new Error('일부러 실패'); }).catch(() => {});
    const sA = await svc.workingSnapshot(wid);
    ok(await snapOk(sA), `(가) _tx 안 workingCopy 뒤 실패 → workingSnapshot v${sA.version}·메모 ${await memos(sA.bytes)}(커밋된 1)`);
    const sA2 = await svc.workingSnapshot(wid);
    ok(sA2.bytes === sA.bytes, 'workingSnapshot 은 같은 버전이면 캐시(같은 바이트)');

    // (나) 캐시가 있을 때: 큐 밖 workingCopy 는 진행 중인 _tx 가 고친 상태가 아니라 커밋된 바이트, 실패한 _tx 는 캐시를 버린다
    const g1 = gate(); const m1 = gate();
    const tx1 = svc._tx(wid, async () => { await addUncommitted('커밋 안 된 메모 2'); m1.open(); await g1.p; throw new Error('일부러 실패'); }).catch(() => {});
    await m1.p;
    const wcHit = await svc.workingCopy(wid);
    g1.open(); await tx1;
    const sB = await svc.workingSnapshot(wid);
    ok(wcHit === sA.bytes && sB.bytes !== sA.bytes && await snapOk(sB), '(나) 큐 밖 workingCopy = 캐시된 커밋 바이트, 실패한 _tx 뒤 캐시는 다시 만듦(메모 1)');

    // (다) 캐시 없음 + 큐 밖 workingCopy 가 진행 중인 _tx 의 고친 doc 을 잡고, 그 _tx 가 실패한 '뒤'에 끝남
    //      → workingCopy 는 공유 캐시를 채우지 않으므로 다음 workingSnapshot 은 커밋된 상태
    await svc._tx(wid, async () => { throw new Error('일부러 실패'); }).catch(() => {});   // 캐시 비우기((나): 실패한 _tx 는 캐시를 버린다)
    const g2 = gate(); const m2 = gate(); const hold = gate();
    const realDoc = st.doc;
    const tx2 = svc._tx(wid, async () => { await addUncommitted('커밋 안 된 메모 3'); m2.open(); await g2.p; throw new Error('일부러 실패'); }).catch(() => {});
    await m2.p;
    st.doc = async (i) => { const d = await realDoc.call(st, i); await hold.p; return d; };   // workingCopy 를 고친 doc 을 잡은 채로 세운다
    const wcLate = svc.workingCopy(wid);
    await new Promise((r) => setTimeout(r, 20));
    g2.open(); await tx2;          // _tx 실패(메모리 doc·캐시 버림)
    hold.open(); delete st.doc;    // 그 뒤에 workingCopy 가 커밋 안 된 doc 으로 사본을 만든다
    const lateMemos = await memos(await wcLate);
    const sC = await svc.workingSnapshot(wid);
    ok(lateMemos === 2 && await snapOk(sC), `(다) 실패 뒤에 끝난 workingCopy(메모 ${lateMemos}) 가 캐시에 남지 않음 → workingSnapshot 메모 ${await memos(sC.bytes)}`);
  }

  // ───────── 2. 서버(모의 AI) ─────────
  section('받침 + 서버(모의 AI)');
  const srv1 = await startServer({ ai: 'mock', config: { studioUrl: 'https://edwardkim.github.io/rhwp/' } }); servers.push(srv1);
  ok(srv1.port > 0 && srv1.lines[0] === `LISTENING ${srv1.port}`, `stdout 첫 줄: ${srv1.lines[0]}`);
  ok(srv1.lines[1] === `NONCE ${srv1.config.nonce}` && /^[0-9a-f]{16}$/.test(srv1.config.nonce), '둘째 줄 NONCE = /api/config 의 nonce');
  const c1 = srv1.config;
  ok(c1.aiEnabled === true && c1.aiMock === true, 'ai: mock → aiEnabled·aiMock');
  ok(c1.publicUrl === `http://localhost:${srv1.port}`, `포트 0 → publicUrl 은 실제 포트(${c1.publicUrl})`);
  ok(c1.studio.mode === 'local' && c1.studio.built === true && typeof c1.studio.buildInfo?.builtAt === 'string' && c1.studioUrl === '/studio/', 'studio: local·built·buildInfo, studioUrl = /studio/');
  ok(srv1.output().includes('config.studioUrl(https://edwardkim.github.io/rhwp/) 은 쓰지 않습니다'), '옛 github studioUrl 은 무시한다고 시작 로그 한 줄');

  const pub = srv1.api(null);
  const idx = await pub.res('/studio/');
  ok(idx.status === 200 && /text\/html/.test(idx.headers.get('content-type')) && idx.headers.get('cache-control') === 'no-cache' && idx.data.includes('/studio/assets/'), '/studio/ → 200 index.html(Cache-Control: no-cache)');
  const assets = fs.readdirSync(path.join(root, 'studio', 'dist', 'assets'));
  const jsName = assets.find((n) => n.endsWith('.js')); const wasmName = assets.find((n) => n.endsWith('.wasm'));
  const a1 = await pub.res(`/studio/assets/${jsName}`);
  // 2026-11-04 낡은 기대값(max-age=86400) 고침: 11-03 부터 이름에 해시가 든 assets/ 는 1년 불변 캐시(server/index.js studioHeaders 주석 — 다시 빌드하면 이름이 바뀐다)
  ok(a1.status === 200 && a1.headers.get('cache-control') === 'public, max-age=31536000, immutable', `/studio/assets/${jsName} → ${a1.headers.get('cache-control')}`);
  if (wasmName) {
    const a2 = await pub.res(`/studio/assets/${wasmName}`);
    ok(a2.status === 200 && a2.headers.get('content-type') === 'application/wasm', `/studio/assets/${wasmName} → application/wasm`);
  }
  const plain = fs.readdirSync(path.join(root, 'studio', 'dist')).find((n) => n.endsWith('.js'));
  if (plain) {
    const p1 = await pub.res(`/studio/${plain}`);
    ok(p1.status === 200 && p1.headers.get('cache-control') === 'no-cache', `해시 없는 /studio/${plain} → no-cache`);
  }
  ok((await pub.res('/studio/no-such-file.js')).status === 404, '/studio/ 의 없는 파일 → 404');
  const wasm = await pub.res('/vendor/rhwp-core/rhwp_bg.wasm');
  ok(wasm.status === 200 && wasm.headers.get('content-type') === 'application/wasm' && wasm.data.length === fs.statSync(path.join(root, 'vendor', 'rhwp', 'pkg', 'rhwp_bg.wasm')).size, `/vendor/rhwp-core/rhwp_bg.wasm(vendor/rhwp/pkg, ${wasm.data.length}B, application/wasm)`);
  ok((await pub.res('/vendor/rhwp-core/rhwp.js')).status === 200, '/vendor/rhwp-core/rhwp.js');
  const edj = await pub.res('/vendor/rhwp-editor/index.js');
  ok(edj.status === 200 && String(edj.data).includes('export async function createStudio'), '/vendor/rhwp-editor/index.js(vendor/rhwp/npm/editor)');
  ok((await pub.res('/vendor/vue.esm-browser.prod.js')).status === 200, '/vendor/vue.esm-browser.prod.js 그대로');

  for (const who of ['admin', 'a', 'b']) {
    const me = await srv1.api(who)('/api/me');
    ok(me.name === srv1.users[who].name && me.role === srv1.users[who].role, `임시 config 토큰(${who}) → ${me.name}/${me.role}`);
  }
  ok((await srv1.api('wrong-token').res('/api/me')).status === 401 && (await pub.res('/api/me')).status === 401, '틀린 토큰·토큰 없음 → 401');
  const A = srv1.api('a');
  ok((await A('/api/docs')).length === 0, '새 임시 data 폴더 → 문서 0건');

  const d1 = await uploadDoc(srv1.base, srv1.tokens.a, fixture('tool_memo_tracked.hwpx'), '받침 시험.hwpx');
  ok(d1.id && d1.version === 1 && d1.title === '받침 시험', `uploadDoc → ${d1.id} 「${d1.title}」`);
  let wf = await A.res(`/api/docs/${d1.id}/file?kind=working`);
  ok(wf.status === 200 && wf.headers.get('x-doc-version') === '1' && (await HwpxDoc.load(wf.data)).memos().length === 1, '최종본 사본 + X-Doc-Version 1(메모 1)');
  await A(`/api/docs/${d1.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '메모 대상', text: '받침 시험 메모' } });
  wf = await A.res(`/api/docs/${d1.id}/file?kind=working`);
  ok(wf.headers.get('x-doc-version') === '2' && (await HwpxDoc.load(wf.data)).memos().length === 2, '메모 뒤 X-Doc-Version 2(메모 2)');
  // 쓰기와 읽기를 겹친다: 이 문서는 버전마다 메모가 하나씩 늘어 '메모 수 = 버전' — 사본과 X-Doc-Version 이 같은 상태여야 한다
  const jobs = [];
  for (let i = 0; i < 4; i++) {
    jobs.push(A(`/api/docs/${d1.id}/memos`, { method: 'POST', body: { ref: 's0/p0', find: '메모 대상', text: `겹침 ${i}` } }).then(() => null));
    jobs.push(A.res(`/api/docs/${d1.id}/file?kind=working`).then(async (r) => ({ v: Number(r.headers.get('x-doc-version')), memos: (await HwpxDoc.load(r.data)).memos().length })));
  }
  const snaps = (await Promise.all(jobs)).filter(Boolean);
  ok(snaps.length === 4 && snaps.every((s) => s.memos === s.v), `쓰기와 겹친 사본 4건: 버전 = 메모 수(${snaps.map((s) => `v${s.v}/${s.memos}`).join(' ')})`);
  const vbad = await A.res(`/api/docs/${d1.id}/file?kind=version&n=..%2F..%2Fmeta`);
  ok(vbad.status === 404 && vbad.data.error === 'NO_VERSION', '/file?kind=version&n=../../meta → 404 NO_VERSION');
  ok((await Promise.all(['0', '1.5', '-1'].map((n) => A.res(`/api/docs/${d1.id}/file?kind=version&n=${n}`)))).every((r) => r.status === 404), 'n=0·1.5·-1 → 404');
  const v1 = await A.res(`/api/docs/${d1.id}/file?kind=version&n=1`);
  ok(v1.status === 200 && v1.data.equals(fs.readFileSync(fixture('tool_memo_tracked.hwpx'))), 'n=1 → 올린 원본 그대로');
  ok((await A.res('/api/docs/..%2F..%2Fx/file')).status === 404, '문서 id 경로 조작(..%2F) → 404');

  const w1 = watchWs(srv1.base, srv1.tokens.b, d1.id); await w1.ready;
  const rq = await A(`/api/docs/${d1.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' } } });
  ok(rq.queued === false && rq.route === 'server' && rq.request.status === 'done', `모의 AI → route 'server', 요청 #${rq.request.rid} ${rq.request.status}`);
  const addMsg = await w1.waitFor((m) => m.type === 'request' && m.action === 'add' && m.rid === rq.request.rid);
  const doneMsg = await w1.waitFor((m) => m.type === 'request' && m.action === 'done' && m.rid === rq.request.rid);
  ok(addMsg.owner === srv1.users.a.name && doneMsg.owner === srv1.users.a.name && doneMsg.by === '모의 AI', `WS request add·done 에 owner(${addMsg.owner}), by ${doneMsg.by}`);
  const br = await A.res(`/api/docs/${d1.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'bogus' } });
  ok(br.status === 400 && br.data.error === 'BAD_ROUTE', "route: 'bogus' → 400 BAD_ROUTE");
  // 고른 경로를 따른다(§2.2): 서버 AI 가 켜져 있어도 queue 는 대기열, agent 는 연결된 에이전트가 없으니 대기열
  const rqQ = await A(`/api/docs/${d1.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'queue' } });
  ok(rqQ.queued === true && rqQ.route === 'queue' && rqQ.request.status === 'pending' && !rqQ.request.handledBy, `AI 켜짐 + route 'queue' → 대기열(요청 #${rqQ.request.rid} pending)`);
  ok(typeof rqQ.hint === 'string' && rqQ.hint.startsWith('대기열에 넣었습니다') && !rqQ.hint.includes('꺼져'), `대기열 안내에 'AI 꺼짐' 이 없음(${rqQ.hint.split('.')[0]})`);
  const rqA = await A(`/api/docs/${d1.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'agent' } });
  ok(rqA.queued === true && rqA.route === 'queue' && rqA.request.status === 'pending', "AI 켜짐 + route 'agent'(에이전트 없음) → 'queue'");
  const rqS = await A(`/api/docs/${d1.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'server' } });
  ok(rqS.queued === false && rqS.route === 'server' && rqS.request.status === 'done', "AI 켜짐 + route 'server' → 서버 AI 처리(done)");
  await w1.waitFor((m) => m.type === 'request' && m.action === 'done' && m.rid === rqS.request.rid);   // 이보다 앞선 방송은 모두 도착
  const addQA = [rqQ, rqA].map((x) => w1.msgs.find((m) => m.type === 'request' && m.action === 'add' && m.rid === x.request.rid));
  const workedQA = w1.msgs.filter((m) => m.type === 'request' && m.action !== 'add' && [rqQ.request.rid, rqA.request.rid].includes(m.rid));
  ok(addQA.every((m) => m?.owner === srv1.users.a.name) && !workedQA.length, `대기열 요청은 add 방송(owner ${addQA[0]?.owner})만, working·done 없음`);
  const pendList = await A(`/api/docs/${d1.id}/requests?status=pending`);
  ok([rqQ, rqA].every((x) => pendList.find((r) => r.rid === x.request.rid)?.status === 'pending'), '목록에서도 두 요청이 pending(에이전트가 가져갈 수 있음)');
  w1.close();
  await srv1.stop();
  ok(!fs.existsSync(srv1.tmpDir) && (srv1.child.exitCode !== null || srv1.child.signalCode !== null), 'stop() → 서버 끝, 임시 폴더 지움');

  // ───────── 3. AI 강제 끔 + 빈 studio 폴더 ─────────
  section('HWPX_COWORK_AI=off(+ HWPX_COWORK_AI_MOCK=1) · 빈 HWPX_COWORK_STUDIO_DIR');
  const emptyStudio = mkTmp('hwpx-nostudio-');
  const srv2 = await startServer({ ai: 'off', env: { HWPX_COWORK_AI_MOCK: '1', HWPX_COWORK_STUDIO_DIR: emptyStudio } }); servers.push(srv2);
  const c2 = srv2.config;
  ok(c2.aiEnabled === false && c2.aiMock === false && /HWPX_COWORK_AI=off/.test(c2.aiReason || ''), `AI 끔이 모의 AI 를 이김(aiReason: ${c2.aiReason})`);
  ok(c2.studio.built === false && c2.studio.buildInfo === null && c2.studioUrl === '/studio/', 'studio 빌드 없음 → built false, studioUrl 은 /studio/');
  const s503 = await srv2.api(null).res('/studio/');
  ok(s503.status === 503 && /text\/html/.test(s503.headers.get('content-type')) && s503.data.includes('npm run build:studio') && s503.data.includes('빌드'), '/studio/ → 503 + 한국어 빌드 안내');
  ok((await srv2.api(null).res('/studio/assets/x.js')).status === 503, '/studio/assets/* 도 503');
  ok(srv2.output().includes('npm run build:studio'), '시작 로그에 빌드 안내');
  const d2 = await uploadDoc(srv2.base, srv2.tokens.a, fixture('tool_memo_tracked.hwpx'));
  const w2 = watchWs(srv2.base, srv2.tokens.b, d2.id); await w2.ready;
  const q = await srv2.api('a')(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'auto' } });
  ok(q.queued === true && q.route === 'queue' && q.request.status === 'pending', "AI 끔 → route 'queue', 요청 pending");
  const qs = await srv2.api('a')(`/api/docs/${d2.id}/requests`, { method: 'POST', body: { kind: 'review', target: { ref: 's0/p0' }, route: 'server' } });
  ok(qs.queued === true && qs.route === 'queue' && qs.request.status === 'pending' && qs.hint.startsWith('서버 AI 가 꺼져 있어'), "AI 끔 + route 'server' → 'queue'(안내: 서버 AI 가 꺼져 있어…)");
  const addQ = await w2.waitFor((m) => m.type === 'request' && m.action === 'add' && m.rid === q.request.rid);
  ok(addQ.owner === srv2.users.a.name, `대기열 add 방송 owner ${addQ.owner}`);
  await srv2.api('b')(`/api/docs/${d2.id}/memos`, { method: 'POST', body: { ref: 's0/p0', text: 'B 의견', rid: q.request.rid } });
  const upd = await w2.waitFor((m) => m.type === 'request' && m.action === 'update' && m.rid === q.request.rid);
  ok(upd.owner === srv2.users.a.name && upd.by === srv2.users.b.name, `남이 단 의견 → update 방송 owner ${upd.owner}(요청자), by ${upd.by}`);
  await srv2.api('a')(`/api/docs/${d2.id}/requests/${q.request.rid}/cancel`, { method: 'POST' });
  const cm = await w2.waitFor((m) => m.type === 'request' && m.action === 'cancelled' && m.rid === q.request.rid);
  ok(cm.owner === srv2.users.a.name, 'cancelled 방송 owner');
  w2.close();
  await srv2.stop();

  // ───────── 4. remote · restart ─────────
  section('studio.mode=remote · restart(같은 포트·토큰·data)');
  const srv3 = await startServer({ ai: 'off', config: { studio: { mode: 'remote' }, studioUrl: 'https://example.invalid/rhwp/' } }); servers.push(srv3);
  ok(srv3.config.studio.mode === 'remote' && srv3.config.studioUrl === 'https://example.invalid/rhwp/', 'remote → studioUrl = config.studioUrl');
  ok(srv3.output().includes('studio.mode=remote'), '시작 로그에 remote 안내');
  const d3 = await uploadDoc(srv3.base, srv3.tokens.a, fixture('tool_memo_tracked.hwpx'));
  const before3 = { port: srv3.port, nonce: srv3.nonce };
  await srv3.restart({ ai: 'mock' });
  ok(srv3.port === before3.port && srv3.nonce !== before3.nonce && srv3.config.aiMock === true, `restart → 같은 포트 ${srv3.port}, 새 nonce, 모의 AI`);
  ok((await srv3.api('a')('/api/docs')).some((d) => d.id === d3.id), 'restart 뒤에도 같은 data·토큰');
  await srv3.stop();

  // ───────── 5. config 파일이 없으면 ─────────
  section('HWPX_COWORK_CONFIG 파일이 없으면');
  const nocfg = mkTmp('hwpx-nocfg-');
  const missing = path.join(nocfg, 'nope.json');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^HWPX_COWORK_/i.test(k)) env[k] = v;
  Object.assign(env, { HWPX_COWORK_CONFIG: missing, HWPX_COWORK_DATA_DIR: path.join(nocfg, 'data'), HWPX_COWORK_PORT: '0', HWPX_COWORK_HOST: '127.0.0.1', HWPX_COWORK_AI: 'off' });
  const run = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; c.stdout.on('data', (s) => { out += s; }); c.stderr.on('data', (s) => { out += s; });
    const t = setTimeout(() => { c.kill(); resolve({ code: 'timeout', out }); }, 20000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  ok(run.code !== 0 && run.code !== 'timeout' && run.out.includes('HWPX_COWORK_CONFIG') && !run.out.includes('LISTENING'), `시작하지 않음(code ${run.code}) + 분명한 오류`);
  ok(!fs.existsSync(missing) && !fs.existsSync(path.join(nocfg, 'data')), 'config 파일·data 폴더를 만들지 않음');

  // ───────── 진짜 설정·자료 ─────────
  section('진짜 config.json·data/ 그대로');
  ok(stamp(realCfg) === before.cfg, `config.json 시각·크기 그대로(${before.cfg})`);
  ok(dataListing() === before.data, 'data/docs 목록·meta.json 시각 그대로');
  console.log(`\nAPI HARNESS OK — ${passed}개 확인`);
} catch (e) {
  console.error('\nAPI HARNESS FAILED:', e.message);
  for (const s of servers) if (s.output) console.error(`--- 서버 ${s.base} 출력(끝) ---\n${s.output().slice(-2000)}`);
  process.exitCode = 1;
} finally {
  for (const s of servers) await s.stop().catch(() => {});
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
