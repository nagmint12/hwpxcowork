import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HwpxDoc } from '../engine/doc.js';
import { buildTutorialSteps } from '../web/tutorial-steps.js';
import { requestControl } from '../web/tutorial-targets.js';
import { connectGuide } from '../web/tutorial-connect.js';
import { previewText } from '../scripts/build-tutorial-refresh.mjs';

const environment = () => ({ d: {}, s: { paragraphs: [], requests: [], proposals: [], memos: [] }, ctx: {}, clipboard: { seq: 0 }, config: { publicUrl: 'https://document.example' }, focusIn() {}, rectOf() {}, pad() {}, q() {}, fdoc() {}, inFrame() {}, frameRect() {}, selectFor() {}, locate() {}, phraseRect() {}, cw() {} });

test('심화는 5작업 — 작업마다 [보내기]·[모두 반영] 두 단계, 누를 곳은 초록 테두리(press)', () => {
  const env = environment(); env.ctx.ridS1 = 41;
  env.s.requests.push({ rid: 41, status: 'done', proposals: [81] });
  env.s.proposals.push({ pid: 81, rid: 41, status: 'pending' });
  const steps = buildTutorialSteps('ai-advanced', env);
  assert.deepEqual(steps.slice(1, -1).map(s => s.title.replace(/^\d+\. /, '')), ['그림 만들기 — AI에게 요청', '그림 만들기 — 결과 반영', '그림 바꾸기 — AI에게 요청', '그림 바꾸기 — 결과 반영',
    '표 서식과 오탈자 — AI에게 요청', '표 서식과 오탈자 — 결과 반영', '문서 교정 — AI에게 요청', '문서 교정 — 결과 반영', '결론 쓰기 — AI에게 요청', '결론 쓰기 — 결과 반영']);
  assert.equal(steps.length, 12);
  const gate = steps[2];
  assert.equal(gate.press, '모두 반영'); assert.equal(steps[1].press, '보내기');
  assert.equal(gate.until(), false, 'AI 완료만으로 다음 작업으로 넘어가지 않는다');
  assert.equal(gate.reviewWait(), true, '반영이 끝나기 전에는 확인 창을 띄우지 않는다');
  assert.match(gate.text(), /모두 반영/);
  env.s.proposals.push({ pid: 82, rid: 41, status: 'pending' });
  env.s.proposals[0].status = 'applied'; assert.equal(gate.reviewWait(), true, '반영이 이어지는 중');
  env.ctx.appliedAtS1 -= 3500; assert.equal(gate.reviewWait(), false, '하나가 남아도 3초 동안 그대로면 확인 창을 띄운다');
  assert.match(gate.text(), /남은 제안 1건/);
  env.s.proposals.pop(); assert.equal(gate.until(), true); assert.equal(gate.reviewWait(), false);
  env.s.proposals[0].status = 'rejected'; assert.equal(gate.until(), true);
  assert.ok(!steps.some(s => /연결 확인/.test(s.title)), '개인 AI 연결 단계 없음');
});

test('심화 반영 초점은 현재 요청의 일괄 반영 단추에만 맞춘다', () => {
  const button = { getBoundingClientRect: () => ({ width: 110, height: 28 }) };
  let selector;
  const doc = { querySelectorAll(value) { selector = value; return [button]; } };
  assert.equal(requestControl(doc, 41), button);
  assert.match(selector, /\.result\[data-rid="41"\].*\.req-actions\[data-rid="41"\].*ra-adopt/);
  assert.equal(requestControl(doc, '41]'), null);
});

test('사용자 실습별로 독립된 안내와 완료 저장 단계를 제공한다', () => {
  for (const id of ['overview', 'clipboard', 'ai-requests', 'ai-connect']) {
    const steps = buildTutorialSteps(id, environment());
    assert.ok(steps.length >= 8, `${id}: 내용을 단계별로 안내`);
    assert.equal(steps[0].next, '시작하기');
    assert.equal(steps.at(-1).last, true);
    assert.equal(steps.at(-1).next, '완료하고 문서함에 저장');
    assert.ok(steps.every(s => s.title && s.text && (s.next || s.until || s.click)), `${id}: 막힌 단계 없음`);
  }
});

test('AI 연결은 내 PC의 Codex·Claude Code 먼저 — 고른 연결의 안내로 가고, 붙여넣을 내용은 지금 서버 주소의 복사 상자다', () => {
  const env = environment(); const steps = buildTutorialSteps('ai-connect', env);
  const titles = steps.map(step => step.title);
  const first = titles.indexOf('내 개인 토큰 저장'); const chatgpt = titles.indexOf('ChatGPT 웹 — 앱 추가'); const api = titles.indexOf('내 AI 키 — 사용료 별도');
  assert.ok(first > 0 && first < chatgpt && chatgpt < api, '먼저 Codex·Claude Code, 다음 ChatGPT 웹(고급), 끝에 API 키(유료)');
  for (const title of ['VS Code에 MCP 서버 등록', 'Codex — 요청 바로 처리', 'Claude Code — 요청 바로 처리', '연결 확인과 사용']) {
    assert.ok(titles.indexOf(title) > first && titles.indexOf(title) < chatgpt, `${title}: 내 PC의 AI 묶음 안`);
  }
  const choice = steps.find(step => step.title === '어떤 AI를 연결할까요');
  for (const [value, title] of [['agent', '내 개인 토큰 저장'], ['chatgpt', 'ChatGPT 웹 — 앱 추가'], ['api', '내 AI 키 — 사용료 별도']]) {
    env.ctx.connectionChoice = value;
    assert.equal(steps[choice.action.run()].title, title);
  }
  assert.equal(steps.find(step => step.title === '연결 확인과 사용').nextTo, steps.at(-1).title, 'Codex·Claude Code만 연결하면 선택 연결 없이 마친다');
  assert.ok(!steps.some(step => /^\d+\.\s/.test(step.title)), '제목에 메뉴 번호를 넣지 않는다');
  const guide = connectGuide('https://document.example/mcp');
  const blocks = guide.flatMap(step => step.blocks || []);
  assert.ok(blocks.length >= 6 && blocks.every(block => /붙여넣을 내용/.test(block.label)), '복사 상자는 어디에 붙여 넣는지 적는다');
  const vscode = guide.find(step => step.id === 'vscode').blocks;
  assert.equal(vscode[0].value, '[mcp_servers.hwpx]\nurl = "https://document.example/mcp?agent=Codex"\nbearer_token_env_var = "HWPX_COWORK_TOKEN"');
  assert.deepEqual(JSON.parse(vscode[1].value).mcpServers.hwpx, { type: 'http', url: 'https://document.example/mcp?agent=Claude%20Code', headers: { Authorization: 'Bearer ${HWPX_COWORK_TOKEN}' } });
  assert.match(guide.find(step => step.id === 'codex').blocks.at(-1).value, /start-codex-agent\.bat --url 'https:\/\/document\.example\/mcp'/);
  assert.match(guide.find(step => step.id === 'claude').text, /start-agent\.bat/);
  assert.match(guide.find(step => step.id === 'claude').blocks.at(-1).value, /npm\.cmd run worker -- --provider claude-code --check\nnpm\.cmd run worker -- --provider claude-code$/);
  assert.match(guide.find(step => step.id === 'claude').blocks[1].value, /start-claude-worker\.bat --url 'https:\/\/document\.example\/mcp'/);
  assert.match(guide.find(step => step.id === 'claude').text, /MCP 연결은 실행기가 준비/);
  assert.match(guide.find(step => step.id === 'api').text, /사용료가 따로/);
  assert.ok(!blocks.some(block => /Bearer (?!\$\{HWPX_COWORK_TOKEN\})|sk-|--trust/.test(block.value)), '복사 상자에 실제 토큰·키나 확인 생략 옵션을 넣지 않는다');
});

test('복사 실습은 자동 선택·단추 대리 클릭 없이 실제 선택과 새 복사 데이터를 확인한다', () => {
  const env = environment();
  env.cw = () => { throw new Error('복사 영역을 자동 선택하면 안 된다'); };
  const steps = buildTutorialSteps('clipboard', env);
  const select = steps.find(s => s.title === '복사할 내용을 직접 선택하기');
  const copy = steps.find(s => s.title === '선택한 내용을 실제로 복사하기');
  assert.equal(select.action, undefined); assert.equal(copy.action, undefined);
  env.s.selection = { collapsed: true, text: '영역 시작 ... 영역 끝' }; assert.equal(select.until(), false);
  env.s.selection = { collapsed: false, text: '일부 글만' }; assert.equal(select.until(), false);
  env.s.selection.text = '영역 시작 ... 영역 끝'; assert.equal(select.until(), true);
  copy.enter();
  Object.assign(env.clipboard, { seq: 1, type: 'copy', text: '영역 시작 ... 영역 끝', tables: 0, images: 1 }); assert.equal(copy.until(), false);
  env.clipboard.tables = 1; assert.equal(copy.until(), true);
  copy.enter(); assert.equal(copy.until(), false, '이전 복사 이벤트로 새 연습을 통과시키지 않는다');
});

test('휴대폰 복사 실습은 도구 막대 안내 후 자동 선택 없이 한/글 붙여넣기 그림으로 이어진다', () => {
  const steps = buildTutorialSteps('clipboard', { ...environment(), touch: true });
  assert.equal(steps[1].title, '편집 도구 막대 켜기');
  const select = steps.find(s => s.title === '복사할 내용을 직접 선택하기');
  assert.equal(select.action, undefined);
  assert.equal(select.next, '붙여넣기 흐름 보기');
  assert.equal(steps[steps.findIndex(s => s.title === select.nextTo)].scene, 'hangul-paste');
  assert.ok(!buildTutorialSteps('clipboard', environment()).some(s => s.title === '편집 도구 막대 켜기'), 'PC 는 그대로');
});

test('AI 검토의 반영·거절은 실제 제안 단추를 가리키고 되돌리기만 안내 동작으로 실행한다', async () => {
  const env = environment(); const calls = [];
  env.s.requests = [{ rid: 1, example: true, status: 'done' }];
  env.s.proposals = [{ pid: 11, rid: 1, status: 'pending' }, { pid: 12, rid: 1, status: 'pending' }];
  env.d.applyProposal = async p => { p.status = 'applied'; calls.push(['apply', p.pid]); };
  env.d.rejectProposal = async p => { p.status = 'rejected'; calls.push(['reject', p.pid]); };
  env.d.undoProposal = async p => { p.status = 'pending'; calls.push(['undo', p.pid]); };
  env.d.createRequest = () => { throw new Error('예시 검토에서는 외부 AI 작업을 보내면 안 됨'); };
  const steps = buildTutorialSteps('ai-requests', env);
  const apply = steps.find(s => s.title === '제안 하나 반영하기'); const reject = steps.find(s => s.title === '마음에 들지 않는 제안 거절');
  assert.equal(apply.action, undefined); assert.equal(reject.action, undefined);
  assert.equal(typeof apply.click, 'function'); assert.equal(typeof reject.click, 'function');
  assert.equal(apply.until(), false); env.s.proposals[0].status = 'applied'; assert.equal(apply.until(), true);
  assert.equal(reject.until(), false); env.s.proposals[1].status = 'rejected'; assert.equal(reject.until(), true);
  const undo = steps.find(s => s.action?.label === '첫 제안 반영 되돌리기'); await undo.action.run(); assert.equal(undo.until(), true);
  assert.deepEqual(calls, [['undo', 11]]);
});

test('실제 AI 요청은 예시 제목 대신 문단 본문 전체를 선택한다', async () => {
  const env = environment(); const text = '2025년 10월 참여 대상 500명 중 420명이 응답했다. 응답률은 84%다.';
  env.s.paragraphs = [{ ref: 's1/p2/n1', text: '4장의 ‘예시 문단 A’. [하나씩 보기]로 원문·수정문을 비교하세요.' }, { ref: 's1/p10', text: `예시 문단 A — ${text}` }];
  let chosen; let opened;
  env.selectFor = async phrase => { chosen = phrase; return { ref: 's1/p10', text: phrase, start: 11, end: 11 + phrase.length }; };
  env.d.openComposer = (target, kind, options) => { opened = { target, kind, options }; };
  const step = buildTutorialSteps('ai-requests', env).find(s => s.title === '글을 골라 요청 준비하기');
  await step.action.run(); assert.equal(chosen, text); assert.equal(opened.target.text, text); assert.ok(opened.options.instruction.includes('문단 전체'));
});

test('모양 열기를 건너뛴 확인 단계도 예시를 선택하며, 이동 후 지연된 창은 열지 않는다', async () => {
  const env = environment(); const selected = []; const clicked = [];
  env.selectFor = async text => { selected.push(text); return { ref: 's1/p1', text }; };
  env.fdoc = () => ({ querySelectorAll: () => [], querySelector: selector => ({ click: () => clicked.push(selector) }) });
  const steps = buildTutorialSteps('clipboard', env);
  await steps.find(s => s.title === '글자 모양 값 확인').action.run();
  assert.deepEqual(selected, ['장평 50%']);
  assert.deepEqual(clicked, ['button[data-cmd="format:char-shape"]']);
  env.isCurrentStep = () => false;
  await steps.find(s => s.title === '문단 모양 값 확인').action.run();
  assert.equal(clicked.length, 1, '다른 단계로 이동한 뒤 창을 열지 않는다');
});

test('연결 안내의 실제 화면과 일반 예시 PNG 4종은 출처와 크기가 맞고 모두 배포 대상에 있다', () => {
  const manifest=JSON.parse(fs.readFileSync(new URL('../web/tutorial-assets/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.images.length,4);
  for(const image of manifest.images) {
    const data=fs.readFileSync(new URL(`../web/tutorial-assets/${image.file}`,import.meta.url));
    assert.equal(data.toString('hex',0,8),'89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16),image.width); assert.equal(data.readUInt32BE(20),image.height);
    if (image.kind === 'illustration') assert.equal(image.source, 'scripts/build-api-guide-assets.py');
    else assert.match(image.source, /^https:\/\/chatgpt\.com\//);
    assert.ok(data.length>2000,'빈 예시 그림을 사용하지 않는다');
  }
});

test('사용자 연결 HWPX는 Codex·Claude Code 먼저, ChatGPT 웹(고급)·API 키(유료)는 뒤 — 실제 화면·일반 API 예시와 본문 미리보기 글', async () => {
  const bytes=fs.readFileSync(new URL('../tutorial/AI 연결 — 사용자 가이드.hwpx',import.meta.url));
  assert.equal(bytes.readUInt16LE(8),0,'mimetype는 무압축');
  const doc=await HwpxDoc.load(bytes);
  const text=doc.paragraphs({nested:true}).map(p=>p.text).join('\n');
  for(const expected of ['사용자 가이드','Codex','Claude Code','config.toml','.mcp.json','bearer_token_env_var','start-codex-agent.bat','start-claude-worker.bat','start-agent.bat','claude auth login','npm.cmd run worker -- --provider claude-code','ChatGPT','Create as a plugin','API 키 생성','내 AI 키','제공업체마다','사용료','2026-11-13']) assert.ok(text.includes(expected),expected);
  assert.ok(!text.includes('관리자 앱에서 서버'));
  const order = ['1. 내 PC의 구독 AI · 기본 · 추가 비용 없음', '2. ChatGPT 앱 연결 · 선택', '3. 내 AI 키 · 선택 · 사용료 별도'].map(head => doc.paragraphs().findIndex(p => p.text === head));
  assert.ok(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], `장 차례: ${order}`);
  assert.ok(!/^\d+\.\s*(튜토리얼|내 AI 연결)/m.test(text), '표지·제목에 메뉴 번호를 넣지 않는다');
  const preview = Buffer.from(doc.container.files.get('Preview/PrvText.txt')).toString('utf8');
  assert.equal(preview, previewText(doc), '미리보기 글은 이 문서 본문');
  const assets = JSON.parse(fs.readFileSync(new URL('../web/tutorial-assets/manifest.json', import.meta.url), 'utf8'));
  const binaries = [...doc.container.files].filter(([name]) => name.startsWith('BinData/')).map(([, bytes]) => Buffer.from(bytes));
  for (const asset of assets.images) {
    const png = fs.readFileSync(new URL(`../web/tutorial-assets/${asset.file}`, import.meta.url));
    assert.ok(binaries.some(bytes => bytes.equals(png)), `한/글 저장으로 번호가 바뀌어도 원본 화면 ${asset.file}을 보존`);
  }
});

test('안내 첫 제목·연습 문서 표지·설명서 본문에 메뉴 번호를 넣지 않는다 — 메뉴 번호는 /api/tutorial 이 순서대로 매긴다', async () => {
  for (const id of ['report', 'overview', 'clipboard', 'ai-requests', 'ai-connect', 'ai-advanced']) {
    assert.doesNotMatch(buildTutorialSteps(id, environment())[0].title, /^\d+\.\s/, id);
  }
  for (const name of ['AI 연결 — 사용자 가이드.hwpx', 'AI 활용 심화 — 연습 보고서.hwpx', '결과보고서.hwpx']) {
    const doc = await HwpxDoc.load(fs.readFileSync(new URL(`../tutorial/${name}`, import.meta.url)));
    const paras = doc.paragraphs();
    assert.doesNotMatch(paras.find(p => String(p.text).trim()).text.trim(), /^\d+\.\s/, `${name} 표지`);
    assert.ok(!paras.some(p => /^\d+\.\s*튜토리얼|\d+번 (튜토리얼|심화)/.test(p.text)), `${name} 본문`);
    // 미리보기 글은 그 문서의 글로만(템플릿·다른 보고서의 글이 남지 않게) — 줄마다 이 문서의 문단 글이다
    const texts = new Set(doc.paragraphs({ nested: true }).map(p => String(p.text).replace(/\s*\n\s*/g, ' ').replace(/\t+/g, ' ').trim()));
    const lines = Buffer.from(doc.container.files.get('Preview/PrvText.txt')).toString('utf8').split('\r\n');
    assert.ok(lines.length > 3 && lines.every(line => texts.has(line.trim())), `${name} 미리보기 글: ${lines.find(line => !texts.has(line.trim()))}`);
  }
  // 설명서 파일 이름의 00~04 는 파일 차례일 뿐이다 — 본문은 다른 설명서를 번호('01 따라하기')가 아니라 튜토리얼 이름으로 가리킨다
  for (const name of fs.readdirSync(new URL('../docs/manuals/', import.meta.url)).filter(n => n.endsWith('.hwpx'))) {
    const doc = await HwpxDoc.load(fs.readFileSync(new URL(`../docs/manuals/${name}`, import.meta.url)));
    const text = doc.paragraphs({ nested: true }).map(p => p.text).join('\n');
    assert.doesNotMatch(text, /[‘「]0\d\s|^0[0-4]$/m, name);
  }
});
