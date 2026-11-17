# 화면 시험(같은 자리 넣기 제안을 내 수정본에 하나씩 반영한 차례 — 2026-11-17 docs/MCP_REDESIGN_2026-11-16.md §10.4 나-3).
#   비실시간(승인 방식) 문서에서 같은 요청·같은 기준 문단 뒤 넣기 제안 #1·#2·#3 을 [반영](store.adoptProposal → 플러그인 insertParagraphAfter)으로
#   하나씩 넣으면 예전에는 매번 기준 문단 바로 뒤에 들어가 3·2·1 로 쌓였다. 플러그인 0.4.1('insertSkip')은 store 가 넘긴 앞 차례 형제의 글(skip)로
#   이미 넣은 내 초안 문단 너머에 넣는다.
#   [1] 1·2·3 차례로 반영 → 1·2·3   [2] 3·1·2 차례로 반영 → 1·2·3   [3] 1·2 반영 → 사람이 #1 초안을 고침 → 3 반영 → 1'·2·3
#   [4] 2 하나 반영 → [모두 반영](applyBatch — 나머지 1·3) → 1·2·3
#   옛 편집기 빌드(플러그인에 'insertSkip' 없음 — 11-17 build:studio 전 운영 studio/dist 0.4.0)면 store 가 예전 길(skip 없음)로 가는지만 본다: [1]이 예전처럼 3·2·1, 오류 없음.
#   HWPX_COWORK_STUDIO_DIR=<분리 빌드 studio-dist> python -I tests/ui_insert_order.py   (없으면 studio/dist)
# 브라우저가 필요한 까닭(AGENTS.md §2.1 예외): 편집기 플러그인(iframe 안 rhwp-studio)에 문단을 넣는 동작과 store·플러그인 사이 인자는 엔진 계산값으로 볼 수 없다.
# 서버는 포트 8771(UI_INSERT_ORDER_PORT)에 임시 data 폴더 + 임시 config + AI 끔(진짜 config.json·data/ 는 읽지도 쓰지도 않음). 모델을 부르지 않는다 —
# AI 가 할 도구 호출을 이 시험이 HTTP MCP 로 대신 보낸다.
import json, os, secrets, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_INSERT_ORDER_PORT', '8771'))
BASE = f'http://localhost:{PORT}'
REST = f'http://127.0.0.1:{PORT}'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/tests/fixtures/tool_memo_tracked.hwpx'
A = {'name': '홍길동', 'role': 'admin', 'token': secrets.token_hex(16)}
SESSION = 'ui_insert_order_agent'
TEXTS = ['넣기 차례 첫째 문단', '넣기 차례 둘째 문단', '넣기 차례 셋째 문단']
FRAME_JS = "document.querySelector('.editorhost iframe')"
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
           'studio': {'mode': 'local'}, 'agents': {'leaseMinutes': 15},
           # 비실시간(승인 방식) 문서 — '내 수정본에 반영'(편집기 insertParagraphAfter) 길
           'documents': {'defaultEditMode': 'review'}}
    cfg_path = os.path.join(tmp, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=cfg_path, HWPX_COWORK_DATA_DIR=data, HWPX_COWORK_AI='off', HWPX_COWORK_PORT=str(PORT), HWPX_COWORK_HOST='127.0.0.1')
    # 견줄 편집기 번들(분리 빌드)만 넘긴다
    if os.environ.get('HWPX_COWORK_STUDIO_DIR'):
        env['HWPX_COWORK_STUDIO_DIR'] = os.path.abspath(os.environ['HWPX_COWORK_STUDIO_DIR'])
    print(f'편집기 번들: {env.get("HWPX_COWORK_STUDIO_DIR", "studio/dist")}', flush=True)
    log = open(f'{OUT}/insert_order_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError(f'서버가 시작하다 끝났습니다(code {srv.returncode}) — tests/out/insert_order_server.log')
        try:
            if json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read()).get('nonce') and rest('/api/me')['name'] == A['name']:
                return srv
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    srv.kill()
    raise RuntimeError('서버가 뜨지 않았습니다')


def new_doc(name):
    """시험 문서 하나 + 같은 기준 문단 뒤 넣기 제안 셋(한 요청) → (did, 기준 문단 글, [pid…] pid 순, rid)"""
    with open(FIX, 'rb') as f:
        doc = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote(f'{name}.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)
    did = doc['id']
    body = [p for p in rest(f'/api/docs/{did}/paragraphs') if p['ref'].count('/') == 1]
    # 뒤에 기준 문단이 더 있는 글 문단(넣은 문단 뒤에 기준 문단이 오는지까지 본다)
    k = next(i for i, p in enumerate(body[:-1]) if p['text'].strip() and body[i + 1]['text'].strip())
    after = body[k]['ref']
    rq = rest(f'/api/docs/{did}/requests', 'POST', {'kind': 'instruct', 'instruction': '이 문단 뒤에 문단 셋을 넣어 줘(시험)', 'route': 'queue',
                                                    'target': {'ref': after, 'start': 0, 'end': len(body[k]['text']), 'text': body[k]['text']}})['request']
    rid = rq['rid']; ids = {'doc_id': did, 'request_id': rid, 'expected_attempt': 1}
    mcp('start_request', ids)
    mcp('propose_insert', {**ids, 'after_ref': after, 'paragraphs': [{'text': t} for t in TEXTS], 'complete': '문단 셋을 넣었습니다(시험).'})
    pids = sorted(p['pid'] for p in rest(f'/api/docs/{did}/proposals') if p.get('rid') == rid)
    ok(len(pids) == 3, f'넣기 제안 셋({pids}) — 기준 {after}')
    return did, body[k]['text'], body[k + 1]['text'], pids, rid


def cw(pg, expr, arg=None):
    return pg.evaluate(f'async (arg) => {{ const cw = {FRAME_JS}.contentWindow.rhwpCowork; return ({expr}); }}', arg)


def settle(pg):
    pg.evaluate(f'async () => {{ const c = {FRAME_JS}?.contentWindow?.rhwpCowork; if (c) await c.debug.settled(); }}')


def open_doc(pg, did):
    pg.goto(f'{BASE}/#/doc/{did}')
    pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did, timeout=120000)
    ok(not pg.evaluate('window.__doc.editor.error'), '편집기 준비')
    pg.wait_for_function(f'() => !!{FRAME_JS}?.contentWindow?.rhwpCowork', timeout=30000)
    cw(pg, 'cw.ready')
    settle(pg)


def adopt(pg, pid):
    """d.adoptProposal(pid)(내 수정본에 반영) — confirm 은 묻지 않아야 한다(물으면 거절하고 센다)"""
    r = pg.evaluate('async (p) => { const c = window.confirm; let asked = 0; window.confirm = () => { asked++; return false; };'
                    ' try { const r = await window.__doc.adoptProposal(p); return { r, asked }; } finally { window.confirm = c; } }', pid)
    settle(pg)
    ok(r['r'] and r['r'].get('ok') and r['asked'] == 0, f'#{pid} 반영({r})')


def after_texts(pg, base_text, n=4):
    """편집기 본문 문단 글에서 기준 문단 바로 뒤 n개"""
    paras = cw(pg, 'cw.debug.paragraphs(0)')
    i = paras.index(base_text)
    return paras[i + 1:i + 1 + n]


def type_after(pg, text, add):
    """편집기에서 글 text 인 문단 끝을 눌러 add 를 친다(사람이 초안을 고침)"""
    p = cw(pg, 'cw.debug.pointForText(arg, 1, true)', text)
    assert p, f'pointForText({text}) 없음'
    o = pg.evaluate(f"() => {{ const r = {FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")
    pg.mouse.click(p['x'] + o['x'] + 2, p['y'] + o['y'])
    pg.keyboard.press('End')
    pg.keyboard.type(add)
    settle(pg)
    pg.wait_for_timeout(900)   # 플러그인 'draft' 쉼(600ms)
    settle(pg)


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx-ui-insert-order-')
    srv = start_server(tmp)
    errors = []
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)
            ctx = br.new_context(viewport={'width': 1480, 'height': 920}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(A['token'])}); localStorage.setItem('hwpx.view', 'detail'); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console: {m.text[:200]}') if m.type == 'error' and ('Vue' in m.text or 'cowork' in m.text) else None)

            did, base, nxt, pids, rid = new_doc('차례1')
            open_doc(pg, did)
            ok(pg.evaluate('window.__doc.s.info?.settings?.editMode') in (None, 'review'), '비실시간(승인 방식) 문서')
            ver = cw(pg, 'cw.version'); feats = cw(pg, 'cw.features || null')
            new = bool(feats and 'insertSkip' in feats)
            ok(pg.evaluate('!!window.__doc.editor.canInsertSkip?.()') == new, f'편집기 손잡이 canInsertSkip = 플러그인 기능({ver}, {feats})')

            print(f'[1] #1·#2·#3 하나씩 반영 (플러그인 {ver})', flush=True)
            for pid in pids:
                adopt(pg, pid)
            got = after_texts(pg, base)
            if not new:
                # 옛 편집기 빌드: store 는 skip 없이 예전 길 — 예전처럼 매번 기준 문단 바로 뒤(3·2·1)
                ok(got == [TEXTS[2], TEXTS[1], TEXTS[0], nxt], f'옛 플러그인: 예전 길 그대로 3·2·1({got})')
                ok(not errors, f'화면 오류 없음({errors[:2]})')
                br.close()
                print(f'\nUI INSERT ORDER OK(옛 플러그인 — 예전 길) — {len(RESULTS)}개 확인', flush=True)
                return
            ok(got == [*TEXTS, nxt], f'차례 1·2·3 뒤 기준 문단({got})')
            pg.screenshot(path=f'{OUT}/insert_order_1.png')

            print('[2] #3·#1·#2 차례로 반영', flush=True)
            did, base, nxt, pids, rid = new_doc('차례2')
            open_doc(pg, did)
            for pid in (pids[2], pids[0], pids[1]):
                adopt(pg, pid)
            got = after_texts(pg, base)
            ok(got == [*TEXTS, nxt], f'차례 1·2·3({got})')

            print('[3] #1·#2 반영 → 사람이 #1 초안을 고침 → #3 반영', flush=True)
            did, base, nxt, pids, rid = new_doc('차례3')
            open_doc(pg, did)
            adopt(pg, pids[0]); adopt(pg, pids[1])
            type_after(pg, TEXTS[0], ' 고침')
            ok(after_texts(pg, base, 3) == [TEXTS[0] + ' 고침', TEXTS[1], nxt], '사람이 #1 초안 끝에 글을 더함')
            adopt(pg, pids[2])
            got = after_texts(pg, base)
            ok(got == [TEXTS[0] + ' 고침', TEXTS[1], TEXTS[2], nxt], f"차례 1'·2·3({got})")

            print('[4] #2 하나 반영 → [모두 반영](applyBatch — #1·#3)', flush=True)
            did, base, nxt, pids, rid = new_doc('차례4')
            open_doc(pg, did)
            adopt(pg, pids[1])
            out = pg.evaluate('async (rid) => { const c = window.confirm; window.confirm = () => true; try { return await window.__doc.resolveRequest(rid, "adopt"); } finally { window.confirm = c; } }', rid)
            settle(pg)
            ok(out and (out.get('counts') or {}).get('adopted') == 2, f"모두 반영 2건({(out or {}).get('counts')})")
            got = after_texts(pg, base)
            ok(got == [*TEXTS, nxt], f'차례 1·2·3({got})')

            ok(not errors, f'화면 오류 없음({errors[:2]})')
            br.close()
        print(f'\nUI INSERT ORDER OK — {len(RESULTS)}개 확인', flush=True)
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
        print(f'\nUI INSERT ORDER FAIL — {e}', flush=True)
        sys.exit(1)
