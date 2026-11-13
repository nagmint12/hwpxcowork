// 실시간 밀어 넣기(server/live.js)를 한 프로세스 안에서 묶음(LiveEditor.batch)을 켜고·끄고 같은 날짜로 돌려 결과 문서를 견주는 받침
// (tests/live_track_batch.test.mjs). 문서 XML 손질 도우미(본문 문단 빼기·끼우기 — 편집기 내보내기 흉내)도 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HwpxDoc } from '../../engine/doc.js';
import { Service } from '../../server/service.js';
import { Store } from '../../server/store.js';
import { ChangeRequests } from '../../server/crs.js';
import { LiveEditor } from '../../server/live.js';

const USER = { name: '시험 작성자', role: 'admin' };
const FIXED = Date.parse('2026-11-03T00:05:12.000Z');

/** fn 동안 new Date()·Date.now() 를 한 시각으로, Math.random 을 같은 씨앗 수열로(개체 새 id — uniqueNumber) */
async function frozen(fn) {
  const Real = globalThis.Date; const realRandom = Math.random;
  class Fixed extends Real {
    constructor(...a) { if (a.length) super(...a); else super(FIXED); }
    static now() { return FIXED; }
  }
  let seed = 0x2f6b9e1;
  globalThis.Date = Fixed;
  Math.random = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 0x100000000; };
  try { return await fn(); } finally { globalThis.Date = Real; Math.random = realRandom; }
}

/** 임시 저장소 + 서비스 + LiveEditor. base 를 올리고 실시간 track 방식으로 → { live, service, id, tmp, close } */
export async function liveFixture(baseBytes, { track = 'tracked', batch = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-live-batch-'));
  const config = { dataDir: path.join(tmp, 'data'), configFile: path.join(tmp, 'config.json'), ai: {}, documents: {} };
  const store = new Store(path.join(tmp, 'store'));
  const hub = { broadcast() {}, broadcastAll() {} };
  const service = new Service({ store, hub, config, ai: { enabled: false } });
  const crs = new ChangeRequests({ service, store, hub, config });
  service.crs = crs;
  const live = new LiveEditor({ service, crs });
  live.batch = batch;
  const id = store.create({ fileName: 'batch.hwpx', bytes: baseBytes, by: USER.name }).id;
  await service.patchSettings(id, { editMode: 'realtime', track }, USER);
  return { live, service, store, id, close: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** 밀어 넣기들(heads — 차례로, 매번 지금 판을 기준으로)을 batch 켬·끔으로 돌린 결과 { on, off } = { xml: [구역들], header, res: [응답], ms } */
export async function compareBatch(baseBytes, heads, { track = 'tracked' } = {}) {
  const out = {};
  for (const batch of [false, true]) {
    const f = await liveFixture(baseBytes, { track, batch });
    try {
      const res = []; const t0 = performance.now();
      await frozen(async () => {
        for (const head of heads) {
          const meta = f.service._meta(f.id);
          res.push(await f.live.push(f.id, head, { base: meta.version, seq: 1000 + res.length + 1, user: USER }));
        }
      });
      const ms = performance.now() - t0;
      const doc = await f.store.doc(f.id);
      out[batch ? 'on' : 'off'] = { xml: doc.sections.map((s) => s.xml), header: doc.header.xml, res, ms, bytes: await doc.save() };
    } finally { f.close(); }
  }
  return out;
}

/** 본문 문단 [from, to] 를 뺀 문서(구역 si) — 편집기에서 그 문단들을 잘라 낸 내보내기 흉내 */
export async function withoutParagraphs(bytes, from, to, si = 0) {
  const doc = await HwpxDoc.load(bytes);
  const sec = doc.sections[si]; const P = sec.bodyParas;
  sec.load(sec.xml.slice(0, P[from].start) + sec.xml.slice(P[to].end));
  return Buffer.from(await doc.save());
}

/** 본문 문단 [from, to] 의 XML 을 본문 문단 at 앞에 한 벌 더 넣은 문서 — 붙여넣기 흉내 */
export async function withCopiedParagraphs(bytes, from, to, at, si = 0) {
  const doc = await HwpxDoc.load(bytes);
  const sec = doc.sections[si]; const P = sec.bodyParas;
  const pos = at >= P.length ? P[P.length - 1].end : P[at].start;
  sec.load(sec.xml.slice(0, pos) + sec.xml.slice(P[from].start, P[to].end) + sec.xml.slice(pos));
  return Buffer.from(await doc.save());
}

export const bodyCount = async (bytes, si = 0) => (await HwpxDoc.load(bytes)).sections[si].bodyParas.length;
