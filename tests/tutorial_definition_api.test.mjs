import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { createTutorial } from '../server/tutorial.js';

const read = srv => srv.api('admin')('/api/tutorial/definition');
const save = (srv, definition, revision) => srv.api('admin')('/api/tutorial/definition', { method: 'PUT', body: { definition, revision } });

test('모듈 구성 API는 관리자만 편집하고 수정 충돌을 막으며 재시작 후 보존한다', async () => {
  const srv = await startServer();
  try {
    const file = path.join(srv.dataDir, 'tutorial-definition.json');
    const initial = await read(srv);
    assert.equal(fs.existsSync(file), false, '기본 구성 조회는 파일을 만들지 않는다');
    assert.ok(initial.modules.some(module => module.id === 'editing-commands'));
    assert.ok(initial.sources.some(source => source.id === 'ai-advanced'));
    assert.ok(initial.sources.every(source => !('file' in source) && !('attachments' in source)));
    for (const who of [null, 'a']) {
      const expected = who == null ? 401 : 403;
      assert.equal((await srv.api(who).res('/api/tutorial/definition')).status, expected);
      assert.equal((await srv.api(who).res('/api/tutorial/definition', { method: 'PUT', body: { definition: initial.definition, revision: initial.revision } })).status, expected);
    }
    const next = structuredClone(initial.definition);
    next.entryCourseId = null;
    next.courses = [next.courses.find(course => course.id === 'clipboard'), next.courses.find(course => course.id === 'ai-advanced')];
    next.courses[0].title = '편집 명령만 연습';
    next.courses[0].modules = [{ key: 'commands', moduleId: 'editing-commands' }];
    next.courses[1].enabled = false;
    const updated = await save(srv, next, initial.revision);
    assert.notEqual(updated.revision, initial.revision);
    assert.deepEqual(updated.definition, next);
    assert.equal((await srv.api('admin').res('/api/tutorial/definition', { method: 'PUT', body: { definition: initial.definition, revision: initial.revision } })).status, 409);
    assert.deepEqual((await srv.api('a')('/api/tutorial')).items.map(item => [item.id, item.number]), [['clipboard', 1]]);
    assert.equal((await srv.api('a').res('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'ai-advanced' } })).status, 404);
    await srv.restart();
    assert.deepEqual((await read(srv)).definition, next);
    assert.equal((await read(srv)).revision, updated.revision);
  } finally { await srv.stop(); }
});

test('잘못된 모듈·중복 키·원본 불일치·실행 코드 설정은 저장 전 거절한다', async () => {
  const srv = await startServer();
  try {
    const initial = await read(srv);
    const invalid = [
      definition => { definition.courses[0].modules[0].moduleId = 'missing-module'; },
      definition => { definition.courses[0].modules.push({ ...definition.courses[0].modules[0] }); },
      definition => { definition.courses[0].modules[0].moduleId = 'image-create'; },
      definition => { definition.courses[0].modules[0].script = 'alert(1)'; },
      definition => { definition.courses[0].sourceId = '../../config'; },
      definition => { definition.entryCourseId = 'missing-course'; },
    ];
    for (const mutate of invalid) {
      const definition = structuredClone(initial.definition); mutate(definition);
      const result = await srv.api('admin').res('/api/tutorial/definition', { method: 'PUT', body: { definition, revision: initial.revision } });
      assert.equal(result.status, 400, JSON.stringify(result.data));
      assert.equal((await read(srv)).revision, initial.revision);
    }
    assert.equal(fs.existsSync(path.join(srv.dataDir, 'tutorial-definition.json')), false);
  } finally { await srv.stop(); }
});

test('새 연습은 모듈 구성을 고정하고 기존 연습·진행을 구성 편집 뒤에도 보존한다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const initial = await read(srv);
    const before = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'ai-advanced' } });
    const oldInfo = await A(`/api/docs/${before.docId}`);
    assert.equal(oldInfo.tutorialSourceId, 'ai-advanced');
    const originalCourse = initial.definition.courses.find(course => course.id === 'ai-advanced');
    assert.equal(oldInfo.tutorialTitle, originalCourse.title);
    assert.equal(oldInfo.tutorialDescription, originalCourse.description);
    assert.deepEqual(oldInfo.tutorialModules.map(module => module.moduleId), ['image-create', 'image-replace', 'table-format', 'document-proofread', 'conclusion']);
    await A(`/api/tutorial/${before.docId}/progress`, { method: 'PUT', body: { i: 120, ctx: { test: 'saved' } } });
    const definition = initial.definition;
    const advanced = definition.courses.find(course => course.id === 'ai-advanced');
    advanced.title = '그림 변경만 연습';
    advanced.description = '선택한 그림의 색을 바꾸는 과정입니다.';
    advanced.modules = [{ key: 'first', moduleId: 'guide', title: '시작 전에', text: '그림 변경만 연습합니다.' }, { key: 'replace', moduleId: 'image-replace' }];
    const updated = await save(srv, definition, initial.revision);
    const after = await A('/api/tutorial/start', { method: 'POST', body: { tutorialId: 'ai-advanced' } });
    const newInfo = await A(`/api/docs/${after.docId}`);
    assert.deepEqual(newInfo.tutorialModules, advanced.modules);
    assert.equal(newInfo.tutorialTitle, advanced.title);
    assert.equal(newInfo.tutorialDescription, advanced.description);
    assert.equal(newInfo.tutorialDefinitionRevision, updated.revision);
    assert.deepEqual((await A(`/api/docs/${before.docId}`)).tutorialModules, oldInfo.tutorialModules);
    assert.equal((await A(`/api/docs/${before.docId}`)).tutorialDefinitionRevision, initial.revision);
    assert.equal((await A(`/api/docs/${before.docId}`)).tutorialTitle, oldInfo.tutorialTitle);
    assert.equal((await A(`/api/docs/${before.docId}`)).tutorialDescription, oldInfo.tutorialDescription);
    assert.deepEqual(await A(`/api/tutorial/${before.docId}/progress`), { docId: before.docId, i: 120, ctx: { test: 'saved' } });
    // 구버전 세션은 모듈 snapshot이 없더라도 원래 ID로 열 수 있다.
    const metaFile = path.join(srv.dataDir, 'tutorial-sessions', 'docs', before.docId, 'meta.json');
    const legacy = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    delete legacy.tutorialSourceId; delete legacy.tutorialModules; delete legacy.tutorialDefinitionRevision;
    delete legacy.tutorialTitle; delete legacy.tutorialDescription;
    fs.writeFileSync(metaFile, JSON.stringify(legacy));
    const legacyInfo = await A(`/api/docs/${before.docId}`);
    assert.equal(legacyInfo.tutorialSourceId, 'ai-advanced');
    assert.equal(legacyInfo.tutorialModules, undefined);
    assert.equal(legacyInfo.tutorialTitle, undefined);
    assert.equal(legacyInfo.tutorialDescription, undefined);
  } finally { await srv.stop(); }
});

test('직접 만든 코스 ID도 원본에 맞는 예시와 첫 접속 흐름을 사용한다', async () => {
  const srv = await startServer();
  try {
    const A = srv.api('a');
    const initial = await read(srv);
    const review = { ...initial.definition.courses.find(course => course.id === 'ai-requests'), id: 'review-practice', title: '검토 연습' };
    const definition = { version: 1, entryCourseId: review.id, courses: [review] };
    const updated = await save(srv, definition, initial.revision);
    assert.equal((await A('/api/me')).tutorialIntroRequired, true);
    const started = await A('/api/tutorial/entry', { method: 'POST', body: {} });
    const info = await A(`/api/docs/${started.docId}`);
    assert.equal(info.tutorialId, 'review-practice');
    assert.equal(info.tutorialSourceId, 'ai-requests');
    assert.equal((await A(`/api/docs/${started.docId}/requests`)).length, 4);
    assert.equal((await A(`/api/docs/${started.docId}/proposals`)).length, 3);
    assert.equal((await A('/api/tutorial/entry', { method: 'POST', body: {} })).docId, started.docId);
    const disabled = { ...definition, entryCourseId: null, courses: [{ ...review, enabled: false }] };
    await save(srv, disabled, updated.revision);
    assert.equal((await A('/api/me')).tutorialIntroRequired, false);
    assert.deepEqual(await A('/api/tutorial/entry', { method: 'POST', body: {} }), { skipped: true });
    assert.deepEqual(await A('/api/tutorial/start', { method: 'POST', body: { auto: true } }), { skipped: true });
    assert.deepEqual((await A('/api/tutorial')).items, []);
    assert.equal((await A('/api/tutorial')).sessions[0].docId, started.docId, '코스 제거가 진행 중인 개인 문서를 지우지 않는다');
  } finally { await srv.stop(); }
});

test('원본 문서가 없어도 모든 원본 선택지와 사용 가능 여부를 제공한다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwpx-tutorial-sources-'));
  try {
    const tutorial = createTutorial({ config: { root: tmp, dataDir: tmp }, service: {
      store: { list: () => [], listSessions: () => [] }, tutorialAiStatus: () => ({}),
    } });
    const snapshot = tutorial.definition({ name: '관리자', role: 'admin' });
    assert.deepEqual(snapshot.sources.map(source => source.id), ['report', 'overview', 'clipboard', 'ai-requests', 'ai-connect', 'ai-advanced', 'admin']);
    assert.ok(snapshot.sources.every(source => source.available === false && source.title && !('file' in source) && !('attachments' in source)));
    assert.deepEqual(tutorial.status({ name: '연습자', role: 'editor' }).items, []);
    assert.equal(tutorial.introFor({ name: '연습자', role: 'editor' }), false);
  } finally {
    assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('관리자 참고에 안내를 붙이면 실행 코스가 되고 기존 제목 설정은 처음 구성에 반영된다', async () => {
  const srv = await startServer({ config: { tutorial: { title: '기존 서버 보고서 제목' } } });
  try {
    const initial = await read(srv);
    assert.equal(initial.definition.courses.find(course => course.id === 'report').title, '기존 서버 보고서 제목');
    assert.ok(initial.sources.every(source => source.available === true));
    const definition = initial.definition;
    definition.courses.find(course => course.id === 'report').title = '구성 편집에서 정한 제목';
    definition.courses.find(course => course.id === 'admin').modules.push({ key: 'extra-guide', moduleId: 'guide', title: '확인할 내용', text: '참고 문서를 읽은 뒤 확인하세요.' });
    await save(srv, definition, initial.revision);
    const item = (await srv.api('a')('/api/tutorial')).items.find(course => course.id === 'admin');
    assert.equal(item.guided, true);
    assert.equal(item.reference, false);
    await srv.restart();
    assert.equal((await read(srv)).definition.courses.find(course => course.id === 'report').title, '구성 편집에서 정한 제목');
  } finally { await srv.stop(); }
});
