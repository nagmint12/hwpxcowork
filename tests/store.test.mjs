// 기록 목록 자르기(docs/V4_SPEC.md §2.6 — server/store.js trimVersions): 최근 기록(마지막 30개 — 10분 안이면 200개까지) + 옛 기록 중
// 사람용 버전·기록 1·묶음(하루 안 10분·7일 안 1시간·그 밖 하루)마다 마지막 기록(400개까지)
import test from 'node:test';
import assert from 'node:assert/strict';
import { trimVersions, checkpointSpan, VERSIONS_MAX, RECENT_MIN, RECENT_MS, CHECKPOINT_MS, HOUR_MS, DAY_MS, CHECKPOINTS_MAX } from '../server/store.js';

const T0 = Date.parse('2026-10-23T00:00:00.000Z');
/** n 1..count, at = T0 + step(n)ms, v 는 vs 의 기록에 */
function makeMeta(count, step, vs = {}) {
  const versions = [];
  for (let n = 1; n <= count; n++) versions.push({ n, at: new Date(T0 + step(n)).toISOString(), by: '홍길동', note: '실시간 편집', ...(vs[n] ? { v: vs[n] } : {}) });
  return { versions };
}

const lastAt = (m) => Date.parse(m.versions.at(-1).at);

test('정책 숫자: 최근 30개(10분 안이면 200개까지) · 옛 묶음 기록 400개까지 · 묶음 크기는 나이에 따라', () => {
  assert.deepEqual([RECENT_MIN, VERSIONS_MAX, RECENT_MS, CHECKPOINTS_MAX], [30, 200, 10 * 60000, 400]);
  assert.deepEqual([checkpointSpan(0), checkpointSpan(DAY_MS - 1), checkpointSpan(DAY_MS), checkpointSpan(7 * DAY_MS - 1), checkpointSpan(7 * DAY_MS)], [CHECKPOINT_MS, CHECKPOINT_MS, HOUR_MS, HOUR_MS, DAY_MS]);
});

test(`trimVersions: ${RECENT_MIN}개 이하면 그대로(시각과 상관없이)`, () => {
  const m = makeMeta(RECENT_MIN, (n) => n * DAY_MS);
  trimVersions(m, lastAt(m) + 30 * DAY_MS);
  assert.equal(m.versions.length, RECENT_MIN);
});

test('trimVersions: 지난 10분 안의 기록은 200개까지 그대로(여럿이 한창 고칠 때 — 끊긴 창의 기준 기록) + 기록 1·이정표', () => {
  const m = makeMeta(260, (n) => n * 100, { 1: 1, 30: 2 });
  trimVersions(m, lastAt(m));
  assert.deepEqual(m.versions.slice(0, 2).map((x) => x.n), [1, 30]);
  assert.equal(m.versions.length, 202);
  assert.equal(m.versions[2].n, 61);   // 최근 200개의 맨 앞
  // 10분 안이라도 200개를 넘으면 자른다(예전 상한 그대로)
  const b = makeMeta(500, (n) => n * 100);
  trimVersions(b, lastAt(b));
  assert.equal(b.versions.length, 1 + VERSIONS_MAX);
});

test('trimVersions: 한동안 쉬었다 다시 저장하면 최근 30개 + 기록 1·이정표 + 묶음 끝 기록만(같은 10분 묶음이면 묶음 기록 없음)', () => {
  const m = makeMeta(260, (n) => n * 100, { 1: 1, 30: 2 });   // 26초 동안 260개(같은 10분 묶음)
  trimVersions(m, lastAt(m) + HOUR_MS);
  assert.deepEqual(m.versions.map((x) => x.n), [1, 30, ...Array.from({ length: RECENT_MIN }, (_, i) => 231 + i)]);
  // 10분 안 기록이 30개보다 적으면 30개(10분 넘은 것도) — 그 앞은 묶음 끝만
  const s = makeMeta(100, (n) => n * 60000);   // 1분마다
  trimVersions(s, lastAt(s));
  const tail = s.versions.slice(-RECENT_MIN);
  assert.equal(tail[0].n, 100 - RECENT_MIN + 1);
  assert.ok(s.versions.length < 100 - RECENT_MIN + 1 && s.versions.length > RECENT_MIN + 5, `${s.versions.length}개`);
});

test('trimVersions: 하루 안의 옛 기록은 10분 묶음마다 마지막 것만 남김(되짚을 자리) · 다시 잘라도 같다', () => {
  // 기록 1000개, 1분마다 하나(약 17시간) → 최근 30개 뒤 옛 기록 970개는 10분 묶음마다 하나씩
  const m = makeMeta(1000, (n) => n * 60000);
  const now = lastAt(m);
  trimVersions(m, now);
  const recent = m.versions.slice(-RECENT_MIN); const old = m.versions.slice(0, -RECENT_MIN);
  assert.equal(recent[0].n, 971);
  const buckets = old.filter((x) => x.n !== 1).map((x) => Math.floor(Date.parse(x.at) / CHECKPOINT_MS));
  assert.equal(new Set(buckets).size, buckets.length, '묶음마다 하나(기록 1 은 따로 — 언제나 남김)');
  assert.ok(old.every((x, i) => x.n === 1 || i === old.length - 1 || Math.floor(Date.parse(old[i + 1].at) / CHECKPOINT_MS) !== Math.floor(Date.parse(x.at) / CHECKPOINT_MS)));
  assert.ok(old.length >= 96 && old.length <= 99, `옛 기록 ${old.length}개`);
  const before = JSON.stringify(m.versions);
  trimVersions(m, now);
  assert.equal(JSON.stringify(m.versions), before);
});

test('trimVersions: 나이에 따라 묶음이 커진다 — 하루 안 10분, 7일 안 1시간, 그보다 오래되면 하루', () => {
  // 10분마다 하나씩 10일(1440개 + 1) — 묶음마다 하나라면 하루 안 ≈144, 1~7일 ≈144, 7일 넘음 ≈3
  const m = makeMeta(1441, (n) => n * CHECKPOINT_MS);
  const now = lastAt(m);
  trimVersions(m, now);
  const old = m.versions.slice(0, -RECENT_MIN).filter((x) => x.n !== 1);
  const age = (x) => now - Date.parse(x.at);
  const inDay = old.filter((x) => age(x) < DAY_MS); const inWeek = old.filter((x) => age(x) >= DAY_MS && age(x) < 7 * DAY_MS); const older = old.filter((x) => age(x) >= 7 * DAY_MS);
  assert.ok(inDay.length >= 110 && inDay.length <= 144, `하루 안 ${inDay.length}`);
  assert.ok(inWeek.length >= 140 && inWeek.length <= 146, `1~7일 ${inWeek.length}`);
  assert.ok(older.length >= 2 && older.length <= 4, `7일 넘음 ${older.length}`);
  // 남긴 옛 기록은 모두 제 묶음(제 나이의 크기)의 마지막
  const all = m.versions;
  for (let i = 0; i < all.length - RECENT_MIN; i++) {
    const x = all[i]; if (x.n === 1) continue;
    const span = checkpointSpan(age(x));
    assert.notEqual(Math.floor(Date.parse(x.at) / span), Math.floor(Date.parse(all[i + 1].at) / span), `n=${x.n}`);
  }
  // 하루 뒤 다시 자르면 하루 지난 10분 묶음 기록이 1시간 묶음으로 줄어든다(이정표가 아니면)
  const n0 = m.versions.length;
  trimVersions(m, now + DAY_MS);
  assert.ok(m.versions.length < n0 - 100, `${n0} → ${m.versions.length}`);
});

test(`trimVersions: 묶음 기록은 ${CHECKPOINTS_MAX}개까지(오래된 것부터 버림, 사람용 버전·기록 1 은 언제나)`, () => {
  const count = RECENT_MIN + CHECKPOINTS_MAX + 50;
  const m = makeMeta(count, (n) => n * DAY_MS, { 5: 1 });   // 기록마다 다른 날 → 옛 기록은 모두 묶음 기록 후보
  trimVersions(m, lastAt(m));
  const old = m.versions.slice(0, -RECENT_MIN);
  const loose = old.filter((x) => x.v == null && x.n !== 1);
  assert.equal(loose.length, CHECKPOINTS_MAX);
  assert.ok(old.some((x) => x.n === 1) && old.some((x) => x.n === 5 && x.v === 1));
  assert.equal(loose[0].n, count - RECENT_MIN - CHECKPOINTS_MAX + 1);
});
