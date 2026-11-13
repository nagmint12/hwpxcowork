# 화면 시험(AI 작업 진행 기록 — 2026-11-10): AI 가 요청을 처리하며 부른 도구가 AI 작업 탭 카드에 실시간으로 한 줄씩 보이는가.
#   1) 요청을 맡으면 카드에 '지금' 한 줄(요청을 맡음)과 [작업 기록 1]이 생긴다(새로 고침 없이 — WebSocket)
#   2) 문서 읽기 → 줄이 바뀌고, 도구를 부르지 않는 동안 '→ 생각 중 n초'가 올라간다
#   3) 의견 3번 → 한 줄로 묶인다(의견 남김 ×3), 앞 단계와 3초 넘게 벌어지면 '+n초'
#   4) 쓰기에 complete → '지금' 줄이 사라지고 [작업 기록 n · 걸린 시간]만 남는다(완료 칩)
#   5) 화면을 다시 열어도 방금 끝난 요청의 기록이 보인다(서버에서 읽음)
#   python -I tests/ui_activity.py   → 스크린숏 tests/out/activity_ui_*.png, 서버 기록 tests/out/activity_ui_server.log
# 서버는 포트 8776(UI_ACTIVITY_PORT)에 임시 data 폴더 + 임시 config + AI 끔(진짜 config.json·data/ 는 읽지도 쓰지도 않음). 모델을 부르지 않는다 —
# AI 가 할 도구 호출을 이 시험이 HTTP MCP 로 대신 보낸다(얇은 흐름 머리글 X-Hwpx-Lean).
import json, os, secrets, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_ACTIVITY_PORT', '8776'))
BASE = f'http://localhost:{PORT}'
REST = f'http://127.0.0.1:{PORT}'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/tests/fixtures/tool_memo_tracked.hwpx'
A = {'name': '홍길동', 'role': 'admin', 'token': secrets.token_hex(16)}
SESSION = 'ui_activity_agent'
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
    """AI 가 할 도구 호출 한 번(얇은 흐름 연결, 같은 에이전트 세션)"""
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
    log = open(f'{OUT}/activity_ui_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError(f'서버가 시작하다 끝났습니다(code {srv.returncode}) — tests/out/activity_ui_server.log')
        try:
            if json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read()).get('nonce') and rest('/api/me')['name'] == A['name']:
                return srv
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    srv.kill()
    raise RuntimeError('서버가 뜨지 않았습니다')


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx-ui-activity-')
    srv = start_server(tmp)
    errors = []
    try:
        with open(FIX, 'rb') as f:
            doc = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('진행기록.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)
        did = doc['id']
        para = next(p for p in rest(f'/api/docs/{did}/paragraphs') if p['ref'] == 's0/p0')
        find = para['text'][:4]
        rq = rest(f'/api/docs/{did}/requests', 'POST', {'kind': 'instruct', 'instruction': '낱말을 다듬어 줘', 'route': 'queue', 'target': {'ref': para['ref']}})['request']
        rid = rq['rid']; ids = {'doc_id': did, 'request_id': rid, 'expected_attempt': 1}
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)
            ctx = br.new_context(viewport={'width': 1480, 'height': 920}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(A['token'])}); localStorage.setItem('hwpx.view', 'detail'); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            # 문서 방 WebSocket 이 붙은 뒤에 도구를 부른다(붙기 전에 보낸 알림은 화면이 받지 못한다 — 실제로는 화면을 열어 둔 채 요청한다)
            frames = []
            pg.on('websocket', lambda ws: ws.on('framereceived', lambda payload: frames.append(str(payload)[:200])))
            ws_ready = lambda: (pg.wait_for_timeout(100), any('"hello"' in f for f in frames))[1]   # noqa: E731 — wait_for_timeout 이 쌓인 알림을 처리한다
            pg.goto(f'{BASE}/#/doc/{did}')
            pg.wait_for_selector('.tabs button[data-tab="ai"]', timeout=60000)
            pg.locator('.tabs button[data-tab="ai"]').click()
            card = pg.locator(f'.tab-ai .card.req[data-rid="{rid}"]')
            card.wait_for(timeout=15000)
            wait_until(ws_ready, timeout=30, msg='문서 방 WebSocket 연결')
            ok(card.locator('.req-activity').count() == 0, '맡기 전: 진행 기록 없음(대기 칩만)')

            print('[1] 요청을 맡으면 지금 줄과 작업 기록이 생긴다', flush=True)
            mcp('start_request', ids)
            wait_until(lambda: card.locator('.req-activity .rq-now-label').count() == 1 and card.locator('.rq-now-label').inner_text().strip() == '요청을 맡음', msg='지금 줄 = 요청을 맡음')
            ok(card.locator('.rq-log summary').inner_text().strip().startswith('작업 기록 1'), '[작업 기록 1]')
            ok(card.locator('.rq-log').get_attribute('open') is not None and card.locator('.rq-chat li').count() == 1, 'AI 작업 탭: 처리 중에는 펼쳐 둔다(한 줄)')

            print('[2] 문서 읽기 → 줄이 바뀌고, 쉬는 동안 생각 중 n초', flush=True)
            mcp('read_document', {'doc_id': did, 'from': 0, 'to': 3})
            wait_until(lambda: card.locator('.rq-now-label').inner_text().strip().startswith('문서 읽기 · 본문 0~'), msg='지금 줄 = 문서 읽기')
            wait_until(lambda: '생각 중' in card.locator('.rq-now-time').inner_text(), timeout=8, msg='생각 중 n초')
            first = card.locator('.rq-now-time').inner_text()
            time.sleep(1.3)
            ok(card.locator('.rq-now-time').inner_text() != first, f"생각 중 시간이 올라간다({first} → {card.locator('.rq-now-time').inner_text()})")
            pg.screenshot(path=f'{OUT}/activity_ui_1_running.png')

            print('[3] 의견 3번 → 한 줄로 묶이고 앞 단계와의 간격(+n초)', flush=True)
            for i in range(3):
                mcp('add_memo', {**ids, 'ref': para['ref'], 'text': f'확인이 필요한 곳 {i + 1}'})
            wait_until(lambda: card.locator('.rq-chat li').count() == 3, msg='세 줄(맡음·읽기·의견 ×3)')
            last = card.locator('.rq-chat li').nth(2)
            ok(last.locator('.rq-l').inner_text().replace(' ', '') == '의견남김×3', f"의견 남김 ×3({last.locator('.rq-l').inner_text()})")
            ok(last.locator('.rq-gap').count() == 1 and last.locator('.rq-gap').inner_text().startswith('+'), f"앞 단계 뒤 간격({last.locator('.rq-gap').inner_text() if last.locator('.rq-gap').count() else '없음'})")
            ok(card.locator('.rq-log summary').inner_text().strip().startswith('작업 기록 5'), '[작업 기록 5](줄은 묶어도 수는 호출 수)')

            print('[4] 쓰기에 complete → 지금 줄이 사라지고 걸린 시간이 남는다', flush=True)
            out = mcp('propose_changes', {**ids, 'proposals': [{'ref': para['ref'], 'find': find, 'replace': find + '!'}], 'complete': '낱말을 다듬었습니다.'})
            ok(json.loads(out['result']['content'][0]['text']).get('completed') is True, 'complete 로 완료')
            wait_until(lambda: card.locator('.rq-now').count() == 0, msg='지금 줄 사라짐')
            summary = card.locator('.rq-log summary').inner_text().strip()
            ok(summary.startswith('작업 기록 6') and '초' in summary, f'[{summary}]')
            ok(card.locator('.rq-chat li').last.locator('.rq-l').inner_text().strip() == '수정 제안 1건 · 완료', '마지막 줄 = 수정 제안 1건 · 완료')
            ok(card.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), '카드가 옆으로 넘치지 않는다')
            pg.screenshot(path=f'{OUT}/activity_ui_2_done.png')

            print('[5] 다시 열어도 방금 끝난 요청의 기록이 보인다', flush=True)
            pg.reload()
            pg.wait_for_selector('.tabs button[data-tab="ai"]', timeout=60000)
            pg.locator('.tabs button[data-tab="ai"]').click()
            card = pg.locator(f'.tab-ai .card.req[data-rid="{rid}"]')
            wait_until(lambda: card.locator('.rq-log summary').count() == 1 and card.locator('.rq-log summary').inner_text().strip().startswith('작업 기록 6'), msg='다시 연 뒤 작업 기록 6')
            ok(card.locator('.rq-log').get_attribute('open') is None, '끝난 요청은 접혀 있다(누르면 펼침)')
            card.locator('.rq-log summary').click()
            ok(card.locator('.rq-chat li').count() == 4, '펼치면 네 줄(맡음 · 읽기 · 의견 ×3 · 수정 제안)')
            ok(not errors, f'화면 오류 없음({errors[:2]})')
            br.close()
        print(f'\nUI ACTIVITY OK — {len(RESULTS)}개 확인', flush=True)
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
        print(f'\nUI ACTIVITY FAIL — {e}', flush=True)
        sys.exit(1)
