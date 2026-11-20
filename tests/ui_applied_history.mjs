// 브라우저 고유 동작의 회귀. ego-browser에서 만든 새 테스트 Page 핸들을 넘긴다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { APPLIED_COUNT, LAST_OLD, LAST_NEW, PENDING_TEXT, UNDONE_TEXT } from './helpers/applied-history.mjs';

const HISTORY = '.hist-applied';
const SUMMARY = `${HISTORY} > summary`;
const SEARCH = `${HISTORY} input[type=search]`;
const PREVIOUS = `${HISTORY} nav button:first-of-type`;
const NEXT = `${HISTORY} nav button:last-of-type`;
const row = (pid) => `${HISTORY} article[data-pid="${pid}"]`;
const normalized = (s) => s.trim().replace(/\s+/gu, ' ');

/** 실제 클릭에 따른 편집기 좌표·반환을 본다. 기존 호출은 그대로 실행한다. */
async function observeEditor(page) {
  await page.evaluate(() => {
    const editor = window.__doc.editor;
    const focus = editor.focusRange.bind(editor);
    window.appliedHistoryFocusCalls = [];
    editor.focusRange = async (args) => {
      const ok = await focus(args);
      window.appliedHistoryFocusCalls.push({ args, ok });
      return ok;
    };
  });
}

async function jump(page, pid, target) {
  const before = await page.evaluate(() => window.appliedHistoryFocusCalls.length);
  await page.click(`${row(pid)} .hist-jump`, { label: '변경한 본문 위치로 이동' });
  await page.waitForFunction((n) => window.appliedHistoryFocusCalls.length > n, before, { timeout: 10000 });
  const call = await page.evaluate(() => window.appliedHistoryFocusCalls.at(-1));
  assert.deepEqual(call.args, { ...target, flash: true });
  assert.equal(call.ok, true, '실제 편집기 이동이 성공한다');
  return call.args;
}

async function rowData(page, pid) {
  return page.evaluate((selector) => {
    const article = document.querySelector(selector);
    if (!article) return null;
    const diff = [...article.querySelectorAll('dd')].map((part) => part.textContent.trim());
    const del = article.querySelector('del'), ins = article.querySelector('ins');
    return { diff, position: article.querySelector('.hist-jump')?.textContent.trim(),
      del: del ? { color: getComputedStyle(del).color, decoration: getComputedStyle(del).textDecorationLine } : null,
      ins: ins ? { color: getComputedStyle(ins).color, decoration: getComputedStyle(ins).textDecorationLine } : null };
  }, row(pid));
}

/** test helper를 일반 Node로 먼저 띄우고 ego-browser에서 이 함수를 호출한다. */
export async function verifyAppliedHistoryUi({ page, infoPath }) {
  const trial = JSON.parse(await fs.readFile(infoPath, 'utf8'));
  assert.ok([trial.base, trial.control].every((url) => /^http:\/\/127\.0\.0\.1:\d+$/.test(url)));
  const control = async (endpoint, method = 'GET') => {
    const response = await fetch(trial.control + endpoint, { method, headers: { Authorization: `Bearer ${trial.key}` }, redirect: 'error' });
    assert.ok(response.ok, `시험 상태 조회 ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const { snapshot: before } = await control('/state');
  async function openAs(user) {
    await page.goto(`${trial.base}/?teaser=0`);
    await page.evaluate((token) => {
      localStorage.setItem('hwpx.token', token);
      localStorage.setItem('hwpx.view', 'detail');
    }, user.token);
    await page.goto(`${trial.base}/?teaser=0&history-test=1#/doc/${trial.id}`);
    await page.waitForFunction((id) => window.__doc?.id === id && window.__doc.s.loaded && (window.__doc.editor?.ready || window.__doc.editor?.error), trial.id, { timeout: 45000 });
    assert.equal(await page.evaluate(() => !!window.__doc.editor.ready), true, '읽기 편집기는 실제로 준비된다');
  }
  const state = () => page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    return { open: panel.open, title: panel.querySelector('summary').textContent, status: panel.querySelector('[role=status]')?.textContent,
      page: panel.querySelector('nav span')?.textContent, pids: [...panel.querySelectorAll('article')].map((item) => Number(item.dataset.pid)),
      overflow: panel.scrollWidth - panel.clientWidth, buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean) };
  }, HISTORY);
  try {
    await openAs(trial.viewer);
    const outline = await page.snapshot();
    assert.ok(outline.includes('합성 반영 이력'));
    assert.equal(await page.evaluate(() => window.__doc.s.canEdit), false);
    await page.click('[data-testid=version-pill]', { label: '문서 버전에서 이력 열기' });
    await page.waitForSelector(SUMMARY, { state: 'visible', timeout: 20000 });
    let ui = await state();
    assert.equal(ui.open, false);
    assert.match(normalized(ui.title), /^AI 반영 내역 159건$/u);
    assert.deepEqual(ui.pids, []);

    await page.click(SUMMARY, { label: 'AI 반영 내역 펼치기' });
    await page.waitForSelector(SEARCH, { state: 'visible', timeout: 10000 });
    ui = await state();
    assert.deepEqual([ui.open, ui.page, ui.status, ui.pids.length, ui.pids[0]], [true, '1 / 8', '1–20 / 159건', 20, 1]);
    assert.ok(ui.overflow <= 1, '패널 안 내용으로 가로 스크롤이 생기지 않는다');
    assert.ok(ui.buttons.every((text) => !/^(거절|되돌리기|반영\s*\(|적용|저장)/u.test(text)), '반영 내역에 변경 버튼 없음');
    const initial = await rowData(page, 1);
    assert.deepEqual(initial.diff, ['원래 문단 001', '수정된 문단 001']);
    assert.match(initial.position, /문단.*바뀐 글로/u);
    assert.notEqual(initial.del.color, initial.ins.color, '반영 전후 색이 구분된다');
    assert.equal(initial.del.decoration, 'line-through');
    await observeEditor(page);
    const emojiFocus = await jump(page, 1, { ref: trial.firstRef, start: 2, end: 12 });

    for (let n = 2; n <= 8; n++) {
      await page.click(NEXT, { label: '다음 반영 내역 보기' });
      await page.waitForFunction((pageNo) => document.querySelector('.hist-applied nav span')?.textContent === `${pageNo} / 8`, n, { timeout: 10000 });
    }
    ui = await state();
    assert.deepEqual([ui.page, ui.status, ui.pids.length, ui.pids.at(-1)], ['8 / 8', '141–159 / 159건', 19, APPLIED_COUNT]);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).disabled, NEXT), true);
    const table = await rowData(page, 159);
    assert.deepEqual(table.diff, [LAST_OLD, LAST_NEW]);
    assert.match(table.position, /표 1행 4열.*바뀐 글로/u);
    const tableFocus = await jump(page, 159, { ref: trial.lastRef, start: 0, end: Array.from(LAST_NEW).length });
    const deleted = await rowData(page, 158);
    assert.deepEqual(deleted.diff, ['원래 문단 158', '(삭제됨)']);
    assert.match(deleted.position, /삭제 자리로/u);
    const deletionFocus = await jump(page, 158, { ref: trial.deletedRef, start: 5, end: 5 });
    const stale = await rowData(page, 157);
    assert.deepEqual(stale.diff, ['원래 문단 157', '수정된 문단 157']);
    assert.match(stale.position, /문단으로/u);
    const staleFocus = await jump(page, 157, { ref: trial.staleRef });
    await page.click(PREVIOUS, { label: '이전 반영 내역 보기' });
    await page.waitForFunction(() => document.querySelector('.hist-applied nav span')?.textContent === '7 / 8', undefined, { timeout: 10000 });

    await page.fill(SEARCH, LAST_NEW);
    await page.waitForSelector(row(159), { state: 'visible', timeout: 10000 });
    assert.deepEqual((await state()).pids, [159]);
    for (const absent of ['없는 단서', PENDING_TEXT, UNDONE_TEXT]) {
      await page.fill(SEARCH, absent);
      await page.waitForFunction(() => document.querySelector('.hist-applied [role=status]')?.textContent.includes('검색 결과가 없습니다'), undefined, { timeout: 10000 });
      assert.deepEqual((await state()).pids, []);
    }
    await page.fill(SEARCH, '');
    await page.waitForSelector(row(1), { state: 'visible', timeout: 10000 });
    assert.deepEqual([(await state()).pids.length, (await state()).page], [20, '1 / 8']);
    await page.click(SUMMARY, { label: 'AI 반영 내역 다시 접기' });
    await page.waitForSelector(SEARCH, { state: 'hidden', timeout: 10000 });
    assert.equal((await state()).open, false);

    await page.click('[role=tab][data-tab=ai]', { label: '기존 AI 작업 탭 열기' });
    await page.waitForSelector(`.tab-ai .req[data-rid="${trial.requestId}"]`, { state: 'visible', timeout: 10000 });
    await page.click(`.tab-ai .req[data-rid="${trial.requestId}"] button:text-is("결과")`, { label: '기존 AI 작업 결과 열기' });
    await page.waitForSelector('.result-card .rs-accepted .rs-b-more', { state: 'visible', timeout: 10000 });
    const existingCounts = await page.evaluate(() => document.querySelector('.result-card .rs-accepted > .rs-sec-h')?.textContent);
    assert.match(normalized(existingCounts), /반영한 제안 1항목 · 개별 반영 159건/u);
    await page.click('.result-card .rs-accepted .rs-b-more', { label: '기존 제안 묶음 펼치기' });
    await page.waitForSelector('.result-card .rs-accepted .rs-b-list', { state: 'visible', timeout: 10000 });
    const bundle = await page.evaluate(() => {
      const list = document.querySelector('.result-card .rs-accepted .rs-b-list');
      return { count: list.children.length, last: list.lastElementChild.textContent };
    });
    assert.equal(bundle.count, APPLIED_COUNT);
    assert.ok(bundle.last.includes(LAST_NEW));

    const { requests: requestLog, snapshot: after } = await control('/state');
    assert.equal(requestLog.filter((req) => /^\/mcp(?:\/|$)/.test(req.path)).length, 0);
    assert.deepEqual(requestLog.filter((req) => /^(POST|PATCH|PUT|DELETE)$/.test(req.method) && req.path.startsWith(`/api/docs/${trial.id}`)), []);
    assert.deepEqual(after, before, '브라우저 확인 뒤 본문·판·제안·요청이 모두 그대로');
    assert.ok(trial.assets.every((asset) => requestLog.some((request) => request.path === asset)), '후보 모듈 4개가 브라우저에 로드됐다');
    return { total: APPLIED_COUNT, pageSize: 20, pages: 8, readerCanEdit: false, privateDocumentProtected: true,
      candidateAssets: trial.assets.length, oldBundleMembers: bundle.count, documentMutations: 0, mcpCalls: 0, version: before.version,
      focus: { emoji: emojiFocus, table: tableFocus, deletion: deletionFocus, stale: staleFocus }, colors: { before: initial.del.color, after: initial.ins.color } };
  } finally { await control('/stop', 'POST'); }
}
