// node --test tests/page_layout_stale.test.mjs — 쪽 구성 제안과 같은 요청의 다른 제안을 함께 반영(2026-11-17).
//  실제 일: Claude 실행기가 24쪽 문서를 다시 쓰며 제안 80건을 냈다 — #80 은 쪽 구성(용지·여백 + 구역 합치기 ×23 + 쪽 번호)이고 사유에 '다른 제안을 모두 반영한 뒤
//  맨 마지막에 반영해 주세요'. [모두 반영]에서 37건은 반영되고 #80 은 '실패 1'(서버 기록에 사유 없음) — 예전 지문(engine/page-layout.js pageLayoutStateFingerprint)이
//  구역마다 문단 수를 넣어, 같은 요청의 문단·표 넣기를 먼저 반영하면 쪽 구성은 언제나 STALE 이었다.
//  지금: 쪽 구성 제안은 기대는 상태(구역 구성·옮길 개체 — pageLayoutState v2)만 견주고, 문단 주소를 쓰는 op(구역 나누기 before_ref·개체 → 본문 at …)는
//  대기 중에 다른 제안 주소와 함께 옮긴다(remapLayoutOps — service._remapSectionsDeep). 거꾸로(쪽 구성 먼저)는 _layoutRemap 이 다른 대기 제안 주소를 옮긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Service } from '../server/service.js';
import { Store } from '../server/store.js';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { editPageLayout, getPageLayout, pageLayoutState, remapLayoutOps, layoutOpsRefs } from '../engine/page-layout.js';
import { normalizePageLayoutOps } from '../server/page-layout-schema.js';
import { editWorkflowOffError } from '../server/edit-workspace-service.js';
import { root } from './helpers/server.mjs';
import { makePng } from './helpers/image.mjs';
import { floatingDoc } from './helpers/floating-doc.mjs';

const user = { name: '쪽 구성 시험', role: 'admin' };
const BLANK = path.join(root, 'server', 'templates', 'blank.hwpx');
// 실시간 '고친 글만' · 실시간 '변경 추적으로' · 승인 방식(변경 추적)
const MODES = [{ editMode: 'realtime', track: 'final' }, { editMode: 'realtime', track: 'changes' }, { editMode: 'approval', track: 'changes' }];
const label = (s) => `${s.editMode}/${s.track}`;
// 실제 #80 과 같은 꼴: 용지·여백 + 구역 합치기(구역 셋 → 하나) + 쪽 번호
const LAYOUT = [
  { op: 'paper', section: 0, width_mm: 210, height_mm: 297, margins: { left: 30, right: 30, top: 20, bottom: 15, header: 15, footer: 15 } },
  { op: 'merge_section', section: 0 }, { op: 'merge_section', section: 0 },
  { op: 'page_number', section: 0, position: 'BOTTOM_CENTER' },
];

/** 구역 셋: s0 = ['', 가0, 가1, 가2] · s1 = [나0, 나1, 나2] · s2 = [다0, 다1, 다2] */
async function threeSections() {
  const doc = await HwpxDoc.load(fs.readFileSync(BLANK));
  ['가0', '가1', '가2', '나0', '나1', '나2', '다0', '다1', '다2'].forEach((t, i) => doc.insertParagraphAfter(0, i, t, {}));
  if (doc.changes().length) doc.acceptAll();
  editPageLayout(doc, normalizePageLayoutOps([{ op: 'split_section', before_ref: 's0/p4' }]));
  editPageLayout(doc, normalizePageLayoutOps([{ op: 'split_section', before_ref: 's1/p3' }]));
  return Buffer.from(await doc.save());
}
const texts = (doc) => doc.sections.map((s) => s.bodyParas.map((p) => Section.text(p, 'final')));

async function setup(t, settings = MODES[0], bytes = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-plstale-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('hwpx-plstale-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const store = new Store(dir);
  const service = new Service({ store, config: { root: dir, dataDir: dir, tutorial: { enabled: false } }, hub: { broadcast() {}, broadcastAll() {} }, ai: { enabled: false } });
  const id = store.create({ fileName: 'layout.hwpx', bytes: bytes || await threeSections(), by: user.name, extra: { settings } }).id;
  const request = (await service.createRequest(id, { kind: 'instruct', target: { scope: 'document' }, instruction: '쪽 구성 시험', route: 'queue' }, user)).request;
  const doc = () => store.doc(id);
  const meta = () => store.readMeta(id);
  const prop = (pid) => meta().proposals.find((p) => p.pid === pid);
  return {
    store, service, id, request, doc, meta, prop,
    propose: (body) => service.propose(id, { rid: request.rid, ...body }, user),
    layout: (ops) => service.propose(id, { rid: request.rid, type: 'page_layout', pageLayout: { ops } }, user),
    apply: (pid) => service.applyProposal(id, pid, user),
    applyRest: () => service.resolveRequest(id, request.rid, { apply: 'rest' }, user),
  };
}
const noFail = (out) => assert.equal(out.counts.failed, 0, JSON.stringify(out.results));

/** 같은 요청의 본문 제안 넷(문단 넣기·표 넣기·글 바꾸기 둘 — 구역 첫 문단 포함) */
async function bodyProposals(s) {
  return [
    await s.propose({ afterRef: 's1/p1', text: '나1 뒤 새 문단' }),
    await s.propose({ type: 'table', afterRef: 's2/p0', table: { rows: [['머리', '값'], ['가', '1']] } }),
    await s.propose({ ref: 's2/p2', find: '다2', replace: '다2 고침' }),
    await s.propose({ ref: 's1/p0', find: '나0', replace: '나0 제목' }),
  ];
}
/** 모두 반영한 뒤의 문서: 구역 하나, 글 차례, 표는 '다0' 바로 뒤, 쪽 설정 */
async function assertMerged(s, tag) {
  const doc = await s.doc();
  assert.equal(doc.sections.length, 1, tag);
  const body = texts(doc)[0];
  assert.deepEqual(body.filter(Boolean), ['가0', '가1', '가2', '나0 제목', '나1', '나1 뒤 새 문단', '나2', '다0', '다1', '다2 고침'], tag);
  assert.equal(doc.tables().length, 1, tag);
  const at = Number(/^s0\/p(\d+)/.exec(doc.tables()[0].key)[1]);
  assert.ok(at > body.indexOf('다0') && at < body.indexOf('다1'), `${tag}: 표 자리 ${at} — ${JSON.stringify(body)}`);
  const page = getPageLayout(doc).sections[0];
  assert.equal(page.page_numbers[0]?.pos, 'BOTTOM_CENTER', tag);
  assert.ok(Math.abs(page.paper.margins.left - 30) < 0.01 && Math.abs(page.paper.margins.bottom - 15) < 0.01, tag);
}

test('[모두 반영]: 같은 요청의 문단·표 넣기·글 바꾸기를 먼저 반영해도 마지막의 쪽 구성(용지·구역 합치기 ×2·쪽 번호)이 반영된다 — 세 문서 방식', async (t) => {
  for (const settings of MODES) {
    const s = await setup(t, settings);
    await bodyProposals(s);
    const layout = await s.layout(LAYOUT);
    assert.equal(layout.pageLayout.state.v, 2);
    const out = await s.applyRest();
    noFail(out);
    assert.equal(out.counts.applied, 5, label(settings));
    assert.equal(s.prop(layout.pid).status, 'applied', label(settings));
    await assertMerged(s, label(settings));
    // 되돌리기(복구)도 된다 — 구역 셋으로 돌아오고 본문 제안은 그대로
    await s.service.undoProposal(s.id, layout.pid, user);
    assert.equal((await s.doc()).sections.length, 3, label(settings));
  }
});

test('하나씩 반영: 본문 제안을 번호순으로 하나씩 반영한 뒤 쪽 구성도 반영된다', async (t) => {
  const s = await setup(t, MODES[2]);
  const body = await bodyProposals(s);
  const layout = await s.layout(LAYOUT);
  for (const p of body) await s.apply(p.pid);
  await s.apply(layout.pid);
  await assertMerged(s, '하나씩');
});

test('거꾸로(쪽 구성 먼저): 합친 구역으로 다른 대기 제안 주소를 옮겨 남은 제안도 반영된다 — 세 문서 방식', async (t) => {
  for (const settings of MODES) {
    const s = await setup(t, settings);
    const body = await bodyProposals(s);
    const layout = await s.layout(LAYOUT);
    await s.apply(layout.pid);
    // s1/p1 뒤 넣기 → s0/p5 뒤(구역 0 이 문단 4개), s2/p0 뒤 표 → s0/p7 뒤, s2/p2 → s0/p9, s1/p0 → s0/p4
    assert.deepEqual(body.map((p) => { const q = s.prop(p.pid); return q.afterRef && ['insert', 'table'].includes(q.type) ? q.afterRef : q.ref; }), ['s0/p5', 's0/p7', 's0/p9', 's0/p4'], label(settings));
    noFail(await s.applyRest());
    await assertMerged(s, `거꾸로 ${label(settings)}`);
  }
});

test('새 연결 edit: 한 호출에 넣기·표·글 바꾸기와 쪽 구성 op(용지·구역 합치기·쪽 번호)를 함께 내면 — 어느 차례로 적어도 [모두 반영]이 모두 반영한다', async (t) => {
  const body = [
    { op: 'insert', after: 's1/p1', text: '나1 뒤 새 문단' },
    { op: 'table', after: 's2/p0', rows: [['머리', '값'], ['가', '1']] },
    { op: 'replace', at: 's2/p2', find: '다2', with: '다2 고침' },
    { op: 'replace', at: 's1/p0', find: '나0', with: '나0 제목' },
  ];
  for (const [name, ops] of [['본문 먼저', [...body, ...LAYOUT]], ['쪽 구성 먼저', [...LAYOUT, ...body]]]) {
    const s = await setup(t, MODES[1]);
    const res = await s.service.agentEdit(s.id, { ops, rid: s.request.rid }, user, null);
    assert.ok(!res.failed?.length, `${name}: ${JSON.stringify(res.failed)}`);
    // 저장 영수증의 반영 흉내(server/page-estimate.js — 실제 반영 경로)에도 실패가 없다
    assert.ok(!res.pages?.apply_failed?.length, `${name}: ${JSON.stringify(res.pages?.apply_failed)}`);
    const layout = s.meta().proposals.find((p) => p.type === 'page_layout');
    const others = s.meta().proposals.filter((p) => p.type !== 'page_layout');
    assert.equal(name === '본문 먼저' ? layout.pid > Math.max(...others.map((p) => p.pid)) : layout.pid < Math.min(...others.map((p) => p.pid)), true, name);
    noFail(await s.applyRest());
    await assertMerged(s, name);
    if (name === '본문 먼저') {
      // 쪽 구성이 커밋의 마지막 반영 → 고치기 전 사본으로 되돌릴 수 있다(본문 제안의 글은 사본에 들어 있다)
      await s.service.undoProposal(s.id, layout.pid, user);
      assert.equal((await s.doc()).sections.length, 3, name);
    } else {
      // 같은 커밋에서 쪽 구성 뒤에 다른 제안이 반영됐다 → 사본으로 되돌리면 그 글이 사라진다(예전: 되돌려지고 글이 사라진 채 제안은 '반영'). 지금은 STALE 로 막는다
      await assert.rejects(s.service.undoProposal(s.id, layout.pid, user), (e) => e.code === 'STALE');
      await assertMerged(s, `${name} 되돌리기 막음`);
    }
  }
});

test('구역 구성이 다른 길로 바뀌면 STALE 그대로 — 사유가 응답·제안 기록·문서 활동 기록에 남는다', async (t) => {
  // ① 다른 요청의 머리말 쪽 구성을 먼저 반영(구역 1 에 머리말이 생김) → 이 요청의 쪽 구성은 STALE(구역 구성), 본문 제안은 반영
  const s = await setup(t, MODES[0]);
  await bodyProposals(s);
  const layout = await s.layout(LAYOUT);
  const other = (await s.service.createRequest(s.id, { kind: 'instruct', target: { scope: 'document' }, instruction: '머리말', route: 'queue' }, user)).request;
  const header = await s.service.propose(s.id, { rid: other.rid, type: 'page_layout', pageLayout: { ops: [{ op: 'header', section: 1, text: '둘째 구역 머리말' }] } }, user);
  await s.apply(header.pid);
  const out = await s.applyRest();
  assert.equal(out.counts.applied, 4);
  const bad = out.results.find((x) => x.pid === layout.pid);
  assert.deepEqual([bad.ok, bad.code], [false, 'STALE']);
  assert.match(bad.error, /구역 구성/);
  assert.equal((await s.doc()).sections.length, 3);   // 합쳐지지 않았다
  const p = s.prop(layout.pid);
  assert.equal(p.status, 'pending');
  assert.match(p.log.at(-1).detail, /^STALE: 제안한 뒤 구역 구성/);
  assert.equal(p.log.at(-1).action, 'apply-failed');
  assert.match(s.meta().activity.at(-1).detail, new RegExp(`실패 1\\(#${layout.pid} STALE: 제안한 뒤 구역 구성`));
  // ② 용지(여백)를 다른 제안이 먼저 바꿈 → STALE(하나씩 반영 응답에도 사유)
  const s2 = await setup(t, MODES[1]);
  const mine = await s2.layout(LAYOUT);
  const margin = await s2.service.propose(s2.id, { type: 'page_layout', pageLayout: { ops: [{ op: 'paper', section: 0, margins: { left: 25 } }] } }, user);
  await s2.apply(margin.pid);
  await assert.rejects(s2.apply(mine.pid), (e) => e.code === 'STALE' && /구역 구성/.test(e.message));
  // ③ 구역 수가 바뀜(다른 쪽 구성이 구역 하나를 합침) → STALE
  const s3 = await setup(t, MODES[2]);
  const mine3 = await s3.layout([{ op: 'page_number', section: 2, position: 'BOTTOM_RIGHT' }]);
  const merge = await s3.service.propose(s3.id, { type: 'page_layout', pageLayout: { ops: [{ op: 'merge_section', section: 1 }] } }, user);
  await s3.apply(merge.pid);
  await assert.rejects(s3.apply(mine3.pid), (e) => e.code === 'STALE');
});

test('구역 나누기 before_ref: 앞에 문단이 들어가면 따라 옮겨 같은 문단 앞에서 나누고, 합치기 뒤 주소를 쓰는 나누기는 문단 수가 바뀌면 STALE', async (t) => {
  for (const settings of MODES) {
    const s = await setup(t, settings);
    const ins = await s.propose({ afterRef: 's0/p0', text: '맨 앞 새 문단' });
    const split = await s.layout([{ op: 'paper', section: 0, margins: { left: 25 } }, { op: 'split_section', before_ref: 's0/p2' }]);   // '가1' 앞
    noFail(await s.applyRest());
    assert.equal(s.prop(split.pid).status, 'applied', label(settings));
    assert.equal(s.prop(split.pid).pageLayout.ops[1].before_ref, 's0/p3', label(settings));   // 따라 옮긴 주소(반영 전 문서의 주소)
    const got = texts(await s.doc());
    assert.deepEqual(got.map((x) => x.filter(Boolean)), [['맨 앞 새 문단', '가0'], ['가1', '가2'], ['나0', '나1', '나2'], ['다0', '다1', '다2']], label(settings));
    assert.equal(s.prop(ins.pid).status, 'applied');
  }
  // 합치기 뒤의 주소(s0/p5 = 합친 뒤 '나1')를 쓰는 나누기: 앞 op 를 한 뒤 주소라 옮길 수 없다 — 문단 수가 바뀌면 STALE(사유: 문단)
  const s = await setup(t, MODES[0]);
  await s.propose({ afterRef: 's0/p0', text: '맨 앞 새 문단' });
  const late = await s.layout([{ op: 'merge_section', section: 0 }, { op: 'split_section', before_ref: 's0/p5' }]);
  assert.equal(layoutOpsRefs(late.pageLayout.ops).trailing, true);
  const out = await s.applyRest();
  const bad = out.results.find((x) => x.pid === late.pid);
  assert.deepEqual([bad.ok, bad.code], [false, 'STALE']);
  assert.match(bad.error, /문단이 늘거나 줄었습니다/);
  // 같은 상태(문단 수 그대로)면 반영된다
  const t2 = await setup(t, MODES[0]);
  const ok = await t2.layout([{ op: 'merge_section', section: 0 }, { op: 'split_section', before_ref: 's0/p5' }]);
  await t2.apply(ok.pid);
  assert.deepEqual(texts(await t2.doc()).map((x) => x.filter(Boolean)), [['가0', '가1', '가2', '나0'], ['나1', '나2'], ['다0', '다1', '다2']]);
});

test('나누기 자리 문단이 지워지면 GONE(대상 문단이 지워짐), 쪽 구성 op 가 반영 가운데 실패하면 문서를 되돌려 그 제안만 실패로 남긴다', async (t) => {
  // 실시간 '고친 글만': 문단째 지우기가 '가1'(s0/p2)을 지운다 → before_ref 를 잃는다
  const s = await setup(t, MODES[0]);
  const del = await s.propose({ type: 'para_delete', ref: 's0/p2', toRef: 's0/p2' });
  const split = await s.layout([{ op: 'split_section', before_ref: 's0/p2' }]);
  const out = await s.applyRest();
  assert.equal(s.prop(del.pid).status, 'applied');
  assert.deepEqual(out.results.find((x) => x.pid === split.pid).code, 'GONE');
  // 가운데서 실패: 용지 op 를 문서에 한 뒤 바탕쪽 op 가 그 사이 지워진 첨부를 찾지 못한다(NO_ATTACHMENT). 예전에는 문서가 반쯤 바뀐 채 오류라
  // [모두 반영]이 통째로 버려졌다(앞서 반영한 문단 넣기까지). 지금은 반영 전으로 되돌리고 그 제안만 실패로 적는다 — 세 문서 방식
  for (const settings of MODES) {
    const s2 = await setup(t, settings);
    const att = await s2.service.addAttachment(s2.id, { name: 'bg.png', bytes: makePng(8, 8) }, user);
    const ins2 = await s2.propose({ afterRef: 's1/p1', text: '나1 뒤 새 문단' });
    const bg = await s2.layout([{ op: 'paper', section: 0, margins: { left: 25 } }, { op: 'master_page', section: 0, attachment_id: att.aid }]);
    await s2.service.deleteAttachment(s2.id, att.aid, user);
    const before = getPageLayout(await s2.doc()).sections[0].paper.margins.left;
    const out2 = await s2.applyRest();
    assert.equal(s2.prop(ins2.pid).status, 'applied', label(settings));
    const r2 = out2.results.find((x) => x.pid === bg.pid);
    assert.deepEqual([r2.ok, r2.code], [false, 'NO_ATTACHMENT'], label(settings));
    const doc = await s2.doc();
    assert.equal(getPageLayout(doc).sections[0].paper.margins.left, before, label(settings));   // 용지 op 도 되돌림
    assert.deepEqual(getPageLayout(doc).sections[0].master_pages, [], label(settings));
    assert.ok(texts(doc)[1].includes('나1 뒤 새 문단'), label(settings));
    assert.equal(s2.prop(bg.pid).log.at(-1).action, 'apply-failed');
  }
});

test('개체 → 본문: 같은 요청의 문단 넣기로 옮길 개체가 있는 문단 주소만 밀리면 at 목록을 따라 옮겨 반영하고, 옮길 개체가 바뀌면 STALE', async (t) => {
  // 쪽마다 구역 하나인 글상자 문서를 합쳐 한 구역에 개체 문단 둘(s0/p0·s0/p1)을 둔다 — s0/p0 뒤에 문단을 넣으면 둘째 개체 문단 주소가 s0/p2 로 밀린다
  const make = async () => {
    const d = await floatingDoc({ pages: [
      { title: '첫 쪽 제목', table: { cols: [8000, 20000, 19800], header: true, rows: [['이름', '값', '설명'], ['A', '1', '첫째']] } },
      { title: '둘째 쪽 제목', table: { cols: [8000, 20000, 19800], header: true, rows: [['이름', '값', '설명'], ['B', '2', '둘째']] } },
    ] });
    editPageLayout(d, normalizePageLayoutOps([{ op: 'merge_section', section: 0 }]));
    return Buffer.from(await d.save());
  };
  const s = await setup(t, MODES[0], await make());
  const ins = await s.propose({ afterRef: 's0/p0', text: '맨 앞 새 문단' });
  const move = await s.layout([{ op: 'objects_to_body', at: ['s0/p0', 's0/p1'] }]);
  assert.equal(move.pageLayout.state.v, 2);
  await s.apply(ins.pid);
  assert.deepEqual(s.prop(move.pid).pageLayout.ops[0].at, ['s0/p0', 's0/p2']);   // 넣은 문단 뒤로 밀린 개체 문단을 따라간다
  await s.apply(move.pid);
  const doc = await s.doc();
  const flat = texts(doc).flat();
  assert.ok(flat.includes('맨 앞 새 문단'), JSON.stringify(flat));
  assert.ok(flat.some((x) => x.includes('둘째 쪽 제목')), JSON.stringify(flat));
  assert.ok(doc.sections.flatMap((x) => x.bodyParas).every((p) => !doc.ownObjects(p.ref).some((o) => o.kind === 'shape')), '글상자·선이 남았다');
  assert.equal(doc.tables().length >= 1, true);
  // 옮길 개체가 바뀜(둘째 개체 문단의 글상자 글 'B' → 'C') → objects 지문이 달라진다(반영하면 STALE '옮길 글상자·도형이 바뀌었습니다'), 구역 구성 지문은 그대로
  const ops = [{ op: 'objects_to_body' }];
  const base = await HwpxDoc.load(await make());
  const before = pageLayoutState(base, ops);
  const edited = await HwpxDoc.load(await make());
  const sec = edited.sections[0];
  assert.ok(sec.xml.includes('<hp:t>B</hp:t>'));
  sec.load(sec.xml.replace('<hp:t>B</hp:t>', '<hp:t>C</hp:t>'));
  const after = pageLayoutState(edited, ops);
  assert.equal(after.parts, before.parts);
  assert.notEqual(after.objects, before.objects);
  // 개체 문단 앞에 문단만 들어가면 같은 지문(주소 없이 구역·차례로 잰다)
  const shifted = await HwpxDoc.load(await make());
  shifted.insertParagraphAfter(0, 0, '맨 앞 새 문단', {});
  assert.deepEqual(pageLayoutState(shifted, ops), before);
});

test('개체 → 본문 지문: 앞에 문단이 들어와 주소만 밀린 것은 같은 지문, 옮길 개체가 바뀌면 다른 지문 · 대기 ops 주소 옮기기 규칙', async () => {
  const doc = await HwpxDoc.load(await threeSections());
  // 개체 없는 문서: objects 는 '옮길 개체 없음' 지문 하나로 같다 — 문단을 넣어도 parts·objects 그대로, sizes 는 주소를 바꾸는 op 뒤에 주소가 있을 때만
  const ops = [{ op: 'objects_to_body', at: ['s1/p1', 's1/p2'], remove_rest: [{ kinds: ['shape'], at: ['s1/p2'] }] }, { op: 'paper', section: 0, margins: { left: 22 } }];
  const a = pageLayoutState(doc, ops);
  assert.equal(a.sizes, undefined);
  doc.insertParagraphAfter(1, 0, '앞에 넣은 문단', {});
  const b = pageLayoutState(doc, ops);
  assert.deepEqual([b.parts, b.objects], [a.parts, a.objects]);
  // 옮기기: 앞 op 의 주소만, 목록에서 지워진 주소는 뺀다(목록이 비면 lost), 문자열 주소가 지워지면 lost
  const shift = (r) => { const m = /^s(\d+)\/p(\d+)$/.exec(r); return m[1] === '1' && Number(m[2]) >= 1 ? `s1/p${Number(m[2]) + 1}` : r; };
  const moved = remapLayoutOps(ops, shift);
  assert.deepEqual([moved.changed, moved.lost], [true, false]);
  assert.deepEqual(moved.ops[0], { op: 'objects_to_body', at: ['s1/p2', 's1/p3'], remove_rest: [{ kinds: ['shape'], at: ['s1/p3'] }] });
  assert.equal(ops[0].at[0], 's1/p1');   // 원래 ops 는 그대로(새 배열)
  const gone = remapLayoutOps(ops, (r) => (r === 's1/p2' ? null : r));
  assert.deepEqual([gone.lost, gone.ops[0].at], [true, ['s1/p1']]);   // remove_rest.at 이 비었다 → lost
  assert.equal(remapLayoutOps([{ op: 'split_section', before_ref: 's0/p2' }], () => null).lost, true);
  assert.equal(remapLayoutOps([{ op: 'objects_to_body', drop: ['s0/p1:L3', 's0/p2:L1'] }], (r) => (r === 's0/p1' ? 's0/p4' : r)).ops[0].drop[0], 's0/p4:L3');
  // 합치기 뒤의 op 주소는 옮기지 않는다(앞 op 를 한 뒤의 주소)
  const trailing = [{ op: 'merge_section', section: 0 }, { op: 'split_section', before_ref: 's0/p5' }];
  assert.equal(remapLayoutOps(trailing, () => 's0/p9').changed, false);
  assert.equal(typeof pageLayoutState(doc, trailing).sizes, 'string');
  // 머리말 글에 주소처럼 생긴 글이 있어도 건드리지 않는다
  assert.equal(remapLayoutOps([{ op: 'header', section: 0, text: 's0/p1' }], () => null).lost, false);
});

test('EDIT_WORKFLOW_OFF: 보통 요청에는 그만두라 하지 않고 보통 도구로 계속하라고, 실험 방식 요청에는 예전 그대로', () => {
  const plain = editWorkflowOffError({ rid: 1, options: {} });
  assert.equal(plain.code, 'EDIT_WORKFLOW_OFF');
  assert.doesNotMatch(plain.message, /그만두세요/);
  assert.match(plain.message, /꺼져 있습니다/);
  assert.match(plain.message, /계속 처리하세요/);
  assert.match(plain.message, /propose_changes/);
  assert.equal(editWorkflowOffError(null).code, 'EDIT_WORKFLOW_OFF');
  const staged = editWorkflowOffError({ rid: 2, options: { workflow: 'content_format' } });
  assert.equal(staged.code, 'EDIT_WORKFLOW_OFF');
  assert.equal(staged.message, '내용·형식 나눠 처리(실험)는 이 서버에서 쓰지 않습니다 — 이 요청은 그만두세요');
});
