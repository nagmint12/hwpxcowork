import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEPLOYMENTS, SUBSCRIPTIONS, CLI_AI, setupPlan, safeNext, appDestination, consumeWelcomeIntent } from '../web/onboarding-model.js';
import { parseSetupArgs } from '../scripts/setup-personal.mjs';

test('두 운영 방식과 세 구독의 여섯 조합은 실제 설치 CLI 계약과 일치한다', () => {
  assert.equal(DEPLOYMENTS.length * SUBSCRIPTIONS.length, 6);
  for (const deployment of DEPLOYMENTS) for (const subscription of SUBSCRIPTIONS) {
    const plan = setupPlan(deployment.id, subscription.id);
    const installCli = subscription.id === 'none' ? '' : ' --install-cli';
    assert.equal(plan.command, `.\\scripts\\setup-user.bat --mode ${deployment.id} --ai ${CLI_AI[subscription.id]}${installCli} --start`);
    assert.equal(plan.commandNode, `node scripts/setup-personal.mjs --mode ${deployment.id} --ai ${CLI_AI[subscription.id]}${installCli} --start`);
    assert.ok(plan.prompt.includes(plan.command));
    assert.ok(plan.prompt.includes('app 폴더'));
    assert.match(plan.prompt, /기존 운영 설정과 문서는 건드리지/);
    assert.equal(plan.steps.length, 3);
    assert.ok(!/setx|api.key|publicUrl|https:\/\/localhost/i.test(plan.command));
    assert.equal(plan.needsLogin, subscription.id !== 'none');
    const args = plan.commandNode.split(' ').slice(2);
    const parsed = parseSetupArgs(args);
    assert.equal(parsed.mode, deployment.id);
    assert.equal(parsed.ai, CLI_AI[subscription.id]);
    assert.equal(parsed.installCli, subscription.id !== 'none');
    assert.equal(parsed.start, true);
  }
  assert.throws(() => setupPlan('cloud', 'chatgpt'));
  assert.throws(() => setupPlan('shared', 'api'));
});

test('영상과 시작 안내에서 토큰·쿼리·문서 경로를 보존하고 같은 사이트로 돌아온다', () => {
  const next = '/?mode=user&token=link-token#/t/fake-token/doc/demo-doc';
  assert.equal(safeNext(next), next);
  for (const intent of ['start', 'tutorial']) {
    const url = new URL(appDestination(next, intent), 'https://example.test');
    assert.equal(url.searchParams.get('mode'), 'user');
    assert.equal(url.searchParams.get('token'), 'link-token');
    assert.equal(url.hash, '#/t/fake-token/doc/demo-doc');
    assert.equal(url.searchParams.get('welcome'), intent);
    assert.equal(url.searchParams.get('teaser'), '0');
  }
  for (const bad of ['https://other.test/', '//other.test/', '/\\other.test/', '/\t/other.test/', '/\n/other.test/']) assert.equal(safeNext(bad), '/');
});

test('명시적 시작 선택은 로그인 성공 후 한 번만 소비하고 나머지 주소는 보존한다', () => {
  for (const intent of ['start', 'tutorial']) {
    let replaced;
    const href = `https://example.test/?mode=user&welcome=${intent}#/doc/example`;
    const location = { href };
    const history = { replaceState(_state, _title, path) { replaced = path; location.href = new URL(path, href).href; } };
    assert.equal(consumeWelcomeIntent(location, history), intent);
    assert.equal(replaced, '/?mode=user#/doc/example');
    assert.equal(consumeWelcomeIntent(location, history), null);
  }
});

test('시작 카드 WebP 다섯 개는 원본 SVG와 함께 존재하고 가벼운 정적 이미지다', () => {
  for (const icon of [...DEPLOYMENTS, ...SUBSCRIPTIONS]) {
    const data = fs.readFileSync(new URL(`../web/onboarding-assets/${icon.icon}.webp`, import.meta.url));
    assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    assert.equal(data.toString('ascii', 8, 12), 'WEBP');
    assert.ok(data.length < 20 * 1024);
    assert.ok(fs.existsSync(new URL(`../web/onboarding-assets/${icon.icon}.svg`, import.meta.url)));
  }
});
