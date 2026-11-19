import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/intro.js', import.meta.url), 'utf8');
function visit(href, values = new Map(), blocked = false) {
  let redirected;
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(source, { URL, Date, document, window: { location: { href, replace(value) { redirected = value; } } }, localStorage: {
    getItem(key) { if (blocked) throw new Error('blocked'); return values.get(key) || null; },
    setItem(key, value) { if (blocked) throw new Error('blocked'); values.set(key, value); },
  } });
  return { redirected, dataset: document.documentElement.dataset, values };
}

test('새 브라우저는 같은 주소·IP라도 각각 티저부터 시작하고 원래 경로·토큰 링크를 보존한다', () => {
  for (const suffix of ['', '?mode=user#/t/demo-token/doc/demo-doc']) {
    const href = `https://example.test/${suffix}`;
    const a = visit(href); const incognito = visit(href);
    for (const result of [a, incognito]) {
      const target = new URL(result.redirected, href);
      assert.equal(target.pathname, '/teaser/');
      assert.equal(target.searchParams.get('intro'), '1');
      assert.equal(target.searchParams.get('next'), `/${suffix}`);
      assert.equal(result.dataset.introRedirect, '1', '티저로 이동 중에는 앱을 시작하지 않는다');
    }
    assert.equal(visit(href, a.values).redirected, undefined, '같은 브라우저의 재방문은 영상을 반복하지 않는다');
  }
});

test('저장소 차단에도 티저를 보이며 돌아올 때 무한 이동하지 않는다', () => {
  const first = visit('https://example.test/#/tutorial', new Map(), true);
  const next = new URL(first.redirected, 'https://example.test').searchParams.get('next');
  assert.equal(next, '/?teaser=0#/tutorial');
  assert.equal(visit(`https://example.test${next}`, new Map(), true).redirected, undefined);
});

test('기존 로그인 토큰과 명시적 영상 생략은 바로 앱을 열고 자동화 여부로는 생략하지 않는다', () => {
  assert.equal(visit('https://example.test/', new Map([['hwpx.token', 'fake-token']])).redirected, undefined);
  assert.equal(visit('https://example.test/?teaser=0').redirected, undefined);
  assert.ok(visit('https://example.test/').redirected);
  assert.ok(!source.includes('webdriver'));
});

function playIntro(folder, search) {
  const html = fs.readFileSync(new URL(`../web/${folder}/index.html`, import.meta.url), 'utf8');
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/import \{ mount \} from '\.\/player\.js';/, '');
  const redirects = []; const timers = []; const events = {};
  let options;
  vm.runInNewContext(script, {
    URL, URLSearchParams, console, performance: { now: () => 0 },
    location: { origin: 'https://example.test', search, replace: url => redirects.push(url) },
    window: { self: 1, top: 1 },
    document: { getElementById: () => ({}), querySelector: () => ({ addEventListener: (type, fn) => { events[type] = fn; } }) },
    addEventListener: (type, fn) => { events[type] = fn; },
    setTimeout: fn => timers.push(fn),
    mount: (_, opts) => { options = opts; return Promise.resolve(); },
  });
  return { options, redirects, timers, events };
}

test('첫 소개는 teaser → teaser3 → 맞춤 시작 안내 순서이고 원래 토큰 링크를 보존한다(2026-11-17)', () => {
  const next = '/?mode=user#/t/demo-token/doc/demo-doc';
  const first = playIntro('teaser', `?intro=1&next=${encodeURIComponent(next)}`);
  assert.equal(first.options.loop, false);
  first.options.onEnd(); first.timers.shift()();
  const second = new URL(first.redirects[0], 'https://example.test');
  assert.equal(second.pathname, '/teaser3/');
  assert.equal(second.searchParams.get('intro'), '1');
  assert.equal(second.searchParams.get('next'), next);
  const after = playIntro('teaser3', second.search);
  assert.equal(after.options.loop, false);
  after.options.onEnd(); after.timers.shift()();
  const following = new URL(after.redirects[0], 'https://example.test');
  assert.equal(following.pathname, '/onboarding.html');
  assert.equal(following.searchParams.get('next'), next);
});

test('다시 보기도 teaser 부터 열고 teaser3 를 이어 튼다', () => {
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const href = app.match(/href="([^"]+)" data-testid="intro-replay"/)[1];
  const replay = new URL(href, 'https://example.test');
  assert.equal(replay.pathname, '/teaser/');
  const first = playIntro('teaser', replay.search);
  first.options.onEnd(); first.timers.shift()();
  const following = new URL(first.redirects[0], replay.origin);
  assert.equal(following.pathname, '/teaser3/');
  assert.equal(following.searchParams.get('next'), '/?teaser=0');
});

test('튜토리얼에서 소개 영상 두 편을 보거나 건너뛰면 설치 안내를 거치지 않고 실습 목록으로 간다', () => {
  const first = playIntro('teaser', '?intro=1&return=tutorial');
  first.options.onEnd(); first.timers.shift()();
  const second = new URL(first.redirects[0], 'https://example.test');
  assert.equal(second.pathname, '/teaser3/');
  assert.equal(second.searchParams.get('return'), 'tutorial');
  const after = playIntro('teaser3', second.search);
  after.options.onEnd(); after.timers.shift()();
  assert.deepEqual(after.redirects, ['/?teaser=0&welcome=tutorial']);
  const skipped = playIntro('teaser', '?intro=1&return=tutorial');
  skipped.events.click({ stopPropagation() {} });
  assert.deepEqual(skipped.redirects, after.redirects);
});

test('단독으로 열면 teaser → teaser3 → teaser 로 번갈아 되풀이하고(주소 옵션 유지·시작 시각은 뺀다), ?loop=0 이면 끝에서 멈춘다', () => {
  const a = playIntro('teaser', '?controls=0&t=7.5');
  assert.equal(a.options.loop, false);
  a.options.onEnd(); a.timers.shift()();
  assert.deepEqual(a.redirects, ['/teaser3/?controls=0']);
  const b = playIntro('teaser3', '?controls=0');
  b.options.onEnd(); b.timers.shift()();
  assert.deepEqual(b.redirects, ['/teaser/?controls=0']);
  for (const folder of ['teaser', 'teaser3']) {
    const still = playIntro(folder, '?loop=0');
    assert.equal(still.options.onEnd, undefined, `${folder}: 끝에서 멈춤`);
    assert.equal(still.options.loop, undefined, '재생기의 주소 옵션(loop=0)을 그대로 따른다');
  }
});

test('이전 티저 방문기록은 그대로 존중하며 새 방문기록 키를 쓴다', () => {
  assert.equal(visit('https://example.test/', new Map([['hwpx-cowork.teaser3Seen', 'old']])).redirected, undefined);
  const first = visit('https://example.test/');
  assert.ok(first.values.has('hwpx-cowork.teaserSeen'));
});

test('teaser 건너뛰기와 불러오기 실패도 시작 안내로 이어진다', () => {
  const first = playIntro('teaser', '?intro=1&next=%2F%3Fmode%3Duser%23%2Ft%2Ffake-token');
  first.options.onEnd();
  first.events.click({ stopPropagation() {} });
  first.timers.shift()();
  assert.equal(first.redirects.length, 1);
  const target = new URL(first.redirects[0], 'https://example.test');
  assert.equal(target.pathname, '/onboarding.html');
  assert.equal(target.searchParams.get('next'), '/?mode=user#/t/fake-token');
  for (const unsafe of ['//other.test/', '/\\other.test/', '/\n/other.test/']) {
    const bad = playIntro('teaser', `?intro=1&next=${encodeURIComponent(unsafe)}`);
    bad.events.click({ stopPropagation() {} });
    assert.equal(new URL(bad.redirects[0], 'https://example.test').searchParams.get('next'), '/');
  }
});

test('건너뛰기와 영상 종료가 겹쳐도 다시 이동하지 않고, teaser3 의 건너뛰기도 시작 안내로 간다', () => {
  const first = playIntro('teaser3', '?intro=1&next=%2F%3Fteaser%3D0');
  first.options.onEnd();
  first.events.click({ stopPropagation() {} });
  first.timers.shift()();
  assert.deepEqual(first.redirects, ['/onboarding.html?next=%2F%3Fteaser%3D0']);
  const unsafe = playIntro('teaser3', '?intro=1&next=https://other.test/');
  unsafe.events.click({ stopPropagation() {} });
  assert.deepEqual(unsafe.redirects, ['/onboarding.html?next=%2F']);
});
