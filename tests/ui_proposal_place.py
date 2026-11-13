# 화면 시험(제안 카드의 자리 — 2026-11-10): 같은 문단 뒤에 문단을 차례로 넣는 제안을 [모두 반영]한 뒤 카드가 실제로 넣은 문단을 가리키는가.
#   실제 문서에서: 문서 끝 문단 뒤에 31개를 넣은 제안의 카드가 모두 기준 문단 주소(s0/p655)를 보여 줬고, 눌러도 넣은 자리가 아니라 그 문단으로 갔다.
#   1) 반영 전: 카드 셋 모두 같은 기준 문단 주소 + '이 문단 뒤에 새 문단'
#   2) [모두 반영] 뒤: 카드마다 넣은 문단 주소(차례로 하나씩 큼) + '넣은 문단', 주소에 마우스를 올리면 '위에서 n번째 문단 「글 머리」'
#   3) 주소를 누르면 편집기가 그 문단으로 간다(못 찾았다는 알림이 없다 — 편집기에 그 주소의 문단이 있다)
#   4) 되돌리면 다시 기준 문단 주소
#   python -I tests/ui_proposal_place.py   → 스크린숏 tests/out/proposal_place_*.png, 서버 기록 tests/out/proposal_place_server.log
# 브라우저가 필요한 까닭(AGENTS.md §2.1 예외): Vue 템플릿이 그리는 카드 글·누르기·편집기 이동은 엔진 계산값으로 볼 수 없다.
# 서버는 포트 8774(UI_PLACE_PORT)에 임시 data 폴더 + 임시 config + AI 끔(진짜 config.json·data/ 는 읽지도 쓰지도 않음). 모델을 부르지 않는다 —
# AI 가 할 도구 호출을 이 시험이 HTTP MCP 로 대신 보낸다.
import json, os, secrets, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_PLACE_PORT', '8774'))
BASE = f'http://localhost:{PORT}'
REST = f'http://127.0.0.1:{PORT}'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/tests/fixtures/tool_memo_tracked.hwpx'
A = {'name': '홍길동', 'role': 'admin', 'token': secrets.token_hex(16)}
SESSION = 'ui_place_agent'
TEXTS = ['덧붙인 문단 하나', '덧붙인 문단 둘', '덧붙인 문단 셋']
RESULTS = []


def ok(cond, msg):
    RESULTS.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)
    if not cond:
        raise AssertionError(msg)


def rest(path, method='GET', body=None, headers=None, raw=False):
    h = {'Authorization': f'Bearer {A["token"]}'}
    h.update(headers or {})
    data = body if raw else (json.dumps(body).encode('utf-8') if body is not None else None)
    if body is not None and not raw:
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(REST + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        b = r.read()
        return json.loads(b) if 'json' in (r.headers.get('content-type') or '') else b


def mcp(name, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}).encode('utf-8')
    h = {'Authorization': f'Bearer {A["token"]}', 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
         'X-Hwpx-Agent-Session': SESSION, 'X-Hwpx-Lean': '1'}
    req = urllib.request.Request(f'{REST}/mcp?agent={urllib.parse.quote("Claude Code")}', data=body, method='POST', headers=h)
    raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
    line = next((l for l in raw.splitlines() if l.startswith('data:')), None)
    out = json.loads(line[5:] if line else raw)
    if 'error' in out or out.get('result', {}).get('isError'):
        raise RuntimeError(f'MCP {name} 실패: {json.dumps(out, ensure_ascii=False)[:300]}')
    return out


def wait_until(fn, timeout=15, step=0.15, msg='조건'):
    t0 = time.time(); last = None
    while time.time() - t0 < timeout:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(step)
    raise AssertionError(f'{msg} — {timeout}초 안에 되지 않음(마지막: {last})')


def start_server(tmp):
    with socket.socket() as s:
        if s.connect_ex(('127.0.0.1', PORT)) == 0:
            raise RuntimeError(f'포트 {PORT} 를 이미 다른 프로세스가 쓰고 있습니다')
    data = os.path.join(tmp, 'data'); os.makedirs(data, exist_ok=True)
    cfg = {'host': '127.0.0.1', 'port': PORT, 'dataDir': './data', 'tutorial': {'enabled': False}, 'users': [A],
           'ai': {'enabled': False, 'mock': False, 'keyFile': os.path.join(tmp, 'no-such-key.txt'), 'model': 'claude-opus-5-5'},
           'studio': {'mode': 'local'}, 'agents': {'leaseMinutes': 15}}
    cfg_path = os.path.join(tmp, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=cfg_path, HWPX_COWORK_DATA_DIR=data, HWPX_COWORK_AI='off', HWPX_COWORK_PORT=str(PORT), HWPX_COWORK_HOST='127.0.0.1')
    log = open(f'{OUT}/proposal_place_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError(f'서버가 시작하다 끝났습니다(code {srv.returncode}) — tests/out/proposal_place_server.log')
        try:
            if json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read()).get('nonce') and rest('/api/me')['name'] == A['name']:
                return srv
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    srv.kill()
    raise RuntimeError('서버가 뜨지 않았습니다')


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx-ui-place-')
    srv = start_server(tmp)
    errors = []
    try:
        with open(FIX, 'rb') as f:
            doc = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('자리.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)
        did = doc['id']
        body = [p for p in rest(f'/api/docs/{did}/paragraphs') if p['ref'].count('/') == 1]
        last = body[-1]['ref']; n = int(last.split('/p')[1])
        rq = rest(f'/api/docs/{did}/requests', 'POST', {'kind': 'instruct', 'instruction': '끝에 요약을 덧붙여 줘', 'route': 'queue', 'target': {'scope': 'document'}})['request']
        rid = rq['rid']; ids = {'doc_id': did, 'request_id': rid, 'expected_attempt': 1}
        mcp('start_request', ids)
        mcp('propose_insert', {**ids, 'after_ref': last, 'paragraphs': [{'text': t} for t in TEXTS], 'complete': '끝에 문단 셋을 덧붙였습니다.'})
        pids = [p['pid'] for p in rest(f'/api/docs/{did}/proposals') if p.get('rid') == rid]
        ok(len(pids) == 3, f'넣기 제안 셋({pids})')
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)
            ctx = br.new_context(viewport={'width': 1480, 'height': 920}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(A['token'])}); localStorage.setItem('hwpx.view', 'detail'); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console: {m.text[:200]}') if m.type == 'error' and 'Vue' in m.text else None)
            pg.goto(f'{BASE}/#/doc/{did}')
            pg.wait_for_selector('.tabs button[data-tab="ai"]', timeout=60000)
            wait_until(lambda: pg.evaluate('() => !!(window.__doc && window.__doc.editor && window.__doc.editor.ready)'), timeout=90, msg='편집기 준비')
            pg.evaluate(f"() => {{ const s = window.__doc.s; s.tab = 'ai'; s.activeRid = {rid}; }}")
            card = pg.locator('.tab-ai .result-card')
            prop = lambda pid, sec='': card.locator(f'{sec} .prop[data-pid="{pid}"]')   # noqa: E731

            print('[1] 반영 전: 셋 모두 같은 기준 문단 주소 · 이 문단 뒤에 새 문단', flush=True)
            wait_until(lambda: card.locator('.rs-open .prop').count() == 3, timeout=20, msg='남은 제안 3건')
            for pid in pids:
                ok(prop(pid).locator('.ref').inner_text().strip() == last, f'#{pid} 주소 = 기준 문단 {last}')
                ok(prop(pid).locator('.muted').first.inner_text().strip() == '이 문단 뒤에 새 문단', f'#{pid} 「이 문단 뒤에 새 문단」')
            pg.screenshot(path=f'{OUT}/proposal_place_1_pending.png')

            print('[2] 모두 반영 뒤: 카드마다 넣은 문단 주소 · 넣은 문단', flush=True)
            out = rest(f'/api/docs/{did}/requests/{rid}/resolve', 'POST', {'apply': 'rest'})
            ok(out['counts']['applied'] == 3 and out['counts']['failed'] == 0, '모두 반영 3건')
            wait_until(lambda: card.locator('.rs-accepted .prop').count() == 3, timeout=20, msg='반영한 제안 3건')
            now = {p['ref']: p['text'] for p in rest(f'/api/docs/{did}/paragraphs')}
            for i, pid in enumerate(pids):
                want = f's0/p{n + 1 + i}'
                chip = prop(pid, '.rs-accepted').locator('.ref')
                ok(chip.inner_text().strip() == want, f'#{pid} 주소 = 넣은 문단 {want}(기준 {last} 아님)')
                ok(now.get(want) == TEXTS[i], f'{want} 의 글 = 넣은 글')
                ok(prop(pid, '.rs-accepted').locator('.muted').first.inner_text().strip() == '넣은 문단', f'#{pid} 「넣은 문단」')
                tip = chip.get_attribute('title') or ''
                ok(f'위에서 {n + 2 + i}번째 문단' in tip and TEXTS[i][:6] in tip and '누르면' in tip, f'#{pid} 주소 설명: {tip}')
            ok(card.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), '카드가 옆으로 넘치지 않는다')
            pg.screenshot(path=f'{OUT}/proposal_place_2_applied.png')

            print('[3] 주소를 누르면 편집기가 넣은 문단으로 간다', flush=True)
            third = f's0/p{n + 3}'
            # 편집기가 새 기준(넣은 문단 셋)에 맞춰질 때까지: 그 주소의 문단을 편집기가 찾는다
            wait_until(lambda: pg.evaluate(f"async () => (await window.__doc.editor.focusRange({{ ref: {json.dumps(third)}, flash: false }})) === true"), timeout=40, step=0.5, msg='편집기에 넣은 문단이 있다')
            prop(pids[2], '.rs-accepted').locator('.ref').click()
            pg.wait_for_timeout(900)
            toasts = ' '.join(pg.locator('.toast').all_inner_texts()) if pg.locator('.toast').count() else ''
            ok('찾지 못했습니다' not in toasts, f'못 찾았다는 알림 없음({toasts[:60]})')
            pg.screenshot(path=f'{OUT}/proposal_place_3_jump.png')

            print('[4] 되돌리면 다시 기준 문단 주소', flush=True)
            rest(f'/api/docs/{did}/proposals/{pids[2]}/undo', 'POST')
            # 되돌린 제안은 접힌 '거절 n건' 안으로 간다 — 펼쳐서 본다
            wait_until(lambda: card.locator('.rs-declined summary').count() == 1, timeout=20, msg='거절·되돌림 구역')
            card.locator('.rs-declined summary').click()
            back = card.locator(f'.rs-declined .prop[data-pid="{pids[2]}"]')
            wait_until(lambda: back.locator('.ref').count() == 1 and back.locator('.ref').inner_text().strip() != '', timeout=10, msg='되돌린 카드의 주소')
            # 다시 반영하면 들어갈 자리 = 둘째로 넣은 문단 뒤
            ok(back.locator('.ref').inner_text().strip() == f's0/p{n + 2}', f"되돌린 #{pids[2]} 주소 = 그 뒤에 넣을 문단 s0/p{n + 2}({back.locator('.ref').inner_text().strip()})")
            ok(back.locator('.muted').first.inner_text().strip() == '이 문단 뒤에 새 문단', f"되돌린 #{pids[2]}: 「이 문단 뒤에 새 문단」")
            ok(not errors, f'화면 오류 없음({errors[:2]})')
            br.close()
        print(f'\nUI PROPOSAL PLACE OK — {len(RESULTS)}개 확인', flush=True)
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except Exception:  # noqa: BLE001
            srv.kill()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f'\nUI PROPOSAL PLACE FAIL — {e}', flush=True)
        sys.exit(1)
