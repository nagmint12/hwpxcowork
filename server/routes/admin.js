import { createAdminSettings } from '../admin-settings.js';
import { createAdminAccounts } from '../admin-accounts.js';
import { tutorialConfig } from '../tutorial.js';
import { createAdminTutorialAi } from '../admin-tutorial-ai.js';
import { usageReport } from '../usage-report.js';

/** UI를 숨기는 것과 별개로 모든 관리 경로에 관리자 권한을 검사한다. */
export function installAdminRoutes({ app, config, auth, wrap, restartControl, instanceId = '', adminSettings, adminAccounts, service, personalAi }) {
  const settings = adminSettings || createAdminSettings({ config, restartControl, instanceId });
  const accounts = adminAccounts || createAdminAccounts({ config, serverAiStatus: service?.serverAiStatus ? () => service.serverAiStatus() : null });
  const admin = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'ADMIN_REQUIRED', message: '관리자만 서버 설정을 변경할 수 있습니다.' });
    next();
  };
  app.get('/api/admin/server', auth, admin, wrap(async (req, res) => res.json(settings.snapshot())));
  app.post('/api/admin/stop', auth, admin, wrap(async (req, res) => {
    const ticket = settings.prepareStop(req.body?.revision);
    let finished = false;
    res.once('finish', () => { finished = true; setImmediate(() => ticket.commit()); });
    res.once('close', () => { if (!finished) ticket.cancel(); });
    try { res.status(202).json({ accepted: true, stopId: ticket.stopId }); }
    catch (error) { ticket.cancel(); throw error; }
  }));
  app.patch('/api/admin/server', auth, admin, wrap(async (req, res) => res.json(settings.save(req.body?.settings, req.body?.revision))));
  app.post('/api/admin/restart', auth, admin, wrap(async (req, res) => {
    const ticket = await settings.prepareRestart(req.body?.revision);
    let finished = false;
    const onFinish = () => { finished = true; setImmediate(() => ticket.commit()); };
    const onClose = () => { if (!finished) ticket.cancel?.(); };
    try {
      const response = { ...settings.snapshot(), accepted: true, restartId: ticket.restartId };
      res.once('finish', onFinish);
      res.once('close', onClose);
      res.status(202).json(response);
    } catch (error) {
      res.off('finish', onFinish); res.off('close', onClose);
      ticket.cancel?.(); throw error;
    }
  }));
  // AI 응답 크기 한도(재시작 없이 바로 적용)
  app.get('/api/admin/limits', auth, admin, wrap(async (req, res) => res.json(accounts.limits())));
  app.patch('/api/admin/limits', auth, admin, wrap(async (req, res) => res.json(accounts.saveLimits(req.body?.limits, req.body?.revision))));
  // 사용자 관리(재시작 없이 바로 적용 — 토큰은 만들 때·새로 발급할 때 한 번만 응답에 실린다)
  const name = (req) => String(req.params.name ?? '');
  app.get('/api/admin/users', auth, admin, wrap(async (req, res) => res.json(accounts.users(undefined, req.user.name))));
  app.post('/api/admin/users', auth, admin, wrap(async (req, res) => res.json(accounts.addUser(req.body?.user, req.body?.revision, req.user.name))));
  app.put('/api/admin/server-ai-key', auth, admin, wrap(async (req, res) => res.json(accounts.setServerAiKey(req.body?.useKeyOf ?? null, req.body?.revision, req.user.name))));
  app.patch('/api/admin/users/:name', auth, admin, wrap(async (req, res) => res.json(accounts.updateUser(name(req), req.body?.user, req.body?.revision, req.user.name))));
  app.post('/api/admin/users/:name/token', auth, admin, wrap(async (req, res) => res.json(accounts.resetToken(name(req), req.body?.revision, req.user.name, req.body?.token))));
  app.delete('/api/admin/users/:name', auth, admin, wrap(async (req, res) => res.json(accounts.deleteUser(name(req), req.body?.revision ?? req.query.revision, req.user.name))));
  // AI 크레딧: 체험에 공유하는 키(tutorial.shareFrom)와 내 키의 API 잔액·이번 달 사용량(조회는 과금 없음)
  app.get('/api/admin/ai-credits', auth, admin, wrap(async (req, res) => res.json(await aiCredits(personalAi || service?.personalAi, config, req.user.name, req.query.refresh === '1'))));
  // AI 사용량: 모든 문서의 요청 기록 토큰 → 예상 API 비용(읽기만 — 화면이 10초마다 다시 읽는다. 같은 순간의 거듭된 조회는 2초 동안 앞의 답을 쓴다)
  let usageHit = null;
  app.get('/api/admin/usage-report', auth, admin, wrap(async (req, res) => {
    if (!usageHit || Date.now() - usageHit.at > 2000) usageHit = { at: Date.now(), value: usageReport(service?.store?.list() || []) };
    res.json(usageHit.value);
  }));
  // 튜토리얼 AI: 체험 요청을 처리할 연결(API·로컬 AI·ChatGPT·Codex·Claude Code — 재시작 없이 바로 적용)
  const tutorialAi = createAdminTutorialAi({ config, service });
  app.get('/api/admin/tutorial-ai', auth, admin, wrap(async (req, res) => res.json(tutorialAi.snapshot())));
  app.put('/api/admin/tutorial-ai', auth, admin, wrap(async (req, res) => res.json(tutorialAi.save(req.body?.provider ?? null, req.body?.revision))));
  return settings;
}

/**
 * → { accounts: [{ balance, apiCredits, otherCredits, keys }], others: [키 없음·조회 실패·API 아닌 키], checkedAt }
 * 월 할당은 계정 단위라 잔액이 같은 키끼리 한 계정으로 묶는다. otherCredits = 이번 달 쓴 양 − 그 계정의 API 키 사용(API 화면 등)
 */
export async function aiCredits(personal, config, me, refresh = false, { ownOnly = false } = {}) {
  // ownOnly: 내 키만(누구나 — 웹 '내 AI 키'의 /api/me/ai/credits). 아니면 체험 공유 키와 내 키(관리자)
  const t = ownOnly ? { ...tutorialConfig(config), shareFrom: [] } : tutorialConfig(config);
  const status = (owner) => { try { return personal?.status({ name: owner }) || { configured: false }; } catch { return { configured: false }; } };
  const owners = [...new Set([...t.shareFrom, me].filter(Boolean))];
  const sharing = t.on ? t.shareFrom.find((owner) => status(owner).configured && status(owner).active) || null : null;
  const keys = await Promise.all(owners.map(async (owner) => {
    const st = status(owner);
    const key = { owner, me: owner === me, shared: t.shareFrom.includes(owner), sharing: owner === sharing, configured: !!st.configured, keyHint: st.keyHint || null, gateway: st.gateway || null, model: st.model || null };
    if (!st.configured) return key;
    try { return { ...key, ...(await personal.credits(owner, { refresh })) }; }
    catch (e) { return { ...key, error: e.message }; }
  }));
  const accounts = [];
  for (const k of keys) {
    if (!k.balance) continue;
    const sig = JSON.stringify(k.balance);
    let a = accounts.find((x) => x.sig === sig);
    if (!a) {
      const api = Math.round(k.usage.account.credits * 100) / 100;
      accounts.push(a = { sig, balance: k.balance, from: k.usage.from, to: k.usage.to, apiCredits: api, otherCredits: Math.max(0, Math.round((k.balance.monthly.used - api) * 100) / 100), keys: [] });
    }
    a.keys.push({ owner: k.owner, keyHint: k.keyHint, model: k.model, me: k.me, shared: k.shared, sharing: k.sharing, usage: { calls: k.usage.key.calls, credits: k.usage.key.credits, days: k.usage.days }, checkedAt: k.checkedAt });
  }
  return { accounts: accounts.map(({ sig, ...a }) => a), others: keys.filter((k) => !k.balance).map(({ owner, me, shared, sharing, configured, keyHint, gateway, error }) => ({ owner, me, shared, sharing, configured, keyHint, gateway, error: error || null })), checkedAt: new Date().toISOString() };
}
