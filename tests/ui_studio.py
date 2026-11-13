# 화면 시험(v0.3 편집기 하나, docs/V3_SPEC.md §5·§6.1): 상단 막대·편집기(rhwp-studio + cowork 플러그인)·검토 레일·패널을 두 사용자로 돈다.
#   A(홍길동)·B(김검토) 두 브라우저 문맥이 같은 문서를 연다 → 플러그인 ready → A: 선택 → 편집기 안 우클릭 '검토' 구역 → 'AI에게 검토 맡기기'
#   → 요청 창이 선택 근처에 → 보내기(모의 AI) → 결과 제안 [반영](내 수정본) → 편집기 글이 바뀜 → 자동 저장 → 칩 '수정 1문단 · 저장됨'
#   → B 편집기에 '✎ 홍길동' 수정 중 표시 → A: 우클릭 '메모 달기' → 레일 카드 → '한글로 저장 ▾ 검토본' 파일에 '[변경 요청 #' 메모
#   → A: 편집기 안 Ctrl+Z → 다음 자동 저장이 덩어리를 지움(B 표시도 사라짐)
#   → 반영해 둔 제안은 다시 반영하지 않음(되돌린 뒤엔 제자리에) → 같은 사람의 두 창: 저장한 수정본을 다른 창이 불러오고, 둘 다 고치면 덮어쓰지 않고 멈춤
#   → A 타이핑 → [검토 요청] → 제출 → B 승인 → 막판 타이핑 → A 반영(먼저 저장, 편집기 잠금) → 두 편집기 모두 새 기준 → 닫기 직전 타이핑도 다시 열면 돌아옴
#   → 좁은 창(1100px)이면 레일을 접고 패널 '검토' 탭 → (있으면) 표 문서 열기 → 브라우저 오류 없음.
#   다듬기 확인: 변경 추적 글을 그냥 누르면(캐럿) 탭은 그대로·강조만, 표식(삭제 쐐기)을 누르면 '변경 추적' 탭 · 검토 요청 제목 기본값 = 바뀐 낱말 ·
#   상단 칩 '변경 요청 #n · 검토 중 · 승인 a · 수정 요청 b · 의견 c' · 남이 승인하면 작성자에게 알림 · 승인 뒤 바뀌어 낡은 승인 → 승인한 사람에게
#   알림·검토 목록 '승인(내용 바뀜)' · 입력 중 표 '● 이름'(기본 배율에서 잘리지 않음)
#   웨이브 3 확인: 반영하자마자 '반영됨'(600ms 틈 없음) · 편집기를 다시 열어도 반영해 둔 제안은
#   대기로 다시 그리지 않음 · 남의 수정 중 '의견 달기'가 NO_HUNK 면 그 문단 전체 의견으로(실패해도 쓴 글 남음) ·
#   같은 사람의 두 창: 알림을 못 받은 창의 저장 → 409 DRAFT_STALE → 칩 '다른 곳에서 바뀜' → [이 글로 저장](rev 없이 덮어쓰기) · 옛 주소 ?legacy=1 도 이 편집기
#   v0.3.1(§9.6·§9.7): 플러그인 판 0.3.1 · 최신 반영 칩은 번호 없이 '기준 문서가 바뀜' · [12] 우클릭 'AI 작업 메모 ▸ 남은 제안 모두 반영(n)'([해결] 없음) →
#   편집기에 한 번에 → 해결(강조·레일 카드 숨김) → Ctrl+Z 한 번에 모두 빠짐(카드 다시 남음) → 레일 [모두 반영 (n)] 다시 → 결과 창에서 내 반영을 [거절]하면
#   편집기에서도 빠짐. 개발용: UI_STUDIO_ONLY=jobs 면 [12]만
#   v0.4 [13k]: 실시간 표 칸 안 Enter·Backspace(내용이 큰 표 칸 하나인 서식) — 공유 문서에는 칸 문단 수 그대로 줄바꿈(<hp:lineBreak/>)으로,
#   친 사람 편집기는 다시 열지 않고 접어 맞춤(캐럿 그 글자 자리) · 남 편집기도 같은 글 · 같은 칸 동시 편집 · 되풀이 없음. UI_STUDIO_ONLY=cell 이면 [13k]만
#   python -I tests/ui_studio.py   → 스크린숏 tests/out/studio_ui_*.png, 서버 기록 tests/out/studio_ui_server.log
# 서버는 포트 8794 에 임시 data 폴더 + 임시 config(토큰도 새로 만듦) + 모의 AI 로 띄운다(진짜 config.json·data/ 는 읽지도 쓰지도 않음).
# 편집기 빌드(studio/dist)가 cowork 플러그인을 품고 있어야 한다: node scripts/build-studio.mjs
import io, json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, time, traceback, urllib.parse, urllib.request, zipfile
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_STUDIO_PORT', '8794'))
BASE = f'http://localhost:{PORT}'          # 브라우저 주소(CLAUDE.md)
REST = f'http://127.0.0.1:{PORT}'          # 시험 코드의 REST
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/tests/fixtures/tool_memo_tracked.hwpx'
SMALL = f'{ROOT}/tests/samples/경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'
RESULTS = []
USERS = [
    {'name': '관리자', 'role': 'admin', 'token': secrets.token_hex(16)},
    {'name': '홍길동', 'role': 'editor', 'token': secrets.token_hex(16)},
    {'name': '김검토', 'role': 'editor', 'token': secrets.token_hex(16)},
]
A = USERS[1]
B = USERS[2]
# v0.4 실시간 절: 수정 권한을 빼 볼 사람(문서 설정 '지정한 사람'에서 뺌 → 읽기 전용)
C = {'name': '이열람', 'role': 'editor', 'token': secrets.token_hex(16)}
USERS.append(C)


def ok(cond, msg):
    RESULTS.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)
    if not cond:
        raise AssertionError(msg)


def rest(path, method='GET', body=None, headers=None, raw=False, token=None):
    h = {'Authorization': f'Bearer {token or A["token"]}'}
    h.update(headers or {})
    data = None
    if body is not None:
        if raw:
            data = body
        else:
            data = json.dumps(body).encode('utf-8'); h['Content-Type'] = 'application/json'
    req = urllib.request.Request(REST + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            return json.loads(b) if 'json' in (r.headers.get('content-type') or '') else b
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {path} → HTTP {e.code}: {e.read().decode("utf-8", "replace")[:300]}') from None


def upload(path, name, token=None):
    with open(path, 'rb') as f:
        return rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote(name), 'Content-Type': 'application/octet-stream'}, raw=True, token=token)


def node_helper(args, token=None):
    """tests/helpers/make_draft.mjs(엔진으로 고친 HWPX → PUT /drafts/mine) — 토큰은 환경 변수로만 넘긴다"""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_')}
    if token:
        env['HWPX_TEST_TOKEN'] = token
    r = subprocess.run(['node', 'tests/helpers/make_draft.mjs', *args], cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise RuntimeError(f'make_draft.mjs {args[0]} 실패: {r.stderr.strip()}')
    return json.loads(r.stdout.strip().splitlines()[-1])


def mcp(token, name, args, agent='PyAgent'):
    """HTTP MCP 도구 한 번(가짜 개인 에이전트 — 요청자 토큰)"""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}).encode('utf-8')
    h = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    req = urllib.request.Request(f'{REST}/mcp?agent={urllib.parse.quote(agent)}', data=body, method='POST', headers=h)
    raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
    line = next((ln for ln in raw.splitlines() if ln.startswith('data:')), None)
    out = json.loads(line[5:] if line else raw)
    if 'error' in out or out.get('result', {}).get('isError'):
        raise RuntimeError(f'MCP {name} 실패: {json.dumps(out, ensure_ascii=False)[:300]}')
    return out


def ai_job(did, token, ref, text, changes, insert=None, agent='PyAgent'):
    """AI 작업 하나(대기열 — REST) → 가짜 에이전트(MCP)가 그 요청(request_id)으로 제안 여러 건(바꿈 + 문단 추가)을 남기고 완료 → (rid, [pid…] pid 순)"""
    r = rest(f'/api/docs/{did}/requests', 'POST', {'kind': 'instruct', 'instruction': '여러 곳 끝맺음 다듬기(시험)', 'route': 'queue',
                                                   'target': {'ref': ref, 'start': 0, 'end': len(text), 'text': text}}, token=token)
    rid = r['request']['rid']
    mcp(token, 'start_request', {'doc_id': did, 'request_id': rid}, agent=agent)
    mcp(token, 'propose_changes', {'doc_id': did, 'request_id': rid, 'proposals': changes}, agent=agent)
    if insert:
        mcp(token, 'propose_insert', {'doc_id': did, 'request_id': rid, 'after_ref': insert['after'], 'text': insert['text'], 'reason': '보완(시험)'}, agent=agent)
    mcp(token, 'complete_request', {'doc_id': did, 'request_id': rid, 'summary': '끝맺음 여러 곳을 다듬도록 제안함(시험)'}, agent=agent)
    return rid, sorted(p['pid'] for p in rest(f'/api/docs/{did}/proposals', token=token) if p.get('rid') == rid)


# 시험용: 이 창(맨 위 문서만)의 WebSocket 알림을 붙잡아 둘 수 있게 한다 — window.__wsHold = true 동안 온 메시지는 모았다가
# window.__wsRelease() 때 차례대로 넘긴다(알림이 늦게 오는 창 = 옛 판으로 저장하는 창을 만든다). 제품 코드는 그대로다
HOLD_WS_JS = """
(() => {
  if (window.top !== window || !window.WebSocket || window.WebSocket.__held) return;
  const Native = window.WebSocket; const held = [];
  window.__wsHold = false;
  class HeldWebSocket extends Native {
    constructor(...a) {
      super(...a); this.__h = null;
      super.addEventListener('message', (ev) => { if (window.__wsHold) { held.push([this, ev]); return; } if (this.__h) this.__h.call(this, ev); });
    }
    get onmessage() { return this.__h; }
    set onmessage(fn) { this.__h = fn; }
  }
  HeldWebSocket.__held = true;
  window.WebSocket = HeldWebSocket;
  window.__wsRelease = () => { window.__wsHold = false; for (const [w, ev] of held.splice(0)) { if (w.__h) w.__h.call(w, ev); } return true; };
})();
"""


def cps(s):
    return list(s)


def cp_index(text, sub, nth=1):
    i = -1
    for _ in range(nth):
        i = text.index(sub, i + 1)
    s = len(cps(text[:i]))
    return s, s + len(cps(sub))


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
    raise AssertionError(f'시간 초과: {msg} ({last})')


def shot(pg, name):
    pg.screenshot(path=f'{OUT}/studio_ui_{name}.png')
    print(f'    → tests/out/studio_ui_{name}.png', flush=True)


def port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def start_server(tmp):
    """임시 data·config 로 서버를 띄우고, 우리 토큰이 통하는(= 우리가 띄운) 서버인지 확인한다"""
    if port_busy(PORT):
        raise RuntimeError(f'포트 {PORT} 를 이미 다른 프로세스가 쓰고 있습니다(남은 시험 서버를 끄고 다시 실행하세요)')
    data = os.path.join(tmp, 'data'); os.makedirs(data, exist_ok=True)
    cfg = {
        'host': '127.0.0.1', 'port': PORT, 'dataDir': './data', 'tutorial': {'enabled': False}, 'allowAgentApply': True, 'users': USERS,
        # 키 파일은 없는 경로: 어떤 경우에도 실제 API 를 부르지 않는다(모의 AI 만)
        'ai': {'enabled': False, 'mock': False, 'keyFile': os.path.join(tmp, 'no-such-key.txt'), 'model': 'claude-opus-5-5', 'effort': 'medium', 'maxProposals': 10},
        'studio': {'mode': 'local'}, 'agents': {'leaseMinutes': 15, 'othersCanTake': False}, 'changeRequests': {'requireApprovals': 1},
        # v0.4: 지금까지의 시험(승인 방식 흐름)은 그대로 — 새 문서는 승인 방식·작업 기록 메모 자세히(v0.3.1 꼴). 실시간 절은 문서 설정을 바꿔 쓴다
        'documents': {'defaultEditMode': 'review', 'defaultAiMemo': 'detail'},
    }
    cfg_path = os.path.join(tmp, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=cfg_path, HWPX_COWORK_DATA_DIR=data, HWPX_COWORK_AI_MOCK='1', HWPX_COWORK_PORT=str(PORT), HWPX_COWORK_HOST='127.0.0.1')
    # 비교할 편집기 번들(후보 빌드)만 그대로 넘긴다 — 다른 HWPX_COWORK_* 는 위에서 지운다(2026-11-10)
    if os.environ.get('HWPX_COWORK_STUDIO_DIR'):
        env['HWPX_COWORK_STUDIO_DIR'] = os.path.abspath(os.environ['HWPX_COWORK_STUDIO_DIR'])
        print(f'편집기 번들: {env["HWPX_COWORK_STUDIO_DIR"]}', flush=True)
    log = open(f'{OUT}/studio_ui_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    conf = None
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError(f'서버가 시작하다 끝났습니다(code {srv.returncode}) — tests/out/studio_ui_server.log')
        try:
            conf = json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read())
            if conf.get('nonce'):
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    if not conf or not conf.get('nonce'):
        raise RuntimeError('서버가 뜨지 않았습니다')
    me = rest('/api/me')
    if me.get('name') != A['name']:
        raise RuntimeError(f'포트 {PORT} 의 서버가 이 시험의 서버가 아닙니다: {me}')
    return srv, log, conf


# ───────── 화면 도우미 ─────────

FRAME_JS = "document.querySelector('.editorhost iframe')"


def cw(pg, expr, arg=None):
    """iframe 안 플러그인 API(rhwpCowork)로 식을 평가한다 — expr 안에서 cw 로 부른다"""
    return pg.evaluate(f'async (arg) => {{ const cw = {FRAME_JS}.contentWindow.rhwpCowork; return ({expr}); }}', arg)


def editor_frame(pg):
    return next(f for f in pg.frames if '/studio/' in f.url)


def settle(pg):
    pg.evaluate(f'async () => {{ const c = {FRAME_JS}?.contentWindow?.rhwpCowork; if (c) await c.debug.settled(); }}')


def open_doc(pg, did, suffix=''):
    pg.goto(f'{BASE}/#/doc/{did}{suffix}')
    # 같은 페이지에서 다른 문서로 옮기면 잠깐 옛 문서 화면(window.__doc)이 남아 있다 — 그 문서의 store 인지 본다
    pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did, timeout=120000)
    err = pg.evaluate('window.__doc.editor.error')
    ok(not err, f'편집기 준비{"" if not err else ": " + err}')
    pg.wait_for_function(f'() => {{ const c = {FRAME_JS}?.contentWindow?.rhwpCowork; return !!c; }}', timeout=30000)
    cw(pg, 'cw.ready')
    settle(pg)


def frame_offset(pg):
    return pg.evaluate(f"() => {{ const r = {FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")


def point(pg, ref, off):
    """기준 (ref, offset) 의 페이지 좌표(= iframe client + iframe 자리)"""
    p = cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', [ref, off])
    assert p, f'pointFor({ref}, {off}) 가 null'
    o = frame_offset(pg)
    return {'x': p['x'] + o['x'], 'y': p['y'] + o['y']}


def store(pg, expr):
    """페이지의 문서 store(window.__doc = d)로 식을 평가한다 — expr 안에서 d·s 로 부른다"""
    return pg.evaluate(f'() => {{ const d = window.__doc; const s = d.s; const v = ({expr}); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }}')


def chip_text(pg):
    return pg.locator('[data-testid="draft-chip"]').inner_text().strip()


def overlays(pg):
    return cw(pg, 'cw.debug.overlays()')


def para_text(did, ref, token=None):
    return next((p['text'] for p in rest(f'/api/docs/{did}/paragraphs', token=token) if p['ref'] == ref), None)


def adopt_answer(pg, pid, answer):
    """d.adoptProposal(pid) — window.confirm 은 answer 로 답하고 물은 횟수를 센다 → { r, asked }"""
    return pg.evaluate('async ([p, ans]) => { const c = window.confirm; let asked = 0; window.confirm = () => { asked++; return ans; };'
                       ' try { const r = await window.__doc.adoptProposal(p); return { r, asked }; } finally { window.confirm = c; } }', [pid, answer])


def type_at(pg, ref, off, text=None):
    """편집기를 눌러 키 입력이 가게 하고 기준 (ref, off) 에 캐럿을 둔 뒤(있으면) 글을 친다.
    (저절로 다시 연 직후면 쪽 배치가 끝날 때까지 기다린다 — 그 전에는 pointFor 가 null)"""
    wait_until(lambda: store(pg, '!!(s.editor && s.editor.ready && !s.editor.locked && !s.editor.loading)'), timeout=20, msg='편집기 준비')
    settle(pg)
    q = wait_until(lambda: point(pg, ref, 2), timeout=10, msg=f'pointFor({ref})')
    pg.mouse.click(q['x'], q['y'])
    cw(pg, 'cw.debug.select(arg[0], arg[1], arg[1])', [ref, off])
    settle(pg)
    if text:
        pg.keyboard.type(text)


def memo_texts_of_file(path):
    """내려받은 HWPX 를 엔진(HwpxDoc)으로 읽어 메모 글 목록"""
    script = ("import fs from 'node:fs'; import { HwpxDoc } from 'file:///" + ROOT + "/engine/doc.js';"
              "const doc = await HwpxDoc.load(fs.readFileSync(process.argv[1]));"
              "process.stdout.write(JSON.stringify(doc.memos().map((m) => m.text)));")
    r = subprocess.run(['node', '--input-type=module', '-e', script, path], cwd=ROOT, capture_output=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'HwpxDoc 으로 읽지 못함: {r.stderr.decode("utf-8", "replace")[:400]}')
    return json.loads(r.stdout.decode('utf-8'))


class OnlyReview(Exception):
    """UI_STUDIO_ONLY=review 로 [11]만 돈 뒤 나머지를 건너뛴다(개발용)"""


def cp_slice(text, a, b=None):
    c = cps(text)
    return ''.join(c[a:b] if b is not None else c[a:])


def review_fixes(context, pa, tmp, errors):
    """[11] 검토 고침(웨이브 3 검토): 내 수정본에서만 고친 글 · 여러 문단 대상 · 떠 있는 창의 쓰던 글(Esc·창 바꿈) · 최신 반영 전 기준 지도 ·
    저절로 다시 열기 잠금 · 저장을 멈춘 채 나가기 확인 · 다른 창이 최신 반영한 뒤 [내 글 옮겨 넣기]"""
    admin = USERS[0]['token']
    print('[11] 검토 고침 — 새 시험 문서(첫째~여덟째 문단)', flush=True)
    built = node_helper(['build', '--out', os.path.join(tmp, 'review_fix.hwpx')])
    d3 = upload(built['out'], '검토고침.hwpx', token=admin)['id']

    def body_texts(token=None):
        return {p['ref']: p['text'] for p in rest(f'/api/docs/{d3}/paragraphs', token=token) if '/n' not in p['ref']}

    def ref_of(prefix, texts):
        return next(r for r, t in texts.items() if t.startswith(prefix))
    v1 = body_texts()
    P4, P5, P6, P7, P8 = (ref_of(x, v1) for x in ('넷째', '다섯째', '여섯째', '일곱째', '여덟째'))
    open_doc(pa, d3)
    fa = editor_frame(pa)

    print('[11a] 내 수정본에서만 고친 글을 골라 AI 요청 → 막고 알림 · 메모는 그 문단 전체에(창에 알림)', flush=True)
    ADD6 = ', 내년에는 2억 원으로 늘릴 계획입니다'
    type_at(pa, P6, len(cps(v1[P6])) - 1, ADD6)
    wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='여섯째 저장')
    a0 = cw(pa, "cw.debug.pointForText('내년에는', 1, false)")
    a1 = cw(pa, "cw.debug.pointForText('계획입니다', 1, false)")
    o = frame_offset(pa)
    pa.mouse.move(o['x'] + a0['x'], o['y'] + a0['y'])
    pa.mouse.down()
    pa.mouse.move(o['x'] + a1['x'] + 60, o['y'] + a1['y'], steps=8)
    pa.mouse.up()
    settle(pa)
    sel = wait_until(lambda: (lambda x: x if x and x.get('source') == 'draft' and not x.get('collapsed') and '내년에는' in (x.get('draftText') or '') else None)(store(pa, 's.sel')), timeout=5, msg='내가 넣은 글 선택')
    tg = store(pa, 'd.targetFromCw(s.sel)')
    why = store(pa, "d.targetProblem(d.targetFromCw(s.sel), 'review')")
    ok(tg.get('draftOnly') and '내년에는' in (tg.get('display') or '') and tg.get('text') != tg.get('display') and why,
       f"고른 글 = 내 수정본에서만 고친 글 → 대상 draftOnly(보이는 글 「{tg.get('display')}」 · 서버로 갈 기준 글 「{tg.get('text')}」)")
    pa.mouse.click(o['x'] + a0['x'] + 20, o['y'] + a0['y'], button='right')
    fa.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
    fa.click('.context-menu [data-cowork-action="instruct"]')
    wait_until(lambda: '내 수정본에서 고친 글은' in pa.locator('.toasts').inner_text(), timeout=5, msg='AI 요청 막음 알림')
    ok(store(pa, 's.composer') is None, "우클릭 'AI에게 맡기기…' → 요청 창을 열지 않고 알림(기준 문서에 없는 글 — 보이는 글과 보내는 글이 어긋나지 않게)")
    pa.mouse.click(o['x'] + a0['x'] + 20, o['y'] + a0['y'], button='right')
    fa.wait_for_selector('.context-menu [data-cowork-action="memo"]', timeout=5000)
    fa.click('.context-menu [data-cowork-action="memo"]')
    pa.wait_for_selector('.popover textarea', timeout=5000)
    pt = store(pa, 's.popover.target')
    ok(pt['ref'] == P6 and pt.get('whole') and pt['text'] == v1[P6] and '문단 전체에 답니다' in pa.locator('.popover .cmp-target').inner_text(),
       f"메모 달기 → 그 문단 전체(기준 글)에 · 창에 알림 「{pa.locator('.popover .cmp-target').inner_text().strip()[:70]}」")
    shot(pa, '13_draft_only_memo')

    print('[11b] 떠 있는 창의 쓰던 글: 편집기 안 Esc 로 닫지 않음 · 닫거나 다른 창으로 바꿔도 같은 대상에 다시 열면 돌아옴', flush=True)
    MEMO_T = '예산 근거 자료를 붙여 주세요. 작년 대비 증감도 같이 적어 주시면 좋겠습니다.'
    pa.fill('.popover textarea', MEMO_T)
    q4 = point(pa, P4, 3)
    pa.mouse.click(q4['x'], q4['y'])       # 편집기를 눌러 캐럿을 옮기고
    settle(pa)
    pa.keyboard.press('Escape')            # 편집기 안 Esc(선택 풀기 등)
    time.sleep(0.4)
    ok(pa.locator('.popover textarea').count() == 1 and pa.locator('.popover textarea').input_value() == MEMO_T, '편집기 안 Esc → 쓰던 글이 있는 메모 창은 그대로')
    pa.locator('.popover .fw-head button[aria-label="닫기"]').click()
    wait_until(lambda: store(pa, 's.popover') is None, timeout=3, msg='메모 창 닫힘')
    q6 = point(pa, P6, 3)

    def menu(action):
        # 떠 있는 창(호스트 페이지)이 편집기(iframe) 안 우클릭 메뉴를 덮을 수 있어 그 항목에 click 을 바로 보낸다(메뉴 행은 click 으로 움직인다)
        pa.mouse.click(q6['x'], q6['y'], button='right')
        fa.wait_for_selector(f'.context-menu [data-cowork-action="{action}"]', timeout=5000)
        fa.locator(f'.context-menu [data-cowork-action="{action}"]').dispatch_event('click')
    menu('memo')
    pa.wait_for_selector('.popover textarea', timeout=5000)
    ok(pa.locator('.popover textarea').input_value() == MEMO_T, '[닫기] 한 메모 창을 같은 문단에 다시 열면 쓰던 글이 돌아옴')
    menu('instruct')
    pa.wait_for_selector('.composer-win textarea.cmp-instr', timeout=5000)
    INSTR = '첨부한 예산서의 2026년 수치로 이 문장을 고쳐 줘'
    pa.fill('.composer-win textarea.cmp-instr', INSTR)
    pa.mouse.click(q4['x'], q4['y'])
    settle(pa)
    pa.keyboard.press('Escape')
    time.sleep(0.4)
    ok(store(pa, 's.composer && s.composer.instruction') == INSTR, '편집기 안 Esc → 지시를 쓰던 요청 창도 그대로')
    menu('memo')
    pa.wait_for_selector('.popover textarea', timeout=5000)
    ok(pa.locator('.popover textarea').input_value() == MEMO_T and store(pa, 's.composer') is None, "요청 창 → (우클릭) 메모 달기로 바꿈 → 메모 창에 쓰던 메모 글")
    menu('instruct')
    pa.wait_for_selector('.composer-win textarea.cmp-instr', timeout=5000)
    ok(pa.locator('.composer-win textarea.cmp-instr').input_value() == INSTR, "메모 창 → 'AI에게 지시…'로 바꿈 → 요청 창에 쓰던 지시가 돌아옴")
    pa.locator('.composer-win .fw-head button[aria-label="닫기"]').click()
    wait_until(lambda: store(pa, 's.composer') is None, timeout=3, msg='요청 창 닫힘')

    print('[11c] 여러 문단 선택 → AI 요청(서버 규칙: end = 끝 문단 안, text = 고른 글 전체)', flush=True)
    t4, t5 = v1[P4], v1[P5]
    s4 = cp_index(t4, '사업')[0]; e5 = cp_index(t5, '추진')[1]
    cw(pa, 'cw.debug.select(arg[0], arg[1], arg[2], arg[3])', [P4, s4, e5, P5])
    settle(pa)
    wait_until(lambda: (lambda x: x if x and len(x.get('refs') or []) == 2 else None)(store(pa, 's.sel')), timeout=5, msg='두 문단 선택')
    send_js = ("async (route) => { const d = window.__doc; const t = d.targetFromCw(d.s.sel); try { const r = await d.createRequest({ kind: 'review', preset: null, instruction: '', target: t,"
               " attachments: [], count: 3, includeInstruction: false, route }); return { ok: true, rid: r.request && r.request.rid, target: r.request && r.request.target }; }"
               " catch (e) { return { ok: false, code: e.code, message: e.message }; } }")
    rq = pa.evaluate(send_js, 'queue')
    want = cp_slice(t4, s4) + '\n' + cp_slice(t5, 0, e5)
    ok(rq.get('ok') and rq['target']['refs'] == [P4, P5] and rq['target']['text'] == want, f"두 문단 요청 → 서버가 받음(대상 {rq.get('target', {}).get('refs') if rq.get('ok') else rq})")
    rest(f"/api/docs/{d3}/requests/{rq['rid']}/cancel", 'POST', {})

    print('[11d] 내 수정본이 옛 기준(다른 사람 반영 뒤) — 메모 강조·제안 반영·고른 자리·AI 요청·타이핑 중 알림이 지금 기준 자리로', flush=True)
    mres = rest(f'/api/docs/{d3}/memos', 'POST', {'ref': P5, 'find': '3월부터', 'text': '관리자: 일정 확인'}, token=admin)
    memo_id = mres['id']
    wait_until(lambda: store(pa, 's.editor.baseVersion') == rest(f'/api/docs/{d3}')['version'] and not store(pa, 's.draft.behind'), timeout=20, msg='A 조용히 새 기준(메모만 늘어남)')
    bres = node_helper(['draft', '--base', REST, '--doc', d3, '--edits', json.dumps([{'after': 's0/p1', 'text': 'B 가 끼운 새 문단입니다.'}], ensure_ascii=False)], token=B['token'])
    rest(f"/api/docs/{d3}/change-requests/{bres['cr']['cid']}/submit", 'POST', {'title': 'B 문단 추가'}, token=B['token'])
    rest(f"/api/docs/{d3}/change-requests/{bres['cr']['cid']}/merge", 'POST', {}, token=admin)
    pa.locator('[data-testid="behind-chip"]').wait_for(timeout=20000)
    v3 = body_texts()
    Q4, Q5, Q6, Q7, Q8 = (ref_of(x, v3) for x in ('넷째', '다섯째', '여섯째', '일곱째', '여덟째'))
    wait_until(lambda: store(pa, 'd.editor.mapping()'), timeout=10, msg='기준 지도')
    ok(Q5 != P5 and Q6 != P6, f'B 의 반영으로 지금 기준 번호가 밀림(다섯째 {P5} → {Q5}) · A 편집기는 옛 기준(최신 반영 필요, 기준 지도 씀)')
    settle(pa)
    wrong = cw(pa, "cw.debug.pointForText('예산은')")      # 여섯째 줄(옛 기준 자리로 그리면 여기)
    right = cw(pa, "cw.debug.pointForText('3월부터')")
    ov = wait_until(lambda: [x for x in overlays(pa) if x['kind'] == 'memo' and x['id'] == str(memo_id) and x['rect']['w'] > 6], timeout=8, msg='메모 강조')
    cy = lambda x: x['rect']['y'] + x['rect']['h'] / 2
    ok(all(abs(cy(x) - right['y']) < abs(cy(x) - wrong['y']) for x in ov),
       f"지금 기준 메모(다섯째 {Q5} '3월부터') 강조가 A 편집기의 '3월부터' 줄 위에 — 옛 기준 자리(여섯째) 아님(y {[round(cy(x)) for x in ov]} · 3월부터 {round(right['y'])} · 여섯째 {round(wrong['y'])})")
    shot(pa, '14_behind_memo')
    pr = rest(f'/api/docs/{d3}/proposals', 'POST', {'ref': Q7, 'find': '문단', 'replace': '단락', 'reason': '시험'}, token=admin)
    pid = pr['pid']
    wait_until(lambda: any(x['pid'] == pid for x in store(pa, 's.proposals')), timeout=15, msg='A 가 제안을 받음')
    before = {r: cw(pa, 'cw.debug.text(arg)', r) for r in (P7, P8)}
    res = adopt_answer(pa, pid, True)
    settle(pa)
    after = {r: cw(pa, 'cw.debug.text(arg)', r) for r in (P7, P8)}
    ok(res['r'] == {'ok': True} and after[P7] == before[P7].replace('문단', '단락', 1) and after[P8] == before[P8],
       f"지금 기준 일곱째({Q7}) 제안 → A 편집기의 일곱째에 반영 「{after[P7]}」(여덟째 그대로)")
    s6, e6 = cp_index(v1[P6], '1억 원')
    cw(pa, 'cw.debug.select(arg[0], arg[1], arg[2])', [P6, s6, e6])
    settle(pa)
    sel = wait_until(lambda: (lambda x: x if x and not x.get('collapsed') and x.get('text') == '1억 원' else None)(store(pa, 's.sel')), timeout=5, msg='1억 원 선택')
    ok(sel['ref'] == Q6 and not sel.get('stale'), f"s.sel = 지금 기준 ref {sel['ref']}(편집기 기준 {P6})")
    mm = pa.evaluate("async () => { const d = window.__doc; return await d.addMemo(d.targetFromCw(d.s.sel), 'A: 예산 근거?'); }")
    ok(mm['ref'] == Q6 and mm.get('anchorText') == '1억 원', f"그 선택에 메모 → 지금 기준 {mm['ref']} 「{mm.get('anchorText')}」에 달림")
    s7, e7 = cp_index(v1[P7], '기대 효과')
    cw(pa, 'cw.debug.select(arg[0], arg[1], arg[2])', [P7, s7, e7])
    settle(pa)
    wait_until(lambda: (lambda x: x if x and x.get('text') == '기대 효과' else None)(store(pa, 's.sel')), timeout=5, msg='기대 효과 선택')
    rq = pa.evaluate(send_js, 'queue')
    ok(rq.get('ok') and rq['target']['ref'] == Q7 and rq['target']['text'] == '기대 효과', f"AI 요청 → 지금 기준 자리 {rq.get('target', {}).get('ref') if rq.get('ok') else rq}(STALE 아님)")
    rest(f"/api/docs/{d3}/requests/{rq['rid']}/cancel", 'POST', {})
    ctxB3, pb3 = context(B, 'B3')
    open_doc(pb3, d3)
    type_at(pa, P6, 0, '총 ')
    seen = wait_until(lambda: store(pb3, "s.editing['홍길동'] || null"), timeout=10, step=0.1, msg='B 에 A 타이핑 중 알림')
    ok(seen == Q6, f"A 타이핑 중 알림 = 지금 기준 ref {seen}(편집기 기준 {P6} 아님)")
    # B 편집기(기본 배율)의 입력 중 표: '● 홍길동'(이름만 — 왼쪽 여백에서 잘리지 않음), 마우스를 올리면 '홍길동 님이 입력 중'(플러그인)
    et = wait_until(lambda: next((x for x in overlays(pb3) if 'cw-etag' in x['cls']), None), timeout=3, step=0.05, msg='B 편집기 입력 중 표')
    efit = pb3.evaluate(f"() => {{ const e = {FRAME_JS}.contentDocument.querySelector('.cowork-marks > .cw-etag'); return e ? {{ sw: e.scrollWidth, cw: e.clientWidth }} : null; }}")
    ok(et['text'] == f"● {A['name']}" and efit and efit['cw'] > 0 and efit['sw'] <= efit['cw'] + 1,
       f"B 편집기 입력 중 표 「{et['text']}」 — 기본 배율에서 잘리지 않음(글 {efit and efit['sw']}px ≤ 칸 {efit and efit['cw']}px)")
    ctxB3.close()
    wait_until(lambda: re.search(r'저장됨', chip_text(pa)), timeout=20, msg='A 저장')
    # 다른 사람이 그 글을 바꿨으면(관리자 기준에 바로 적용) 고른 글이 지금 기준과 다르다 → 요청 창을 열지 않고 알림
    pq = rest(f'/api/docs/{d3}/proposals', 'POST', {'ref': Q4, 'find': '사업 개요', 'replace': '사업 목표', 'reason': '시험'}, token=admin)
    rest(f"/api/docs/{d3}/proposals/{pq['pid']}/apply", 'POST', {}, token=admin)
    wait_until(lambda: any('사업 목표' in (p.get('text') or '') for p in store(pa, 's.paragraphs')), timeout=15, msg='A 문단 목록 갱신')
    s4, e4 = cp_index(v1[P4], '사업 개요')
    cw(pa, 'cw.debug.select(arg[0], arg[1], arg[2])', [P4, s4, e4])
    settle(pa)
    sel = wait_until(lambda: (lambda x: x if x and x.get('text') == '사업 개요' else None)(store(pa, 's.sel')), timeout=5, msg='사업 개요 선택')
    mid = point(pa, P4, s4 + 1)
    pa.mouse.click(mid['x'], mid['y'], button='right')
    fa.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
    fa.click('.context-menu [data-cowork-action="instruct"]')
    wait_until(lambda: '고른 글이 지금 문서에서 바뀌었습니다' in pa.locator('.toasts').inner_text(), timeout=5, msg='바뀐 글 알림')
    ok(sel.get('stale') and store(pa, 's.composer') is None, '지금 기준에서 바뀐 글을 골라 AI 요청 → 창을 열지 않고 [최신 반영] 안내(서버 STALE 대신)')

    print('[11e] 저절로 다시 열기: 파일을 싣는 동안 편집기 잠금 — 그 사이 친 글이 엉뚱한 자리로 가지 않음', flush=True)
    wait_until(lambda: not store(pa, 's.draft.dirty') and not store(pa, 's.draft.saving'), timeout=20, msg='A 저장 끝')
    type_at(pa, P8, 1)
    before8 = cw(pa, 'cw.debug.text(arg)', P8)
    pa.evaluate("() => { window.__rl = false; window.__doc.editor.reload({ keepScroll: true, auto: true }).then(() => { window.__rl = true; }); }")
    got = wait_until(lambda: store(pa, "s.editor.locked ? { label: s.editor.locked, inert: !!d.editor.frame().inert } : null"), timeout=20, step=0.02, msg='다시 여는 동안 잠금')
    pa.keyboard.type('가나다')
    wait_until(lambda: pa.evaluate('window.__rl'), timeout=60, msg='다시 열기 끝')
    settle(pa)
    # 옛 기준 수정본을 다시 열면 편집기 기준 문단은 지금 기준 것이다(GET /paragraphs) — 여덟째는 이제 Q8
    ok(got['label'] == '새 버전으로 여는 중…' and got['inert'] and cw(pa, 'cw.debug.text(arg)', Q8) == before8 and cw(pa, "cw.debug.pointForText('가나다')") is None
       and not store(pa, 's.draft.dirty') and not store(pa, 's.editor.locked'),
       f"다시 여는 동안 잠금({got['label']}, inert) — 그 사이 친 글은 들어가지 않음 · 끝나면 풂")

    print('[11f] 같은 사람 둘째 창이 저장을 멈춘 채(다른 곳에서 바뀜) ← 목록 → 나갈지 묻고 [취소]면 머묾', flush=True)
    ans = {'accept': False}
    ctxH, ph = context(A, 'A-hold', hold_ws=True, answers=ans)
    open_doc(ph, d3)
    ph.evaluate('() => { window.__wsHold = true; }')
    type_at(pa, Q8, len(cps(v3[Q8])), ' 창일')
    wait_until(lambda: re.search(r'저장됨', chip_text(pa)) and not store(pa, 's.draft.dirty'), timeout=20, msg='창1 저장')
    hq5 = ref_of('다섯째', {p['ref']: p['text'] for p in store(ph, 's.paragraphs') if '/n' not in p['ref']})
    n_err = len(errors)
    type_at(ph, hq5, 2, '[둘째 창 글]')
    code = ph.evaluate('() => window.__doc.saveDraftNow().then(() => "saved", (e) => e.code)')
    wait_until(lambda: store(ph, 's.draft.stale') and store(ph, 's.draft.dirty'), timeout=10, msg='둘째 창 저장 멈춤')
    ph.click('a.back')
    # (확인 창 이벤트는 Playwright 호출 중에만 처리기로 온다 — 기다리며 페이지 시계를 돌린다)
    wait_until(lambda: (ph.wait_for_timeout(100), ans.get('seen'))[1], timeout=15, msg='나가기 확인 창')
    time.sleep(0.5)
    stay = ph.evaluate('() => location.hash') == f'#/doc/{d3}' and ph.locator('.docview').count() == 1 and store(ph, 's.draft.dirty')
    ok(code == 'DRAFT_STALE' and stay and '저장하지 못한 글' in ans['seen'][0], f"← 목록 → 확인 창 「{ans['seen'][0].splitlines()[0]}」 → [취소] → 문서 화면·친 글 그대로")
    ans['accept'] = True
    ph.click('a.back')
    wait_until(lambda: ph.locator('.listpage').count() == 1, timeout=10, msg='목록')
    ok(len(ans['seen']) == 2, '다시 ← 목록 → [확인] → 목록으로(그 글은 버림)')
    ctxH.close()
    errors[n_err:] = [e for e in errors[n_err:] if not re.search(r'status of (403|409)', e)]

    print('[11g] 같은 사람 둘째 창: 첫 창이 [최신 반영] 한 뒤 둘째 창 글 — [이 글로 저장] 대신 [내 글 옮겨 넣기]', flush=True)
    ctxK, pk = context(A, 'A-keep', hold_ws=True)
    open_doc(pk, d3)
    pk.evaluate('() => { window.__wsHold = true; }')
    pa.locator('[data-testid="behind-chip"] button').click()
    wait_until(lambda: pa.locator('[data-testid="behind-chip"]').count() == 0 and store(pa, 's.editor.ready && !s.editor.locked && s.editor.source') == 'draft', timeout=30, msg='창1 최신 반영')
    new_base = rest(f'/api/docs/{d3}/drafts/mine')['cr']['baseVersion']
    kq5 = ref_of('다섯째', {p['ref']: p['text'] for p in store(pk, 's.paragraphs') if '/n' not in p['ref']})
    n_err = len(errors)
    KEEP = ' (둘째 창에서 고침)'
    type_at(pk, kq5, len(cps(v3[Q5])), KEEP)
    code = pk.evaluate('() => window.__doc.saveDraftNow().then(() => "saved", (e) => e.code)')
    wait_until(lambda: store(pk, 's.draft.stale') and pk.locator('[data-testid="chip-carry"]').count() == 1, timeout=10, msg='[내 글 옮겨 넣기]')
    ok(code == 'DRAFT_STALE' and pk.locator('[data-testid="chip-keep"]').count() == 0 and '최신으로 맞춤' in chip_text(pk) and store(pk, 's.draft.rebased')
       and pk.locator('[data-testid="behind-chip"]').count() == 0,
       f"둘째 창 저장 → 409(서버 수정본 기준 v{new_base} 이 더 새것) → 칩 「{chip_text(pk).splitlines()[0]}」 [다시 열기] [내 글 옮겨 넣기](이 글로 저장·이 창 [최신 반영] 없음)")
    pk.evaluate('() => window.__wsRelease()')
    time.sleep(1.0)
    ok(pk.locator('[data-testid="chip-carry"]').count() == 1 and pk.locator('[data-testid="chip-keep"]').count() == 0, '늦게 온 알림(rebased) 뒤에도 [내 글 옮겨 넣기] 그대로')
    shot(pk, '15_carry_chip')
    pk.locator('[data-testid="chip-carry"]').click()
    wait_until(lambda: '옮겨 넣었습니다' in pk.locator('.toasts').inner_text(), timeout=30, msg='옮겨 넣음 알림')

    def server_hunks():
        return [h['newText'] for h in rest(f'/api/docs/{d3}/drafts/mine')['cr']['hunks']]
    hk = wait_until(lambda: (lambda hs: hs if any(KEEP in t for t in hs) else None)(server_hunks()), timeout=20, msg='옮겨 넣은 글 저장')
    mine = rest(f'/api/docs/{d3}/drafts/mine')['cr']
    ok(mine['baseVersion'] == new_base and any(ADD6 in t for t in hk) and any(t.startswith('일곱째 단락') for t in hk) and not store(pk, 's.draft.stale'),
       f"[내 글 옮겨 넣기] → 최신 반영된 수정본(v{mine['baseVersion']}) 위에 둘째 창 글 · 첫 창의 고침도 그대로(덩어리 {len(hk)})")
    errors[n_err:] = [e for e in errors[n_err:] if not re.search(r'status of (403|409)', e)]
    ctxK.close()

    print('[11h] 기준 지도 단독(브라우저 안 editor.js buildBaseMap): 바꾼 문단 앞에 넣은 문단 · 표 칸 · offset · 같은 목록', flush=True)
    r = pa.evaluate('''async () => {
      const { buildBaseMap } = await import('/editor.js');
      const P = (ref, text, extra = {}) => ({ ref, text, parent: null, cell: null, ...extra });
      const cell = (ref, text, parent, row, col) => P(ref, text, { parent, container: 'hp:tc', cell: { table: `${parent}#t0`, row, col } });
      const E = [P('s0/p0', '머리말'), P('s0/p1', '예산은 총 1억 원입니다.'), P('s0/p2', '', { kind: 'table', sig: 'T1' }),
        cell('s0/p2/n0', '칸1', 's0/p2', 0, 0), cell('s0/p2/n1', '칸2', 's0/p2', 0, 1), P('s0/p3', '맺음말')];
      const C = [P('s0/p0', '머리말'), P('s0/p1', '새로 넣은 문단'), P('s0/p2', '예산은 총 2억 원입니다.'), P('s0/p3', '', { kind: 'table', sig: 'T1' }),
        cell('s0/p3/n0', '칸1', 's0/p3', 0, 0), cell('s0/p3/n1', '칸2 고침', 's0/p3', 0, 1), P('s0/p4', '맺음말')];
      const M = buildBaseMap(E, C);
      return {
        changed: M.ref('c', 's0/p1'), back: M.ref('e', 's0/p2'), inserted: M.ref('e', 's0/p1'), table: M.ref('c', 's0/p2'), cellC: M.ref('c', 's0/p2/n1'), cellE: M.ref('e', 's0/p3/n0'),
        last: M.ref('c', 's0/p3'), after: M.after('e', 's0/p1'), off: M.point('c', 's0/p1', 's0/p2', 9), cellEnd: M.end('e', 's0/p3/n1', 's0/p2/n1', 0, 5),
        same: buildBaseMap(E, E.map((x) => ({ ...x }))), range: M.range('e', { ref: 's0/p2', start: 6, end: 8, endRef: 's0/p2', kind: 'memo' }),
      };
    }''')
    ok(r['changed'] == 's0/p2' and r['back'] == 's0/p1' and r['inserted'] is None and r['table'] == 's0/p3' and r['cellC'] == 's0/p3/n1' and r['cellE'] == 's0/p2/n0'
       and r['last'] == 's0/p4' and r['after'] == 's0/p0' and r['off'] == 9 and r['cellEnd'] == 2 and r['same'] is None
       and r['range'] == {'ref': 's0/p1', 'start': 6, 'end': 8, 'endRef': 's0/p1', 'kind': 'memo'},
       f'기준 지도: 바꾼 문단은 앞에 새 문단이 끼어도 비슷한 글끼리 짝 · 넣은 문단은 짝 없음 · 표 칸은 같은 자리 · offset·범위 옮김 · 같은 목록이면 null — {r}')


def shot31(pg, name):
    """v0.3.1 새 화면(§9.7) 스크린숏 — tests/out/v031_studio_<name>.png"""
    pg.screenshot(path=f'{OUT}/v031_studio_{name}.png')
    print(f'    → tests/out/v031_studio_{name}.png', flush=True)


def v031_jobs(pa, tmp):
    """[12] v0.3.1(docs/V3_SPEC.md §9.6·§9.7) 편집기에서 AI 작업 한 번에: 우클릭 'AI 작업 메모 ▸ 남은 제안 모두 반영(n)'([해결] 없음) →
    편집기에 한 번에(트랜잭션 하나) → 해결(강조·레일 카드 숨김) → Ctrl+Z 한 번에 모두 빠짐(카드 다시 남음) → 레일 [모두 반영 (n)] 다시 →
    내 반영을 결과 창에서 [거절]하면 편집기에서도 빠짐(먼저 되돌리고 거절)"""
    admin = USERS[0]['token']
    print('[12] v0.3.1 AI 작업 한 번에(편집기): 우클릭 남은 제안 모두 반영(n) → Ctrl+Z 한 번 → [모두 반영] 다시 → 내 반영 거절은 편집기에서도 빠짐', flush=True)
    built = node_helper(['build', '--out', os.path.join(tmp, 'jobs_studio.hwpx')])
    P = {x['ref']: x['text'] for x in built['paragraphs']}
    dj = upload(built['out'], '요청단위_편집기.hwpx', token=admin)['id']
    edits = {'s0/p3': ('적습니다', '적음'), 's0/p4': ('12월까지입니다', '12월까지임'), 's0/p5': ('1억 원입니다', '1억 원임')}
    rid, pids = ai_job(dj, A['token'], 's0/p3', P['s0/p3'], [{'ref': r, 'find': a, 'replace': b, 'reason': '끝맺음(시험)'} for r, (a, b) in edits.items()],
                       insert={'after': 's0/p6', 'text': '보완 문단을 덧붙입니다(시험).'})
    pid_of = {}
    for x in rest(f'/api/docs/{dj}/proposals'):
        if x.get('rid') == rid:
            pid_of[x['ref'] if (x.get('type') or 'replace') == 'replace' else 'insert'] = x['pid']
    ok(len(pids) == 4 and len(pid_of) == 4, f'AI 작업 #{rid}: 제안 4건(바꿈 3 · 문단 추가 1)')
    mid = rest(f'/api/docs/{dj}/requests/{rid}')['memoId']
    want = {r: P[r].replace(a, b, 1) for r, (a, b) in edits.items()}

    def texts_are(m):
        return all(cw(pa, f"cw.debug.text('{r}')") == t for r, t in m.items())
    open_doc(pa, dj)
    fa = editor_frame(pa)
    rc = pa.locator(f'[data-testid="rail"] .rcard.k-request[data-id="{mid}"]')
    wait_until(lambda: rc.count() == 1 and '제안 4건 — 남음 4' in rc.inner_text(), timeout=20, msg='레일 AI 작업 카드 진행 줄')
    ok(True, f'레일 AI 작업 카드 진행 줄 「제안 4건 — 남음 4」 · 요청 메모 {mid}')
    # 옛 편집기 빌드(플러그인에 applyBatch 없음): '읽기 전용'이 아니라 다시 빌드 안내 · 편집기 글·서버는 그대로
    old = pa.evaluate('''async (rid) => {
      const cw = window.__doc.editor.frame().contentWindow.rhwpCowork; const keep = cw.applyBatch; cw.applyBatch = undefined;
      let out;
      try { out = await window.__doc.resolveRequest(rid, 'adopt'); } finally { cw.applyBatch = keep; }
      const { toasts } = await import('/util.js');
      return { out, msg: toasts.value.map((t) => t.msg).find((t) => t.includes('build:studio')) || null };
    }''', rid)
    ok(old['out'] is None and old['msg'] and '읽기 전용' not in old['msg'] and texts_are({r: P[r] for r in want})
       and rest(f'/api/docs/{dj}/requests/{rid}')['outcome']['open'] == 4, f"옛 편집기 빌드 → 다시 빌드 안내 「{(old['msg'] or '')[:40]}…」 · 아무것도 바꾸지 않음")
    # 우클릭(요청 메모 자리 — 대상 문단 s0/p3) → 검토 구역 'AI 작업 #n' ▸ 보기 · 답글 · 남은 제안 모두 반영(4) — [해결] 없음
    po = point(pa, 's0/p3', 2)
    pa.mouse.click(po['x'], po['y'], button='right')
    msub = f'[data-cowork-sub="rv-memo:{mid}"]'
    fa.wait_for_selector(f'.context-menu {msub}', timeout=5000)
    fa.hover(msub)
    item = f'.context-menu {msub} [data-cowork-action="request-adopt-all"]'
    fa.wait_for_selector(item, timeout=3000)
    acts = fa.evaluate(f"() => [...document.querySelectorAll('.context-menu {msub} [data-cowork-action]')].map((e) => e.dataset.coworkAction)")
    ok('모두 반영 (4)' in fa.locator(item).inner_text() and acts == ['memo-show', 'memo-reply', 'request-adopt-all'],
       f"우클릭 AI 작업 메모 ▸ {acts}(보기 · 답글 · 모두 반영 (4) — [완료] 없음)")
    shot31(pa, 'menu_adopt_all')
    fa.click(item)
    wait_until(lambda: texts_are(want), timeout=15, msg='편집기에 한 번에')
    wait_until(lambda: any(x.get('afterRef') == 's0/p6' and '보완 문단' in x.get('text', '') for x in (store(pa, 's.draft.inserted') or [])), timeout=8, msg='넣은 문단')
    ok(True, '남은 제안 모두 반영(4) → 편집기에 바꿈 3 + 문단 추가 1(한 번에)')
    wait_until(lambda: rest(f'/api/docs/{dj}/requests/{rid}')['outcome']['resolved'] is True, timeout=15, msg='서버: 요청 해결')
    t_ad = wait_until(lambda: next((x for x in pa.locator('.toasts .toast').all_inner_texts() if f'AI 작업 #{rid}: 4건을 내 수정본에 반영했습니다' in x), None), timeout=10, msg='알림')
    time.sleep(0.5)
    n_t = sum(1 for x in pa.locator('.toasts .toast').all_inner_texts() if f'AI 작업 #{rid}: 4건을' in x)
    ok('Ctrl+Z 한 번' in t_ad and n_t == 1, f'알림 하나 「{t_ad}」(같은 알림 {n_t}개)')
    wait_until(lambda: rc.count() == 0, timeout=15, msg='해결 → 레일 카드 숨김')
    wait_until(lambda: not [x for x in overlays(pa) if x['kind'] in ('memo', 'request') and x['id'] == str(mid)], timeout=10, msg='요청 메모 강조 숨김')
    ok(not [x for x in overlays(pa) if x['kind'] == 'proposal' and x['id'] in {str(p) for p in pids}], '해결 → 레일 카드·요청 메모 강조·제안 강조가 모두 숨음')
    shot31(pa, 'adopted_all')

    # Ctrl+Z 한 번 → 넣은 것이 모두 빠짐(트랜잭션 하나) → 카드 다시 남음(남음 4)
    q = point(pa, 's0/p1', 2)
    pa.mouse.click(q['x'], q['y'])   # 키 입력이 편집기로 가게(캐럿만)
    pa.keyboard.press('Control+z')
    wait_until(lambda: texts_are({r: P[r] for r in want}), timeout=8, msg='Ctrl+Z 한 번 → 바꿈 모두 빠짐')
    wait_until(lambda: not store(pa, 's.draft.inserted'), timeout=8, msg='넣은 문단도 빠짐')
    ok(True, 'Ctrl+Z 한 번 → 바꿈 3 · 문단 추가 1 모두 빠짐')
    wait_until(lambda: rc.count() == 1 and '남음 4' in rc.inner_text(), timeout=15, msg='카드 다시 남음')
    ok(rc.locator('.ra-adopt').inner_text().strip() == '모두 반영 (4)', '되돌리면 카드가 다시 남음(내 반영이 편집기에 없음 → 남음 4 · [모두 반영 (4)])')
    shot31(pa, 'undo_back')
    # 되돌린 수정본이 저장되어(기준과 같아져) 지워질 때까지 — 그다음 레일 [모두 반영 (4)]
    wait_until(lambda: rest(f'/api/docs/{dj}/drafts/mine')['cr'] is None and not store(pa, 's.draft.dirty'), timeout=20, msg='되돌린 수정본 저장')
    rc.locator('.ra-adopt').click()
    wait_until(lambda: texts_are(want), timeout=15, msg='다시 [모두 반영]')
    wait_until(lambda: rest(f'/api/docs/{dj}/requests/{rid}')['outcome']['resolved'] is True, timeout=15, msg='다시 해결')
    wait_until(lambda: rc.count() == 0, timeout=15, msg='카드 다시 숨김')
    ok(True, '레일 [모두 반영 (4)] → 다시 모두 들어감 → 해결(카드 숨김)')
    wait_until(lambda: re.fullmatch(r'수정 4문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='자동 저장')
    mine = rest(f'/api/docs/{dj}/drafts/mine')['cr']
    pp = [x for x in rest(f'/api/docs/{dj}/proposals') if x.get('rid') == rid]
    ok(mine and all(((x.get('adoptedBy') or {}).get(A['name']) or {}).get('cid') == mine['cid'] for x in pp), f"반영 기록 4건 = 내 변경 요청 #{mine and mine['cid']}")

    # 결과 창 '반영한 제안'의 내 반영(s0/p5)을 [거절] → 편집기에서 먼저 되돌리고 거절
    pa.evaluate('(r) => { const s = window.__doc.s; s.tab = "ai"; s.activeRid = r; }', rid)
    acc = pa.locator(f'.tab-ai .result-card .rs-accepted [data-pid="{pid_of["s0/p5"]}"]')
    wait_until(lambda: acc.count() == 1 and acc.locator('.adopted').count() == 1, timeout=10, msg="결과 창 '반영한 제안'")
    # 결과 창은 상태 칩이 '완료'를 말하므로 끝난 줄은 수만(docs/UI_TERMS.md §1-2)
    ok(pa.locator('.tab-ai .result-card .req-actions .ra-done').inner_text().strip() == '반영 4' and pa.locator('.tab-ai .result-card .rs-head .req-st').inner_text().strip() == '완료', '결과 창 위: 칩 완료 · 반영 4')
    acc.locator('.rs-reject').click()
    wait_until(lambda: cw(pa, "cw.debug.text('s0/p5')") == P['s0/p5'], timeout=10, msg='편집기에서 되돌림')
    wait_until(lambda: next(x for x in rest(f'/api/docs/{dj}/proposals') if x['pid'] == pid_of['s0/p5'])['status'] == 'rejected', timeout=10, msg='거절')
    ok(texts_are({r: want[r] for r in ('s0/p3', 's0/p4')}), '내 반영(s0/p5)을 [거절] → 편집기에서도 빠짐 · 다른 반영은 그대로')
    g = rest(f'/api/docs/{dj}/requests/{rid}')['outcome']
    ok(g['accepted'] == 3 and g['declined'] == 1 and g['resolved'] is True, f"서버: 반영 {g['accepted']} · 거절 {g['declined']} · 해결")
    dec = pa.locator('.tab-ai .result-card .rs-declined')
    wait_until(lambda: dec.count() == 1 and '거절 1건' in dec.locator('summary').inner_text(), timeout=10, msg="결과 창 접힌 '거절 1건'")
    ok(pa.locator('.tab-ai .result-card .rs-log').count() == 1, "결과 창 맨 아래 접힌 '기록'")
    shot31(pa, 'reject_adopted')
    pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
    wait_until(lambda: rest(f'/api/docs/{dj}/drafts/mine')['cr'] is None and chip_text(pa) == '수정 없음', timeout=20, msg='정리')



def shot4(pg, name):
    """v0.4 새 화면(docs/V4_SPEC.md §7) 스크린숏 — tests/out/v04_<name>.png"""
    pg.screenshot(path=f'{OUT}/v04_{name}.png')
    print(f'    → tests/out/v04_{name}.png', flush=True)


def v04_live(context, tmp, errors):
    """[13] v0.4(docs/V4_SPEC.md §2·§3·§5·§7) 실시간 공동 편집 — 보기 '간단히'(기본)의 A(문서를 올린 사람)·B와 수정 권한을 뺄 C:
    ⚙ 문서 설정으로 승인 → 실시간(B 편집기도 따라 바뀜) → A 가 친 글이 B 편집기에 2초 안에(다시 열지 않음 — 스크롤·캐럿 그대로, 그 사람 색 밑줄) →
    B 가 치는 동안 A 글은 B 가 손을 멈춘 뒤(B 글도 남음) → 같은 문단 동시 편집 합침 → A 의 Ctrl+Z 는 A 글만 → 보내기 실패 칩 [다시] →
    '지정한 사람'에서 뺀 C 는 그 자리에서 읽기 전용(메모·AI 요청은 됨, 남의 고침은 따라감) → 표가 들어오면(맞추지 못함) 조용히 다시 열기(캐럿 되살림) →
    한글로 저장 설정(변경 추적 포함) → 승인 방식으로 되돌리면 편집기도"""
    print('[13] v0.4 실시간 공동 편집: 문서 설정 → 실시간 · A↔B 따라가기 · 치는 동안 기다림 · 같은 문단 합침 · Ctrl+Z · 보내기 실패 · 읽기 전용 C · 표 → 다시 열기 · 한글로 저장', flush=True)
    built = node_helper(['build', '--out', os.path.join(tmp, 'live_doc.hwpx')])
    P = {x['ref']: x['text'] for x in built['paragraphs']}
    dl = upload(built['out'], '실시간문서.hwpx', token=A['token'])['id']   # A = 올린 사람(문서 설정 권한)
    inf = rest(f'/api/docs/{dl}', token=A['token'])
    ok(inf['settings']['editMode'] == 'review' and inf['canConfigure'] is True and inf['canEdit'] is True and rest(f'/api/docs/{dl}', token=B['token'])['canConfigure'] is False,
       "새 문서 = 승인 방식(시험 config documents.defaultEditMode) · 올린 사람 A 만 설정 권한")

    def text(pg, ref):
        return cw(pg, 'cw.debug.text(arg)', ref)

    def mode(pg):
        return store(pg, 's.editor && s.editor.ready ? s.editor.mode : null')

    def scroll_top(pg):
        return pg.evaluate(f"() => {FRAME_JS}.contentDocument.getElementById('scroll-container').scrollTop")

    def caret(pg):
        return store(pg, 's.sel && s.sel.collapsed ? [s.sel.ref, s.sel.start] : null')

    ctxA, la = context(A, 'LA', view=None)
    ctxB, lb = context(B, 'LB', view=None)
    open_doc(la, dl)
    open_doc(lb, dl)

    print('[13a] ⚙ 문서 설정(올린 사람만) → 실시간 수정 → 두 편집기 모두 실시간으로(B 는 알림)', flush=True)
    tabs = la.evaluate("() => [...document.querySelectorAll('.panel .tabs [role=tab]')].map((b) => b.dataset.tab)")
    # 2026-11-04 낡은 기대값 고침: 간단히 보기 탭은 web/view.js panelTabIds = ['ai', 'review'](+진행 중 변경 요청 'cr') — ui_collab.py 와 같다.
    # (이 단계는 앞 [8] 이 편집기 다시 열기 무한 반복으로 시간 초과해 그동안 돌지 않았다)
    ok(store(la, 's.view') == 'simple' and mode(la) == 'review' and tabs == ['ai', 'review'],
       f"보기 기본 = 간단히 · 승인 방식 편집기 · 탭 {tabs}(변경 요청·변경 추적 없음)")
    flt = [x.split()[0] for x in la.locator('.rt-filters .chip').all_inner_texts()]
    ok(flt == ['전체', '메모', 'AI', '완료'], f'간단히 검토 탭 거르기 {flt}')
    ok(la.locator('[data-testid="doc-settings"]').count() == 1 and lb.locator('[data-testid="doc-settings"]').count() == 0, '⚙ 문서 설정 단추 = 올린 사람(A)에게만')
    la.click('[data-testid="doc-settings"]')
    dlg = la.locator('[data-testid="settings-dialog"]')
    dlg.wait_for(timeout=5000)
    labels = [x.strip() for x in dlg.locator('.ds-label .ds-name').all_inner_texts()]
    ok(labels == ['편집 방식', '수정 권한', '실시간 기록', '한글로 저장', 'AI 메모', 'AI에게 빠르게 맡기기', 'AI 자동 반영'] and la.locator('[data-testid="settings-save"]').is_disabled(),
       f'설정 창 일곱 줄 {labels} · 바뀐 것이 없으면 [저장] 꺼짐')
    dlg.locator('[data-setting="editMode"] input[data-value="realtime"]').check()
    shot4(la, 'settings_dialog')
    la.click('[data-testid="settings-save"]')
    wait_until(lambda: dlg.count() == 0, timeout=10, msg='설정 창 닫힘')
    wait_until(lambda: mode(la) == 'live' and mode(lb) == 'live', timeout=30, msg='두 편집기 실시간')
    ok(rest(f'/api/docs/{dl}')['settings']['editMode'] == 'realtime', '서버 문서 설정 = 실시간 수정(PATCH /settings)')
    tb = wait_until(lambda: next((t for t in lb.locator('.toasts .toast').all_inner_texts() if '문서 설정을 바꿨습니다' in t), None), timeout=10, msg='B 알림')
    ok(tb.startswith(f"{A['name']} 님이 문서 설정을 바꿨습니다") and '실시간 수정' in tb, f'B: 실시간 편집기로 바뀜 · 알림 「{tb}」')
    wait_until(lambda: chip_text(la).startswith('실시간 · 저장됨') and chip_text(lb).startswith('실시간 · 저장됨'), timeout=10, msg='실시간 칩')
    tip = la.locator('[data-testid="draft-chip"]').get_attribute('title') or ''
    ok('Ctrl+Z' in tip and '1~2초' in tip and la.locator('[data-testid="submit-cr"]').count() == 0 and la.locator('[data-testid="behind-chip"]').count() == 0,
       f"상단 칩 「{chip_text(la)}」(설명에 Ctrl+Z 는 내 글만) · [검토 요청]·최신 반영 칩 없음")

    print('[13b] A 가 치면 B 편집기에 2초 안에 — 다시 열지 않음(스크롤·캐럿 그대로) · A 색 밑줄 깜빡임', flush=True)
    type_at(lb, 's0/p6', 3)
    lb.evaluate(f"() => {{ {FRAME_JS}.contentDocument.getElementById('scroll-container').scrollTop = 90; }}")
    time.sleep(0.4)
    sc0 = scroll_top(lb)
    sel0 = wait_until(lambda: caret(lb), timeout=5, msg='B 캐럿')
    opens0 = store(lb, 's.editor.opens'); syncs0 = store(lb, 's.live.syncs')
    ADD3 = ' 에이 실시간'
    want3 = P['s0/p3'] + ADD3
    type_at(la, 's0/p3', len(cps(P['s0/p3'])), ADD3)
    t0 = time.time()
    wait_until(lambda: text(lb, 's0/p3') == want3, timeout=8, step=0.05, msg='B 편집기에 A 글')
    dt = time.time() - t0
    flash = wait_until(lambda: lb.evaluate(f"() => {{ const e = {FRAME_JS}.contentDocument.querySelector('.cw-rflash'); return e ? (e.style.getPropertyValue('--cw-person') || '-') : null; }}"), timeout=3, step=0.05, msg='밑줄 깜빡임')
    colA = store(lb, f"d.colorOf({json.dumps(A['name'])})")
    sel1 = caret(lb)
    ok(dt <= 2.5, f'A 가 친 글이 B 편집기에 {dt:.2f}초 만에(쉼 0.8초 → 밀어 넣기 → WS → 맞추기)')
    ok(store(lb, 's.editor.opens') == opens0 and store(lb, 's.live.syncs') > syncs0 and scroll_top(lb) == sc0 and sel1 == sel0,
       f"다시 열지 않음(열기 횟수 그대로 · 맞추기 {store(lb, 's.live.syncs') - syncs0}번) · B 스크롤 {sc0}px 그대로 · B 캐럿 {sel0} 그대로")
    ok(flash.strip().lower() == colA.lower(), f'B 편집기: 바뀐 문단에 A 색({colA}) 밑줄 깜빡임')
    ok(para_text(dl, 's0/p3') == want3 and re.fullmatch(r'실시간 · 저장됨 \d\d:\d\d', chip_text(la)), f"공유 문서(서버)에 곧바로 — 승인 없음 · A 칩 「{chip_text(la)}」")
    shot4(lb, 'live_B_follows_A')

    print('[13c] B 가 다른 문단을 치는 동안 A 글은 기다렸다가(B 가 손을 멈춘 뒤) 들어옴 — B 가 친 글도 남음', flush=True)
    n5 = len(cps(P['s0/p5'])); n2 = len(cps(P['s0/p2']))
    type_at(lb, 's0/p5', n5, ' 비')
    type_at(la, 's0/p2', n2, ' 에이둘')
    want2 = P['s0/p2'] + ' 에이둘'
    held = True; seen_server = False
    for k in range(12):
        lb.keyboard.type('가')
        if k >= 5:
            seen_server = seen_server or para_text(dl, 's0/p2') == want2
            if text(lb, 's0/p2') != P['s0/p2']:
                held = False
        time.sleep(0.25)
    ok(held and seen_server, 'B 가 치는 동안(쉼 0.7초 미만)에는 B 편집기에 A 글이 들어오지 않음(서버에는 이미 있음 — 맞춤 대기)')
    t1 = time.time()
    wait_until(lambda: text(lb, 's0/p2') == want2, timeout=8, step=0.05, msg='B 가 손을 멈춘 뒤')
    dt1 = time.time() - t1
    want5 = P['s0/p5'] + ' 비' + '가' * 12
    ok(dt1 <= 2.5 and text(lb, 's0/p5') == want5, f'B 가 손을 멈추고 {dt1:.2f}초 만에 A 글 · B 가 친 글 「…{want5[-8:]}」 그대로')
    wait_until(lambda: para_text(dl, 's0/p5') == want5 and text(la, 's0/p5') == want5, timeout=10, msg='A 편집기에 B 글')
    ok(True, 'B 글도 공유 문서와 A 편집기에')

    print('[13d] 같은 문단 동시 편집 — 3-way 합침(A 는 앞, B 는 끝)', flush=True)
    t4 = P['s0/p4']
    type_at(la, 's0/p4', 0)
    type_at(lb, 's0/p4', len(cps(t4)))
    la.keyboard.type('[A]')
    lb.keyboard.type('[B]')
    want4 = '[A]' + t4 + '[B]'
    wait_until(lambda: text(la, 's0/p4') == want4 and text(lb, 's0/p4') == want4 and para_text(dl, 's0/p4') == want4, timeout=15, msg='같은 문단 합침')
    ok(True, f'같은 문단 동시 편집 → 두 편집기·서버 모두 「{want4[:6]}…{want4[-6:]}」(글자 단위 3-way 합침)')
    shot4(la, 'live_A_merged')

    print("[13e] A 의 Ctrl+Z 는 A 글만 — 남의 글이 들어온 뒤의 되돌리기 기록만 남는다", flush=True)
    ADD6 = ' 지울글'
    want6 = text(la, 's0/p6') + ADD6
    type_at(la, 's0/p6', len(cps(text(la, 's0/p6'))), ADD6)
    wait_until(lambda: para_text(dl, 's0/p6') == want6 and text(lb, 's0/p6') == want6, timeout=10, msg='지울글 공유')
    la.keyboard.press('Control+z')
    wait_until(lambda: text(la, 's0/p6') == P['s0/p6'], timeout=6, msg='A Ctrl+Z')
    time.sleep(0.5)
    la.keyboard.press('Control+z')   # 그 앞의 기록은 남의 글이 들어올 때 비었다 — [A]·A 의 앞 글을 되돌리지 않는다
    wait_until(lambda: para_text(dl, 's0/p6') == P['s0/p6'] and text(lb, 's0/p6') == P['s0/p6'], timeout=10, msg='되돌림 공유')
    time.sleep(1.2)
    ok(text(la, 's0/p4') == want4 and para_text(dl, 's0/p4') == want4 and text(la, 's0/p3') == want3 and text(lb, 's0/p4') == want4,
       'A Ctrl+Z → A 가 친 「 지울글」만 빠짐(B 편집기·서버도) · 한 번 더 Ctrl+Z 해도 [B]·[A]·앞서 친 글은 그대로(남의 고침을 맞추며 되돌리기 기록을 비움)')

    print('[13f] 보내기 실패 → 칩 「보내지 못함 — [다시]」 → [다시] → 저장됨', flush=True)
    pat = re.compile(r'/api/docs/[^/]+/live\?')
    la.route(pat, lambda route: route.abort())
    n_err = len(errors)
    ADD7 = ' 안감'
    type_at(la, 's0/p7', len(cps(text(la, 's0/p7'))), ADD7)
    wait_until(lambda: chip_text(la).startswith('보내지 못함') and la.locator('[data-testid="chip-retry"]').count() == 1, timeout=10, msg='보내지 못함 칩')
    ok(la.locator('[data-testid="chip-retry"]').inner_text().strip() == '다시' and para_text(dl, 's0/p7') == P['s0/p7'] and text(la, 's0/p7') == P['s0/p7'] + ADD7,
       f"칩 「{chip_text(la).splitlines()[0]}」 [다시] · 이 창의 글은 그대로(서버에는 아직 없음)")
    shot4(la, 'push_failed')
    la.unroute(pat)
    la.click('[data-testid="chip-retry"]')
    wait_until(lambda: para_text(dl, 's0/p7') == P['s0/p7'] + ADD7 and chip_text(la).startswith('실시간 · 저장됨'), timeout=10, msg='[다시] → 저장됨')
    wait_until(lambda: text(lb, 's0/p7') == P['s0/p7'] + ADD7, timeout=10, msg='B 도')
    ok(True, '[다시] → 보냄 · 칩 저장됨 · B 편집기에도')
    time.sleep(0.3)
    errors[n_err:] = [e for e in errors[n_err:] if 'ERR_FAILED' not in e and 'Failed to fetch' not in e]

    print('[13f2] 오래 쉰 창: 편집기 기준 기록 파일이 정리됨(409 STALE_BASE) → 저절로 [내 글 옮겨 넣기] 뒤 다시 밀어 넣기 — 글을 잃지 않음', flush=True)
    wait_until(lambda: not store(la, 's.draft.dirty') and not store(la, 's.editor.syncing') and store(la, 's.editor.baseVersion') == rest(f'/api/docs/{dl}')['version'], timeout=15, msg='A 맞춤')
    n_old = store(la, 's.editor.baseVersion')
    la.route(pat, lambda route: route.abort())
    n_err = len(errors)
    OLD = ' 오래쉼'
    type_at(la, 's0/p1', len(cps(text(la, 's0/p1'))), OLD)
    wait_until(lambda: chip_text(la).startswith('보내지 못함'), timeout=10, msg='A 보내지 못함')
    BNEW = ' 비새글'
    type_at(lb, 's0/p0', len(cps(text(lb, 's0/p0'))), BNEW)
    wait_until(lambda: para_text(dl, 's0/p0').endswith(BNEW), timeout=10, msg='B 글 공유')
    vfile = os.path.join(tmp, 'data', 'docs', dl, 'versions', f'{n_old}.hwpx')
    ok(os.path.exists(vfile) and rest(f'/api/docs/{dl}')['version'] > n_old and store(la, 's.editor.baseVersion') == n_old,
       f'A 편집기 기준 = 옛 기록(보내지 못한 글이 있어 맞추지 않고 기다림) — 그 기록 파일을 지워 정리된 것처럼(versions/{n_old}.hwpx)')
    os.remove(vfile)
    la.unroute(pat)
    la.click('[data-testid="chip-retry"]')
    t_co = wait_until(lambda: next((t for t in la.locator('.toasts .toast').all_inner_texts() if '지금 문서에 옮겨 넣었습니다' in t), None), timeout=20, msg='옮겨 넣음 알림')
    wait_until(lambda: para_text(dl, 's0/p1').endswith(OLD) and para_text(dl, 's0/p0').endswith(BNEW) and chip_text(la).startswith('실시간 · 저장됨'), timeout=20, msg='옮겨 넣고 밀어 넣음')
    wait_until(lambda: text(la, 's0/p0').endswith(BNEW) and text(lb, 's0/p1').endswith(OLD), timeout=10, msg='두 편집기')
    ok(text(la, 's0/p1').count(OLD) == 1, f"409 STALE_BASE → 저절로 지금 문서를 열고 이 창 글을 옮겨 넣은 뒤 밀어 넣음 「{t_co[:30]}…」 · A 글·B 글 모두 그대로")
    time.sleep(0.3)
    errors[n_err:] = [e for e in errors[n_err:] if 'ERR_FAILED' not in e and 'Failed to fetch' not in e and 'status of 409' not in e]

    print("[13g] 수정 권한: '지정한 사람'에서 C 를 뺌 → C 편집기는 그 자리에서 읽기 전용 · 메모·AI 요청은 됨 · 남의 고침은 따라감", flush=True)
    ctxC, lc = context(C, 'LC', view=None)
    open_doc(lc, dl)
    ok(mode(lc) == 'live', 'C(편집자 모두일 때) = 실시간 편집기')
    la.click('[data-testid="doc-settings"]')
    dlg.wait_for(timeout=5000)
    dlg.locator('[data-setting="editors"] input[data-value="some"]').check()
    ppl = dlg.locator('[data-testid="settings-people"]')
    wait_until(lambda: ppl.locator(f'input[data-person="{C["name"]}"]').count() == 1, timeout=5, msg='사람 목록')
    adm = ppl.locator(f'input[data-person="{USERS[0]["name"]}"]')
    ok(adm.is_checked() and adm.is_disabled() and ppl.locator(f'input[data-person="{A["name"]}"]').is_checked() and ppl.locator(f'input[data-person="{C["name"]}"]').is_checked(),
       "'지정한 사람' → 사람 목록(GET /api/users): 관리자는 언제나(체크·꺼짐) · 편집자는 모두 골라 둠")
    ppl.locator(f'input[data-person="{C["name"]}"]').uncheck()
    shot4(la, 'settings_people')
    la.click('[data-testid="settings-save"]')
    wait_until(lambda: rest(f'/api/docs/{dl}')['settings']['editors'] == [A['name'], B['name']], timeout=10, msg='설정 저장')
    wait_until(lambda: mode(lc) == 'follow' and store(lc, 's.readOnly'), timeout=30, msg='C 읽기 전용')
    wait_until(lambda: chip_text(lc) == '읽기 전용', timeout=10, msg='C 칩')
    ok(lc.locator('[data-testid="draft-chip"]').get_attribute('title') == '이 문서의 수정 권한이 없습니다(문서 설정). 메모·AI 요청은 됩니다' and mode(la) == 'live' and mode(lb) == 'live',
       "C: 칩 「읽기 전용」(설명 그대로) · A·B 는 그대로 실시간")
    tc = wait_until(lambda: next((t for t in lc.locator('.toasts .toast').all_inner_texts() if '문서 설정을 바꿨습니다' in t), None), timeout=10, msg='C 알림')
    ok('읽기 전용' in tc, f'C 알림 「{tc}」')
    before1 = text(lc, 's0/p1'); srv1 = para_text(dl, 's0/p1')
    type_at(lc, 's0/p1', 2, '씨글')
    time.sleep(1.5)
    ok(text(lc, 's0/p1') == before1 == srv1 and para_text(dl, 's0/p1') == srv1, '읽기 전용: C 가 쳐도 편집기 글·공유 문서 그대로(studio 양식 모드)')
    fc = editor_frame(lc)
    q1 = point(lc, 's0/p1', 3)
    lc.mouse.click(q1['x'], q1['y'], button='right')
    fc.wait_for_selector('.context-menu [data-cowork-action="memo"]', timeout=5000)
    acts = fc.evaluate("() => [...document.querySelectorAll('.context-menu [data-cowork-action]')].map((e) => e.dataset.coworkAction)")
    ok('memo' in acts and 'instruct' in acts and 'proposal-adopt' not in acts and 'request-adopt-all' not in acts, f'읽기 전용 우클릭: 메모 달기·AI에게 맡기기 있음({len(acts)}개) · 반영 항목 없음')
    fc.click('.context-menu [data-cowork-action="memo"]')
    lc.wait_for_selector('.popover textarea', timeout=5000)
    CMEMO = '읽기 전용이어도 메모는 됩니다'
    lc.fill('.popover textarea', CMEMO)
    lc.click('.popover .memoedit button.primary')
    wait_until(lambda: any(CMEMO in (m.get('text') or '') and m.get('author') == C['name'] for m in rest(f'/api/docs/{dl}/memos')), timeout=10, msg='C 메모')
    ok(True, 'C: 우클릭 메모 달기 → 서버에 메모')
    lc.mouse.click(q1['x'], q1['y'], button='right')
    fc.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
    fc.click('.context-menu [data-cowork-action="instruct"]')
    # 'AI에게 맡기기…' 는 요청 창을 연다 — 비워 두고 [보내기] = 검토
    lc.wait_for_selector('.composer-win', timeout=5000)
    lc.click('.composer-win .cmp-send')
    lc.wait_for_selector('.composer-win .result', timeout=30000)
    rqc = wait_until(lambda: next((r for r in rest(f'/api/docs/{dl}/requests') if r['by'] == C['name']), None), timeout=10, msg='C 요청')
    time.sleep(0.5)
    ok(rqc and lc.locator('.composer-win .result .rs-adopt').count() == 0 and lc.locator('.composer-win .result .rs-reject').count() == 0,
       f"C: AI 요청 → AI 작업 #{rqc['rid']}(요청은 됨) · 결과 창은 읽기만(반영·거절 단추 없음 — 수정 권한 없음)")
    lc.locator('.composer-win .fw-head button[aria-label="닫기"]').click()
    oc0 = store(lc, 's.editor.opens')
    ADD7b = ' 씨따라'
    type_at(la, 's0/p7', len(cps(text(la, 's0/p7'))), ADD7b)
    wait_until(lambda: text(lc, 's0/p7').endswith(ADD7b), timeout=10, msg='C 따라감')
    ok(store(lc, 's.editor.opens') == oc0, '읽기 전용 C 편집기도 남의 고침을 맞추기로 따라감(다시 열지 않음)')
    shot4(lc, 'readonly_C')

    print('[13h] 표가 들어옴(맞추지 못함 STRUCTURE) → 조용히 다시 열기 — 스크롤·캐럿 되살림', flush=True)
    type_at(lb, 's0/p6', 3)
    sel_b = wait_until(lambda: caret(lb), timeout=5, msg='B 캐럿')
    reopens0 = store(lb, 's.live.reopens'); opensB = store(lb, 's.editor.opens')
    t2 = para_text(dl, 's0/p2')
    r2 = rest(f'/api/docs/{dl}/requests', 'POST', {'kind': 'make_table', 'instruction': '표(시험)', 'route': 'queue', 'target': {'ref': 's0/p2', 'start': 0, 'end': len(cps(t2)), 'text': t2}}, token=A['token'])
    rid2 = r2['request']['rid']
    mcp(A['token'], 'start_request', {'doc_id': dl, 'request_id': rid2})
    mcp(A['token'], 'propose_table', {'doc_id': dl, 'request_id': rid2, 'after_ref': 's0/p2', 'rows': [['구분', '값'], ['가', '1']], 'caption': '시험 표'})
    mcp(A['token'], 'complete_request', {'doc_id': dl, 'request_id': rid2, 'summary': '표를 만듦(시험)'})
    wait_until(lambda: store(la, f's.proposals.some((p) => p.rid === {rid2} && p.status === "pending") && s.requests.some((r) => r.rid === {rid2} && r.status === "done")'), timeout=15, msg='A 표 제안')
    out = la.evaluate(f"async () => {{ const r = await window.__doc.resolveRequest({rid2}, 'adopt'); return r ? r.counts : null; }}")
    ok(out and out['applied'] == 1, f"A(요청자) [모두 반영] → 표 제안도 공유 문서에 바로(resolve apply — {out})")
    wait_until(lambda: store(lb, 's.live.reopens') > reopens0 and mode(lb) == 'live' and not store(lb, 's.editor.locked'), timeout=25, msg='B 다시 열기')
    settle(lb)
    paras_b = store(lb, 's.paragraphs')
    new_ref = next(p['ref'] for p in paras_b if '/n' not in p['ref'] and (p.get('text') or '').startswith('일곱째'))
    cell = next((p for p in paras_b if p.get('cell') and p.get('text') == '구분'), None)
    sel_b2 = wait_until(lambda: (lambda x: x if x and x[0] == new_ref else None)(store(lb, 's.sel && [s.sel.ref, s.sel.start]')), timeout=6, msg='B 캐럿 되살림')
    ok(store(lb, 's.editor.opens') == opensB + 1 and cell and text(lb, cell['ref']) == '구분' and new_ref != sel_b[0] and sel_b2 == [new_ref, sel_b[1]],
       f"맞추지 못함 → 조용히 다시 열기(한 번) · 표가 B 편집기에 · B 캐럿 {sel_b} → {sel_b2}(문단 번호가 밀려도 같은 글자 자리)")
    shot4(lb, 'reopen_table')

    print('[13i] 한글로 저장 = 문서 설정대로(변경 추적 포함 + 메모로 바꿈 → 단추 설명·파일)', flush=True)
    ok('보이는 그대로 + 메모' in (lb.locator('[data-testid="save-hangul"]').get_attribute('title') or ''), '처음: [한글로 저장] 설명 = 보이는 그대로 + 메모')
    la.click('[data-testid="doc-settings"]')
    dlg.wait_for(timeout=5000)
    dlg.locator('[data-setting="exportKind"] input[data-value="tracked"]').check()
    la.click('[data-testid="settings-save"]')
    wait_until(lambda: '변경 추적 포함 + 메모' in (lb.locator('[data-testid="save-hangul"]').get_attribute('title') or ''), timeout=10, msg='B 단추 설명')
    with lb.expect_download(timeout=30000) as dli:
        lb.locator('[data-testid="save-hangul"]').click()
    fpath = os.path.join(tmp, 'live_export.hwpx')
    dli.value.save_as(fpath)
    kinds = lb.evaluate("async () => { const { state } = await import('/util.js'); const r = await fetch(window.__doc.base + '/file?kind=export', { headers: { Authorization: 'Bearer ' + state.token } }); return r.headers.get('X-Export-Kind'); }")
    texts = memo_texts_of_file(fpath)
    ok(dli.value.suggested_filename == '실시간문서.hwpx' and kinds == 'tracked' and any(CMEMO in t for t in texts),
       f"B [한글로 저장] → {dli.value.suggested_filename}(X-Export-Kind {kinds}) · C 의 메모도 파일에(메모 {len(texts)}개)")

    print('[13j] 문서 설정 → 승인 후 반영: A·B 편집기는 승인 방식(내 수정본)으로, C 는 그대로 읽기 전용', flush=True)
    la.click('[data-testid="doc-settings"]')
    dlg.wait_for(timeout=5000)
    dlg.locator('[data-setting="editMode"] input[data-value="review"]').check()
    la.click('[data-testid="settings-save"]')
    wait_until(lambda: mode(la) == 'review' and mode(lb) == 'review' and mode(lc) == 'follow', timeout=30, msg='승인 방식')
    wait_until(lambda: chip_text(lb) == '수정 없음', timeout=10, msg='B 칩')
    ref4 = next(p['ref'] for p in store(lb, 's.paragraphs') if '/n' not in p['ref'] and (p.get('text') or '').startswith('[A]'))   # 표가 들어와 번호가 밀렸다
    ok(chip_text(lc) == '읽기 전용' and text(lb, ref4) == want4 and para_text(dl, ref4) == want4, f"승인 방식 → B 칩 「수정 없음」(내 수정본 방식) · 글 그대로({ref4}) · C 는 읽기 전용 그대로")
    shot4(lb, 'back_to_review')
    for c in (ctxA, ctxB, ctxC):
        c.close()


# [13k] 서식 문서: 사용자 회의록처럼 내용이 큰 표 하나에(본문 문단 하나 = 표, 글은 모두 칸 문단) — 내용 칸 (2,1) = s0/p1/n5..n9(빈 줄 포함)
FORM_CELL = ['□ 회의 목적', '  ㅇ 1차 설문 자료 검토', '', '□ 안건 1. 업체 납품자료 검증', 'ㅇ 납품자료 재검증 결과 공유']
FORM_JS = """// ui_studio.py [13k] 서식 문서 만들기(엔진) — node <이 파일> <나갈 파일> <칸 글 JSON 파일>
import fs from 'node:fs';
import { HwpxDoc } from '%(root)s/engine/doc.js';
import { escapeText } from '%(root)s/engine/xmlscan.js';
const [out, partsFile] = process.argv.slice(2);
const parts = JSON.parse(fs.readFileSync(partsFile, 'utf8'));
const d = await (await HwpxDoc.load(fs.readFileSync('%(fix)s'))).flattened();
d.insertTableAfter(0, 0, { rows: [['회의일시', '2026. 10. 21.(수) 11:00'], ['참석', '김민준, 이서연'], ['내용', parts[0]]] }, { author: '준비' });
d.acceptAll();
const r = await HwpxDoc.load(await d.save());
const { sec, p } = r.resolve('s0/p1/n5');
const xml = sec.xml.slice(p.start, p.end);
const open = /^<hp:p\\b[^>]*>/.exec(xml)[0];
const charPr = /<hp:run\\b[^>]*?charPrIDRef="([^"]*)"/.exec(xml)[1];
const paras = parts.map((t) => `${open}<hp:run charPrIDRef="${charPr}">${t ? `<hp:t>${escapeText(t)}</hp:t>` : ''}</hp:run></hp:p>`).join('');
sec.load(sec.xml.slice(0, p.start) + paras + sec.xml.slice(p.end));
fs.writeFileSync(out, Buffer.from(await r.save()));
"""


def build_form_doc(tmp):
    """서식 문서 HWPX 를 tmp 에 만든다(엔진 — 칸 안 문단은 구역 XML 로 나눔) → 파일 경로"""
    js = os.path.join(tmp, 'build_form.mjs'); parts = os.path.join(tmp, 'form_cell.json'); out = os.path.join(tmp, 'form_doc.hwpx')
    with open(js, 'w', encoding='utf-8', newline='') as f:
        f.write(FORM_JS % {'root': 'file:///' + ROOT, 'fix': FIX})
    with open(parts, 'w', encoding='utf-8', newline='') as f:
        json.dump(FORM_CELL, f, ensure_ascii=False)
    r = subprocess.run(['node', js, out, parts], cwd=ROOT, capture_output=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f'서식 문서를 만들지 못함: {r.stderr.decode("utf-8", "replace")[:400]}')
    return out


def v04_cell_enter(context, tmp, errors):
    """[13k] 실시간 문서 표 칸 안 Enter·Backspace(V4 §2.2·§2.5 — 사용자 회의록처럼 내용이 큰 표 칸 하나에): A 가 칸 안에서 Enter 하고 이어 치면
    공유 문서에는 그 칸 문단에 줄바꿈으로 들어가고(칸 문단 수 그대로), A 편집기는 다시 열지 않고 접어 맞춘다(캐럿 그 글자 자리 — 이어 친 글이 표 밖으로
    가지 않음) · B 편집기도 같은 글 · Enter 여러 번·맨 앞 Enter · 같은 칸 다른 줄을 B 가 동시에 고쳐도 둘 다 · Backspace 로 칸 문단 합침(빈 문단 남음) ·
    가만히 두면 더 바뀌지 않음(되풀이·깜빡임 없음)"""
    print('[13k] 실시간 표 칸 안 Enter·Backspace: 줄바꿈으로 공유 · 다시 열지 않음 · 캐럿 그 자리 · B 도 같은 글 · 같은 칸 동시 편집 · 되풀이 없음', flush=True)
    did = upload(build_form_doc(tmp), '회의록서식.hwpx', token=A['token'])['id']
    rest(f'/api/docs/{did}/settings', 'PATCH', {'editMode': 'realtime'}, token=A['token'])
    base = {p['ref']: p['text'] for p in rest(f'/api/docs/{did}/paragraphs')}
    ok([base[f's0/p1/n{k}'] for k in range(5, 10)] == FORM_CELL and base['s0/p1'] == '', f'(전제) 서식 문서: 본문 s0/p1 = 표, 내용 칸 (2,1) = s0/p1/n5..n9(빈 줄 포함)')

    def text(pg, ref):
        return cw(pg, 'cw.debug.text(arg)', ref)

    def counts(pg):
        return store(pg, '[s.editor.opens, s.live.reopens, s.live.syncs]')

    def caret(pg):
        return store(pg, 's.sel && s.sel.collapsed ? [s.sel.ref, s.sel.start] : null')

    def caret_at(pg, want):
        """맞춘 뒤 선택(호스트 s.sel — 플러그인이 짧은 쉼 뒤 selection 이벤트로 알림)이 want 가 될 때까지(5초) → (마지막 값, 편집기 캐럿 그대로)"""
        try:
            wait_until(lambda: caret(pg) == want, timeout=5, step=0.1, msg='캐럿')
        except AssertionError:
            pass
        raw = (cw(pg, 'cw.debug.stats()').get('editor') or {}).get('caret') or {}
        return caret(pg), {k: raw.get(k) for k in ('parentParaIndex', 'cellIndex', 'cellParaIndex', 'charOffset')}

    srv = lambda ref: para_text(did, ref)  # noqa: E731
    ctxA, la = context(A, 'KA', view=None)
    ctxB, lb = context(B, 'KB', view=None)
    open_doc(la, did)
    open_doc(lb, did)
    wait_until(lambda: store(la, 's.editor.ready && s.editor.mode') == 'live' and store(lb, 's.editor.ready && s.editor.mode') == 'live', timeout=30, msg='두 편집기 실시간')
    n6 = 's0/p1/n6'; t6 = FORM_CELL[1]
    ca0 = counts(la); cb0 = counts(lb)
    # 1) 칸 둘째 문단 끝에서 Enter + 이어 침
    type_at(la, n6, len(cps(t6)))
    la.keyboard.press('Enter')
    la.keyboard.type('새 줄 글')
    want = t6 + '\n새 줄 글'
    wait_until(lambda: srv(n6) == want, timeout=10, msg='공유 문서에 줄바꿈 글')
    wait_until(lambda: text(lb, n6) == want, timeout=10, msg='B 편집기')
    wait_until(lambda: counts(la)[2] > ca0[2] and text(la, n6) == want and not store(la, 's.draft.dirty'), timeout=15, msg='A 맞춤(접기)')
    ca1 = counts(la)
    nested = [p for p in rest(f'/api/docs/{did}/paragraphs') if p.get('cell') and p['cell']['row'] == 2 and p['cell']['col'] == 1]
    ok(len(nested) == len(FORM_CELL) and [p['text'] for p in nested][1] == want,
       f'칸 안 Enter + 이어 친 글 → 공유 문서는 칸 문단 수 그대로({len(nested)}) · 그 문단에 줄바꿈 「{want.replace(chr(10), "⏎")}」')
    ok(ca1[:2] == ca0[:2] and counts(lb)[:2] == cb0[:2], f'A·B 편집기 모두 다시 열지 않음(열기·다시 열기 {ca0[:2]} → {ca1[:2]}, 맞추기 {ca1[2] - ca0[2]}번)')
    sel1, raw1 = caret_at(la, [n6, len(cps(want))])
    ok(sel1 == [n6, len(cps(want))] and raw1['cellParaIndex'] == 1 and raw1['charOffset'] == len(cps(want)),
       f'A 캐럿 = 접힌 문단 안 친 글 끝 {sel1}(편집기 {raw1} — 칸 둘째 문단, 표 밖으로 가지 않음)')
    la.keyboard.type('[이어]')
    want = want + '[이어]'
    wait_until(lambda: srv(n6) == want and text(lb, n6) == want, timeout=10, msg='이어 친 글')
    ok(srv('s0/p1') == '' and srv('s0/p1/n7') == '', '이어 친 글도 그 칸 그 자리에(표 밖 본문 문단·다음 빈 줄은 그대로)')
    shot4(la, 'cell_enter_A')
    # 2) Enter 여러 번 + 맨 앞 Enter(빈 줄을 그 문단 앞에)
    for k in range(3):
        la.keyboard.press('Enter'); la.keyboard.type(f'줄{k}')
        time.sleep(0.4)
    want = want + '\n줄0\n줄1\n줄2'
    wait_until(lambda: srv(n6) == want and text(la, n6) == want and text(lb, n6) == want, timeout=15, msg='Enter 여러 번')
    n8 = 's0/p1/n8'; t8 = FORM_CELL[3]
    type_at(la, n8, 0)
    la.keyboard.press('Enter')
    la.keyboard.type('앞줄')
    want8 = '\n앞줄' + t8
    wait_until(lambda: srv(n8) == want8 and text(la, n8) == want8 and text(lb, n8) == want8, timeout=15, msg='맨 앞 Enter')
    wait_until(lambda: not store(la, 's.draft.dirty') and not store(la, 's.editor.syncing'), timeout=10, msg='A 맞춤')
    sel2, raw2 = caret_at(la, [n8, 3])
    ok(srv('s0/p1/n7') == '' and counts(la)[:2] == ca0[:2] and sel2 == [n8, 3],
       f'Enter 여러 번 → 「…⏎줄0⏎줄1⏎줄2」 · 맨 앞 Enter → 「⏎앞줄…」(빈 줄은 그 문단 앞 · 앞 빈 줄 그대로) · 다시 열지 않음 · 캐럿 {sel2}(편집기 {raw2})')
    # 3) 같은 칸의 다른 줄을 B 가 동시에 고침 — A 는 Enter 하고 침
    n9 = 's0/p1/n9'; t9 = FORM_CELL[4]; n5 = 's0/p1/n5'; t5 = FORM_CELL[0]
    type_at(lb, n5, len(cps(t5)))
    type_at(la, n9, len(cps(t9)))
    cb1 = counts(lb)
    la.keyboard.press('Enter'); la.keyboard.type('에이')
    lb.keyboard.type('(비)')
    want9 = t9 + '\n에이'; want5 = t5 + '(비)'
    wait_until(lambda: srv(n9) == want9 and srv(n5) == want5, timeout=15, msg='둘 다 공유 문서에')
    wait_until(lambda: text(la, n5) == want5 and text(la, n9) == want9 and text(lb, n9) == want9 and text(lb, n5) == want5, timeout=15, msg='두 편집기 같은 글')
    wait_until(lambda: not store(la, 's.draft.dirty') and not store(la, 's.editor.syncing') and caret(la) == [n9, len(cps(want9))], timeout=10, msg='A 캐럿')
    ok(counts(la)[:2] == ca0[:2] and counts(lb)[:2] == cb1[:2], f'같은 칸 다른 줄 동시 편집 → 둘 다 남음 · 다시 열지 않음 · A 캐럿 그 자리 {caret(la)}')
    # 4) Backspace 로 칸 문단 합침(n9 맨 앞 → n8 과) — 공유 문서는 앞 문단에 합친 글 + 빈 문단(칸 문단 수 그대로), A 편집기도 빈 문단을 되살려 맞춤
    type_at(la, n9, 0)
    la.keyboard.press('Backspace')
    merged = want8 + want9
    wait_until(lambda: srv(n8) == merged and srv(n9) == '', timeout=15, msg='합친 글')
    wait_until(lambda: text(la, n8) == merged and text(la, n9) == '' and text(lb, n8) == merged and text(lb, n9) == '', timeout=15, msg='두 편집기 합친 글')
    wait_until(lambda: not store(la, 's.draft.dirty') and not store(la, 's.editor.syncing') and caret(la) == [n8, len(cps(want8))], timeout=10, msg='A 캐럿(합친 자리)')
    la.keyboard.type('@')
    wait_until(lambda: srv(n8) == want8 + '@' + want9, timeout=10, msg='합친 자리에 친 글')
    ok(counts(la)[:2] == ca0[:2], f'Backspace 합침 → 앞 문단에 합친 글 · 뒤 문단은 빈 문단 · 다시 열지 않음 · 합친 자리에 이어 친 「@」')
    # 5) 가만히 두면 더 바뀌지 않는다(되풀이·깜빡임 없음)
    wait_until(lambda: not store(la, 's.draft.dirty') and not store(lb, 's.draft.dirty'), timeout=10, msg='쉼')
    v0 = rest(f'/api/docs/{did}')['version']; ca2 = counts(la); cb2 = counts(lb)
    time.sleep(4)
    ok(rest(f'/api/docs/{did}')['version'] == v0 and counts(la) == ca2 and counts(lb) == cb2, f'가만히 4초 → 기록·맞추기·다시 열기 그대로(판 {v0})')
    # 공유 문서 파일: 줄바꿈 글은 같은 문단 안 <hp:lineBreak/>(한글·편집기가 줄바꿈으로 읽음) · 칸 문단 수 그대로
    with zipfile.ZipFile(io.BytesIO(rest(f'/api/docs/{did}/file?kind=final'))) as z:
        sx = z.read('Contents/section0.xml').decode('utf-8')
    ok(sx.count('<hp:lineBreak/>') >= 6 and '줄0<hp:lineBreak/>줄1' in sx and '검토<hp:lineBreak/>새 줄 글' in sx,
       f"공유 문서 XML: 줄바꿈 = <hp:lineBreak/>({sx.count('<hp:lineBreak/>')}개)")
    shot4(lb, 'cell_enter_B')
    for c in (ctxA, ctxB):
        c.close()


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx_ui_studio_')
    srv = log = None
    errors = []
    try:
        srv, log, conf = start_server(tmp)
        st = conf.get('studio') or {}
        print(f'server up v{conf.get("version")} port {PORT} aiMock={conf.get("aiMock")} studio={st.get("mode")} built={st.get("built")}', flush=True)
        ok(st.get('built') and conf.get('studioUrl') == '/studio/', '편집기 빌드(/studio/)')

        doc1 = upload(FIX, '메모_변경추적.hwpx'); d1 = doc1['id']
        base1 = {p['ref']: p['text'] for p in rest(f'/api/docs/{d1}/paragraphs')}
        doc2 = upload(SMALL, '경영대학_기초통계.hwpx') if os.path.exists(SMALL) else None
        print(f'doc1 {d1} 문단 {len(base1)}' + (f' · doc2 {doc2["id"]}' if doc2 else ''), flush=True)

        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)

            def context(user, label, hold_ws=False, answers=None, view='detail'):
                """answers = { 'accept': bool, 'seen': [] } 를 주면 확인 창에 그 답을 하고 글을 모은다(없으면 늘 [확인]).
                view = 보기(localStorage hwpx.view) — 지금까지의 시험은 '자세히'(v0.3.1 화면 그대로), None 이면 적지 않는다(기본 '간단히')"""
                ctx = br.new_context(viewport={'width': 1440, 'height': 960}, device_scale_factor=1, accept_downloads=True)
                ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(user['token'])}); }} catch (e) {{}}")
                if view:
                    ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.view', {json.dumps(view)}); }} catch (e) {{}}")
                if hold_ws:
                    ctx.add_init_script(HOLD_WS_JS)
                pg = ctx.new_page()
                pg.on('pageerror', lambda e: errors.append(f'pageerror({label}): {e}'))
                pg.on('console', lambda m: errors.append(f'console.{m.type}({label}): {m.text}') if m.type == 'error' else None)

                def on_dialog(dlg):
                    if answers is None:
                        dlg.accept(); return
                    answers.setdefault('seen', []).append(dlg.message)
                    dlg.accept() if answers.get('accept', True) else dlg.dismiss()
                pg.on('dialog', on_dialog)
                return ctx, pg

            ctxA, pa = context(A, 'A')
            ctxB, pb = context(B, 'B')

            if os.environ.get('UI_STUDIO_ONLY') in ('review', 'jobs', 'live', 'cell'):   # 개발용: [11] 검토 고침만 · [12] AI 작업 한 번에만 · [13] 실시간만 · [13k] 칸 안 Enter 만(전체 시험은 이 변수 없이)
                if os.environ.get('UI_STUDIO_ONLY') == 'jobs':
                    v031_jobs(pa, tmp)
                elif os.environ.get('UI_STUDIO_ONLY') == 'live':
                    v04_live(context, tmp, errors)
                    v04_cell_enter(context, tmp, errors)
                elif os.environ.get('UI_STUDIO_ONLY') == 'cell':
                    v04_cell_enter(context, tmp, errors)
                else:
                    review_fixes(context, pa, tmp, errors)
                bad = [e for e in errors if 'favicon' not in e]
                ok(not bad, f'페이지 오류 없음{"" if not bad else ": " + " | ".join(bad[:5])}')
                br.close()
                raise OnlyReview()

            print('[1] 두 사용자가 같은 문서를 연다 — 편집기·플러그인 준비', flush=True)
            open_doc(pa, d1)
            open_doc(pb, d1)
            ok(pa.evaluate(f'{FRAME_JS}.contentWindow.rhwpCowork.version') == '0.4.0', '플러그인 판 0.4.0(syncToBase·flash·readOnly — V4 §2.5)')
            ok(pa.locator('.seg.mode').count() == 0 and pa.locator('button.undo').count() == 0, "옛 '검토 보기/편집 보기'·호스트 되돌리기 단추 없음")
            wait_until(lambda: chip_text(pa) == '수정 없음', timeout=10, msg='칩 수정 없음')
            ok(True, f"내 수정본 칩 「{chip_text(pa)}」")
            ok(pa.locator('[data-testid="agent-pill"]').inner_text().strip() == '○ 연결 안 됨', '내 에이전트 알약 ○ 연결 안 됨')
            wait_until(lambda: len(store(pa, 's.presence')) == 2, timeout=10, msg='접속자 2명')
            ok(pa.locator('[data-testid="presence"] .who').count() == 2, '접속자 아바타 2개')
            ann = store(pa, 's.anchors')
            ok(isinstance(ann, list) and ann, f'anchors {len(ann)}개(s.anchors)')
            ncards = pa.locator('[data-testid="rail"] .rail-slot').count()
            ok(ncards >= 1, f'검토 레일 카드 {ncards}개')
            tabs = pa.evaluate("() => [...document.querySelectorAll('.panel .tabs [role=tab]')].map((b) => b.dataset.tab)")
            ok(tabs == ['ai', 'review', 'cr', 'change', 'attach', 'history'], f'패널 탭 {tabs}')   # web/view.js DETAIL_TABS(AI 작업 탭이 먼저)
            shot(pa, '01_open_A')
            shot(pb, '01_open_B')
            fa = editor_frame(pa)

            print("[1b] 변경 추적 글을 그냥 누르면(캐럿) 탭은 그대로 · 강조만 — 표식(삭제 쐐기)을 누르면 패널 '변경 추적' 탭(그 묶음 카드)", flush=True)
            chg = wait_until(lambda: next((x for x in overlays(pa) if x['kind'] == 'change' and 'cw-ins' in x['cls'] and x['rect']['w'] > 6 and x['rect']['h'] > 2), None), timeout=8, msg='변경 추적 강조')
            o = frame_offset(pa)
            tab0 = store(pa, 's.tab')
            pa.mouse.click(o['x'] + chg['rect']['x'] + chg['rect']['w'] / 2, o['y'] + chg['rect']['y'] + chg['rect']['h'] / 2)
            wait_until(lambda: (store(pa, 's.active') or {}).get('id') == chg['id'], timeout=5, msg='누른 변경 추적 = s.active')
            wait_until(lambda: any(x['kind'] == 'change' and x['id'] == chg['id'] and 'cw-active' in x['cls'] for x in overlays(pa)), timeout=5, msg='강조 진하게(cw-active)')
            time.sleep(0.4)
            ok(store(pa, 's.tab') == tab0 == 'review' and (store(pa, 's.active') or {}).get('kind') == 'change',
               f"변경 추적 글(#{chg['id']})을 그냥 누름(캐럿) → 패널 탭은 그대로({store(pa, 's.tab')}) · 그 변경만 강조(cw-active)")
            wedge = next((x for x in overlays(pa) if x['kind'] == 'change' and 'cw-wedge' in x['cls'] and x['rect']['w'] > 0), None)
            ok(wedge is not None, f"삭제 쐐기 표식(#{wedge and wedge['id']})")
            pa.mouse.click(o['x'] + wedge['rect']['x'] + wedge['rect']['w'] / 2, o['y'] + wedge['rect']['y'] + wedge['rect']['h'] / 2)
            wait_until(lambda: store(pa, 's.tab') == 'change', timeout=5, msg="표식 → '변경 추적' 탭")
            act = store(pa, 's.active') or {}
            ccard = pa.locator('.panel .tab-change .card.chg.active')
            wait_until(lambda: ccard.count() == 1, timeout=5, msg='고른 변경 묶음 카드')
            ok(act.get('kind') == 'change' and act.get('id') == wedge['id'] and wedge['id'] in (ccard.get_attribute('data-ids') or '').split(','),
               f"삭제 쐐기 표식(#{wedge['id']}) 누름 → '변경 추적' 탭 · 그 묶음 카드 고름(data-ids {ccard.get_attribute('data-ids')})")
            shot(pa, '01b_change_tab')
            pa.evaluate("() => { const s = window.__doc.s; s.active = null; s.tab = 'review'; }")

            print('[2] A: 선택 → 편집기 안 우클릭 → 검토 구역 → AI에게 검토 맡기기 → 요청 창이 선택 근처에', flush=True)
            t0 = base1['s0/p0']
            phrase = '메모 대상 문장이 여기 있습니다'
            s0, e0 = cp_index(t0, phrase)
            ok(cw(pa, 'cw.debug.select(arg[0], arg[1], arg[2])', ['s0/p0', s0, e0]), 'debug.select(s0/p0)')
            settle(pa)
            sel = wait_until(lambda: (lambda x: x if x and x.get('text') == phrase else None)(store(pa, 's.sel')), timeout=5, msg='selection → s.sel')
            ok(sel['ref'] == 's0/p0' and (sel['start'], sel['end']) == (s0, e0) and store(pa, 's.selection')['text'] == phrase, f"s.sel·s.selection = 기준 ref {sel['ref']} {sel['start']}..{sel['end']}")
            mid = point(pa, 's0/p0', s0 + 2)
            pa.mouse.click(mid['x'], mid['y'], button='right')
            fa.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
            ok(fa.evaluate("() => document.querySelector('.context-menu .cw-menu-head')?.textContent") == '검토', "우클릭 메뉴 맨 위 '검토' 구역")
            shot(pa, '02_menu')
            fa.click('.context-menu [data-cowork-action="instruct"]')
            pa.wait_for_selector('.composer-win', timeout=5000)
            box = pa.locator('.composer-win').bounding_box()
            o = frame_offset(pa)
            r = sel['rect']
            sr = {'x': r['x'] + o['x'], 'y': r['y'] + o['y'], 'w': r['w'], 'h': r['h']}
            covers = not (box['x'] > sr['x'] + sr['w'] or box['x'] + box['width'] < sr['x'] or box['y'] > sr['y'] + sr['h'] or box['y'] + box['height'] < sr['y'])
            gap = min(abs(box['y'] - (sr['y'] + sr['h'])), abs(sr['y'] - (box['y'] + box['height'])))
            ok(not covers and gap < 60 and abs(box['x'] - sr['x']) < 500, f"요청 창이 선택 근처(겹치지 않음, 세로 {gap:.0f}px) — 창 {box['x']:.0f},{box['y']:.0f} / 선택 {sr['x']:.0f},{sr['y']:.0f}")
            # 'AI에게 맡기기…' 는 요청 창을 연다(바로 보내지 않음 — 2026-11-03 메뉴 하나로). 비워 두고 [보내기] = 검토(sendKind review)
            cm = store(pa, '{ target: s.composer.target, kind: s.composer.kind, autoSend: s.composer.autoSend }')
            ok(phrase in (cm['target'].get('text') or '') and cm['target']['ref'] == 's0/p0' and cm['kind'] == 'instruct' and cm['autoSend'] is False,
               f"요청 대상 「{cm['target'].get('text')}」 · 요청 창(종류 instruct) · 바로 보내지 않음")
            shot(pa, '03_composer')
            pa.click('.composer-win .cmp-send')

            print('[3] 보냄(모의 AI, 비운 지시 = 검토) → 결과 제안 → 내 수정본에 반영 → 편집기 글 → 자동 저장 칩', flush=True)
            pa.wait_for_selector('.composer-win .result', timeout=30000)
            adopt = pa.locator('.composer-win .result .rs-adopt').first
            adopt.wait_for(timeout=20000)
            pid = int(pa.locator('.composer-win .result .prop[data-pid], .composer-win .result .alt[data-pid]').first.get_attribute('data-pid'))
            prop = next(x for x in rest(f'/api/docs/{d1}/proposals') if x['pid'] == pid)
            ok(prop['find'] == '있습니다' and prop['replace'] == '있음', f"결과 제안 #{pid} 「{prop['find']}」→「{prop['replace']}」")
            shot(pa, '04_result')
            # (웨이브 2 고침 잠금) 반영하자마자 '반영됨': 서버 반영 기록(p.adopted)이 오는 순간 바꾼 문단(s.draft)에 이미 들어 있어
            # 그 사이 [반영] 단추(.rs-adopt)가 다시 보이는 틈이 없다(플러그인 'draft' 600ms 쉼을 기다리지 않음 — store.adoptProposal → editor syncDraft)
            pa.evaluate('''(pid) => {
              const d = window.__doc; const out = []; window.__adoptFrames = out; const t0 = performance.now();
              const btnIn = (el) => !!el?.querySelector('.rs-adopt');
              const tick = () => {
                const el = document.querySelector(`.composer-win .result [data-pid="${pid}"]`); const p = d.proposal(pid);
                out.push({ t: Math.round(performance.now() - t0), adopted: !!(p && p.adopted), changed: (d.s.draft.changed || []).includes('s0/p0'), pill: !!el?.querySelector('.adopted'), btn: btnIn(el) });
                if (performance.now() - t0 < 3500) requestAnimationFrame(tick); else out.done = true;
              };
              requestAnimationFrame(tick); }''', pid)
            adopt.click()
            t_adopt = time.time()
            want0 = t0.replace('있습니다', '있음', 1)
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p0')") == want0, timeout=8, msg='편집기 글 바뀜')
            ok(True, f'편집기(내 수정본) 글 「{want0}」')
            ok(para_text(d1, 's0/p0') == t0, '기준 문서는 그대로(편집기 타이핑·반영은 내 수정본만)')
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=15, msg='칩 수정 1문단 · 저장됨')
            ok(True, f"칩 「{chip_text(pa)}」")
            mine = rest(f'/api/docs/{d1}/drafts/mine')
            ok(mine['cr'] and mine['cr']['status'] == 'draft' and mine['cr']['hunkCount'] == 1 and mine['file'], f"서버 내 수정본: 변경 요청 #{mine['cr'] and mine['cr']['cid']} 초안 · 덩어리 {mine['cr'] and mine['cr']['hunkCount']}")
            cid = mine['cr']['cid']
            h0 = mine['cr']['hunks'][0]
            ok(h0['type'] == 'replace' and h0['ref'] == 's0/p0' and h0['newText'] == want0, f"덩어리 {h0['type']} {h0['ref']} → 「{h0['newText']}」")
            pp = next(x for x in rest(f'/api/docs/{d1}/proposals') if x['pid'] == pid)
            ok(pp['status'] == 'pending' and (pp.get('adopted') or {}).get('by') == A['name'] and (pp.get('adopted') or {}).get('cid') == cid, f"제안 #{pid} 반영 기록(adopted → 변경 요청 #{cid})")
            ok(pa.locator('.composer-win .result .adopted').count() >= 1 and pa.locator('.composer-win .result .adopted').first.inner_text().strip() == '반영됨', "결과 창에 '반영됨'")
            fr = wait_until(lambda: pa.evaluate('() => window.__adoptFrames && window.__adoptFrames.done ? window.__adoptFrames : null'), timeout=10, msg='반영 프레임 기록')
            ia = next((i for i, x in enumerate(fr) if x['adopted']), None)
            gap = [x for x in fr[ia:] if not x['pill'] or x['btn']] if ia is not None else fr
            ok(ia is not None and fr[ia]['changed'] and not gap,
               f"반영 기록이 온 프레임부터 '반영됨'(그 사이 단추 다시 보인 프레임 {len(gap)}개 · 바꾼 문단은 기록보다 먼저, 기록 {fr[ia]['t'] if ia is not None else '?'}ms · 프레임 {len(fr)}개)")
            # (웨이브 2 고침 잠금) 편집기를 다시 열어도(d.editor.reload) 반영해 둔 제안은 대기로 다시 그리지 않고 결과 창은 '반영됨' 그대로.
            # 다시 열면 studio 되돌리기 기록이 비므로([7] 이 이 창의 Ctrl+Z 를 쓴다) 같은 사람의 둘째 창에서 한다 — AI 작업 탭의 결과 창, 다시 열기는 같은 길
            rid = store(pa, 's.composer && s.composer.rid')
            ctxR, pr = context(A, 'A-reload')
            open_doc(pr, d1)
            pr.evaluate('(rid) => { const s = window.__doc.s; s.tab = "ai"; s.activeRid = rid; }', rid)
            psel = f'.tab-ai .result-card .result [data-pid="{pid}"]'
            wait_until(lambda: pr.locator(f'{psel} .adopted').count() == 1, timeout=10, msg="둘째 창 결과 창 '반영됨'")
            wait_until(lambda: not [x for x in overlays(pr) if x['kind'] == 'proposal' and x['id'] == str(pid)], timeout=5, msg='둘째 창: 반영한 제안 강조 없음')
            rl = pr.evaluate('''async ([pid, sel]) => {
              const d = window.__doc; const f = document.querySelector('.editorhost iframe'); const frames = []; let on = true; const t0 = performance.now();
              const btnIn = (el) => !!el?.querySelector('.rs-adopt');
              const tick = () => {
                if (!on) return;
                const el = document.querySelector(sel); let drawn = null;
                try { drawn = f.contentWindow.rhwpCowork.debug.overlays().some((x) => x.kind === 'proposal' && x.id === String(pid)); } catch (e) { drawn = null; }
                frames.push({ t: Math.round(performance.now() - t0), ready: !!(d.editor && d.editor.ready), pill: !!el?.querySelector('.adopted'), btn: btnIn(el), drawn });
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
              await d.editor.reload({ keepScroll: true });
              const tReady = Math.round(performance.now() - t0);
              await new Promise((r) => setTimeout(r, 1200));   // 플러그인 'draft'(편집 뒤 600ms 쉼)가 지나도록 더 본다
              on = false;
              return { frames, tReady, changed: d.s.draft.changed, source: d.editor.source, notReady: frames.filter((x) => !x.ready).length };
            }''', [pid, psel])
            bad_rl = [x for x in rl['frames'] if not x['pill'] or x['btn'] or x['drawn']]
            ok(rl['source'] == 'draft' and 's0/p0' in rl['changed'] and rl['notReady'] > 0 and not bad_rl,
               f"d.editor.reload() 동안·뒤({rl['tReady']}ms + 1.2초, 프레임 {len(rl['frames'])}개 중 다시 여는 중 {rl['notReady']}개): 제안 #{pid} 강조 안 그림 · 결과 창 '반영됨' 그대로(어긋난 프레임 {bad_rl[:2]})")
            ctxR.close()
            ok(pa.locator('[data-testid="submit-cr"]').is_visible(), '[검토 요청] 단추(내 변경 요청이 초안)')
            # 플러그인 'draft'(바꾼 문단)는 markClean 뒤 600ms 쉼에 온다
            dbg = wait_until(lambda: (lambda x: x if x['cid'] == cid and x['draft']['count'] == 1 else None)(store(pa, '({ cid: s.myCr && s.myCr.cid, draft: s.draft })')), timeout=5, msg='s.draft')
            ok(dbg['draft']['changed'] == ['s0/p0'] and not dbg['draft']['dirty'], f"s.myCr #{dbg['cid']} · s.draft 바꾼 문단 {dbg['draft']['changed']}")
            shot(pa, '05_adopted')
            pa.locator('.composer-win .fw-head button[aria-label="닫기"]').click()
            # 반영해 둔 제안: 편집기에 더 그리지 않고 우클릭에 '내 수정본에 반영'이 없다. 다시 반영(결과 창·코드)은 막는다(그 문단이 지금도 바뀜)
            wait_until(lambda: not [x for x in overlays(pa) if x['kind'] == 'proposal' and x['id'] == str(pid)], timeout=5, msg='반영한 제안 강조 없앰')
            ok(True, f'반영해 둔 제안 #{pid} 은(는) 편집기에 더 그리지 않음(status adopted)')
            po = point(pa, 's0/p0', cp_index(t0, '있습니다')[0] + 1)
            pa.mouse.click(po['x'], po['y'], button='right')
            psub = f'[data-cowork-sub="rv-proposal:{pid}"]'
            fa.wait_for_selector(f'.context-menu {psub}', timeout=5000)
            fa.hover(psub)
            fa.wait_for_selector(f'.context-menu {psub} [data-cowork-action="proposal-show"]', timeout=3000)
            ok(fa.locator('.context-menu [data-cowork-action="proposal-adopt"]').count() == 0, "우클릭: 반영해 둔 제안은 '레일에서 보기'만('내 수정본에 반영' 없음)")
            fa.click(f'.context-menu {psub} [data-cowork-action="proposal-show"]')
            pa.evaluate('() => { window.__doc.s.active = null; }')
            again = adopt_answer(pa, pid, False)
            ok(again['r'] == {'ok': False, 'reason': 'ADOPTED'} and again['asked'] == 1 and cw(pa, "cw.debug.text('s0/p0')") == want0,
               f"같은 제안 다시 반영 → 확인 창 [취소] → {again['r']} · 편집기 글 그대로")

            print('[4] B: 편집기에 ✎ 홍길동 수정 중 표시(10초 안) · 접속자 창', flush=True)
            def b_draft():
                return [x for x in overlays(pb) if x['kind'] == 'draft' and x['text'] == f"✎ {A['name']}"]
            # A 의 자동 저장(반영 뒤 0.4초 + 저장)이 끝나면 '입력 중' 알림을 거두므로 B 에는 이름표 '✎ 홍길동'(수정 중)이 보인다
            wait_until(b_draft, timeout=10, msg='B 수정 중 표시')
            ok(True, f"B 편집기 '✎ {A['name']}' 표시(A 반영 뒤 {time.time() - t_adopt:.1f}초)")
            bars = [x for x in overlays(pb) if x['kind'] == 'draft' and 'cw-dbar' in x['cls']]
            ok(bars and all(x['id'].startswith(f'{cid}:') for x in bars), f"B 문단 왼쪽 여백 막대(변경 요청 #{cid}의 덩어리 {[x['id'] for x in bars]})")
            ok(not [x for x in overlays(pb) if x['kind'] == 'editing'], "저장 뒤 A 의 '입력 중' 표시는 거둠")
            ok(A['name'] in pb.locator('[data-testid="rail"]').inner_text(), f"B 레일에 {A['name']} 수정 중 카드")
            crs_b = store(pb, 's.crs')
            ok(any(c['cid'] == cid and c['author'] == A['name'] and c['hunks'] and c['hunks'][0]['curRef'] == 's0/p0' for c in crs_b), 'B s.crs: A 의 초안(덩어리 curRef)')
            pb.hover('[data-testid="presence"]')
            pop = pb.locator('.whopop')
            pop.wait_for(state='visible', timeout=3000)
            ptxt = pop.inner_text()
            ok(A['name'] in ptxt and f'변경 요청 #{cid}' in ptxt, f"B 접속자 창에 '{A['name']} … 변경 요청 #{cid} 수정 중'")
            shot(pb, '06_B_draft_marker')
            pb.mouse.move(5, 300)

            print('[4b] B: 우클릭 수정 중 ▸ 의견 달기 · 변경 보기, 메모 ▸ 답글 · 해결', flush=True)
            fb = editor_frame(pb)
            def b_menu(sub, action, ref='s0/p0'):
                qb = point(pb, ref, 2)
                pb.mouse.click(qb['x'], qb['y'], button='right')
                fb.wait_for_selector(f'.context-menu {sub}', timeout=5000)
                fb.hover(sub)
                fb.click(f'{sub} [data-cowork-action="{action}"]')
            dsub = f'[data-cowork-sub^="rv-draft:{cid}:"]'
            b_menu(dsub, 'draft-comment')
            pb.wait_for_selector('.quickreply textarea', timeout=5000)
            ok(f'변경 요청 #{cid}' in pb.locator('.quickreply .fw-title').inner_text(), f"'의견 달기' → 의견 창(변경 요청 #{cid})")
            CMT = '이 표현 괜찮네요'
            pb.fill('.quickreply textarea', CMT)
            pb.click('.quickreply .memoedit button.primary')
            th = wait_until(lambda: [t for t in rest(f'/api/docs/{d1}/change-requests/{cid}', token=B['token'])['threads'] if t['comments'][0]['text'] == CMT], timeout=10, msg='의견 스레드')
            ok(th[0]['hid'] == h0['hid'] and th[0]['comments'][0]['by'] == B['name'], f"B 의견 → 변경 요청 #{cid} 스레드(덩어리 {th[0]['hid']})")
            b_menu(dsub, 'draft-show')
            wait_until(lambda: store(pb, 's.tab') == 'cr' and store(pb, 's.crOpen') == cid, timeout=5, msg='변경 보기')
            ok(store(pb, 's.active.kind') == 'draft' and CMT in pb.locator('.panel .tabbody').inner_text(), f"'변경 보기' → 패널 변경 요청 #{cid} 상세(의견 보임) + 레일 카드 고름")
            shot(pb, '06b_B_cr_detail')
            mid1 = next(m['id'] for m in rest(f'/api/docs/{d1}/memos') if m['ref'] == 's0/p0' and not m.get('link'))
            msub = f'[data-cowork-sub="rv-memo:{mid1}"]'
            b_menu(msub, 'memo-reply')
            pb.wait_for_selector('.quickreply textarea', timeout=5000)
            RPL = '확인했습니다'
            pb.fill('.quickreply textarea', RPL)
            pb.click('.quickreply .memoedit button.primary')
            wait_until(lambda: any(r['text'] == RPL for r in (next(m for m in rest(f'/api/docs/{d1}/memos') if m['id'] == mid1).get('thread') or {}).get('replies', [])), timeout=10, msg='메모 답글')
            ok(True, f"메모 {mid1} ▸ 답글 → 서버 스레드에 「{RPL}」")
            b_menu(msub, 'memo-resolve')
            wait_until(lambda: (next(m for m in rest(f'/api/docs/{d1}/memos') if m['id'] == mid1).get('thread') or {}).get('resolved'), timeout=10, msg='메모 해결')
            wait_until(lambda: not [x for x in overlays(pb) if x['kind'] == 'memo' and x['id'] == mid1 and 'cw-box' in x['cls']], timeout=10, msg='해결된 메모 강조 숨김')
            ok(True, f'메모 {mid1} ▸ 해결 → 해결됨(편집기 강조 숨김)')
            pb.evaluate("() => { window.__doc.s.tab = 'review'; }")

            print("[4c] B: 남의 수정 중 ▸ 의견 달기 — 쓰는 사이 그 덩어리가 없어지면(서버 NO_HUNK) 그 문단 전체 의견으로 · 실패해도 창·쓴 글 남음", flush=True)
            admin = USERS[0]['token']
            def admin_draft(edits):
                return node_helper(['draft', '--base', REST, '--doc', d1, '--edits', json.dumps(edits, ensure_ascii=False)], token=admin)['cr']
            cidx = admin_draft([{'ref': 's0/p1', 'from': '둘째 문단', 'to': '둘째 문단(관)'}])['cid']
            xsub = f'[data-cowork-sub^="rv-draft:{cidx}:"]'
            wait_until(lambda: any(x['kind'] == 'draft' and x['id'].startswith(f'{cidx}:') for x in overlays(pb)), timeout=15, msg='B 편집기에 관리자 수정 중')
            b_menu(xsub, 'draft-comment', 's0/p1')
            pb.wait_for_selector('.quickreply textarea', timeout=5000)
            XT = '괄호는 왜 넣었나요?'
            pb.fill('.quickreply textarea', XT)
            # 관리자가 그 문단 수정을 거두고 다른 문단만 고쳐 저장 → B 가 든 덩어리(hid)는 이제 없다
            admin_draft([{'ref': 's0/p2', 'from': '셋째 문단', 'to': '셋째 문단(관)'}])
            wait_until(lambda: [h['ref'] for h in (next((c for c in store(pb, 's.crs') if c['cid'] == cidx), None) or {}).get('hunks', [])] == ['s0/p2'], timeout=15, msg='B 목록: 관리자 덩어리 바뀜')
            posts = []
            def on_resp(r):
                if r.request.method == 'POST' and f'/change-requests/{cidx}/threads' in r.url:
                    posts.append(r.status)
            pb.on('response', on_resp)
            n_err = len(errors)
            pb.click('.quickreply .memoedit button.primary')
            thx = wait_until(lambda: [t for t in rest(f'/api/docs/{d1}/change-requests/{cidx}', token=B['token'])['threads'] if t['comments'][0]['text'] == XT], timeout=10, msg='의견 스레드')
            wait_until(lambda: pb.locator('.quickreply').count() == 0, timeout=5, msg='의견 창 닫힘')
            pb.remove_listener('response', on_resp)
            ok(posts[:1] == [400] and posts[-1] == 200 and thx[0]['hid'] is None and thx[0]['ref'] == 's0/p1' and thx[0]['comments'][0]['by'] == B['name'],
               f"서버가 NO_HUNK(400)로 답함 → 그 문단(s0/p1) 전체 의견으로 다시 보냄(응답 {posts}) · 스레드 hid {thx[0]['hid']} ref {thx[0]['ref']}")
            # 보내기가 실패해도(변경 요청이 없어짐) 창과 쓴 글이 남는다
            b_menu(xsub, 'draft-comment', 's0/p2')
            pb.wait_for_selector('.quickreply textarea', timeout=5000)
            XT2 = '이 글은 사라지면 안 됩니다'
            pb.fill('.quickreply textarea', XT2)
            rest(f'/api/docs/{d1}/drafts/mine', 'DELETE', token=admin)
            wait_until(lambda: not any(c['cid'] == cidx for c in store(pb, 's.crs')), timeout=10, msg='B 목록에서 관리자 변경 요청 빠짐')
            pb.click('.quickreply .memoedit button.primary')
            wait_until(lambda: '의견을 달지 못했습니다' in pb.locator('.toasts').inner_text(), timeout=10, msg='실패 알림')
            time.sleep(0.3)
            ok(pb.locator('.quickreply').count() == 1 and pb.locator('.quickreply textarea').input_value() == XT2 and store(pb, 's.reply && s.reply.text') == XT2,
               f"변경 요청이 없어져 의견을 못 달아도(NO_CR) 창 · 쓴 글 그대로(s.reply.text) — 알림 「{pb.locator('.toasts .toast.error').last.inner_text()[:50]}」")
            pb.locator('.quickreply .fw-head button[aria-label="닫기"]').click()
            time.sleep(0.3)
            errors[n_err:] = [e for e in errors[n_err:] if not re.search(r'status of (400|404|409)', e)]
            pb.evaluate("() => { const s = window.__doc.s; s.tab = 'review'; s.active = null; }")

            print('[5] A: 우클릭 메모 달기 → 레일 카드', flush=True)
            MEMO = '근거 자료를 덧붙여 주세요'
            pr = point(pa, 's0/p2', 3)
            pa.mouse.click(pr['x'], pr['y'], button='right')
            fa.wait_for_selector('.context-menu [data-cowork-action="memo"]', timeout=5000)
            fa.click('.context-menu [data-cowork-action="memo"]')
            pa.wait_for_selector('.popover textarea', timeout=5000)
            ok('s0/p2' in pa.locator('.popover .cmp-target').inner_text(), '메모 창 대상 s0/p2(문단 전체)')
            pa.fill('.popover textarea', MEMO)
            pa.click('.popover .memoedit button.primary')
            wait_until(lambda: MEMO in pa.locator('[data-testid="rail"]').inner_text(), timeout=10, msg='레일 카드')
            ok(True, f'레일에 메모 카드 「{MEMO}」')
            mm = next(m for m in rest(f'/api/docs/{d1}/memos') if MEMO in (m.get('text') or ''))
            ok(mm['ref'] == 's0/p2', f"메모 {mm['id']} @ {mm['ref']}")
            wait_until(lambda: any(x['kind'] == 'memo' and x['id'] == mm['id'] for x in overlays(pa)), timeout=5, msg='메모 강조')
            ok(True, '편집기에 메모 강조')
            # 메모로 기준 버전이 올라도 본문 글은 같다 → 칩은 '최신 반영 필요'가 아니다(조용히 새 기준)
            time.sleep(1.5)
            ok(pa.locator('[data-testid="behind-chip"]').count() == 0 and store(pa, 's.draft.behind') == 0, '메모만 늘어난 새 버전 → 최신 반영 필요 아님')
            wait_until(lambda: rest(f'/api/docs/{d1}/drafts/mine')['cr']['baseVersion'] == rest(f'/api/docs/{d1}')['version'], timeout=10, msg='변경 요청 기준 버전 따라감')
            ok(True, '내 변경 요청의 기준 버전도 새 버전으로(다시 저장)')
            shot(pa, '07_memo_rail')

            print('[6] [한글로 저장](단추 하나 — 승인 방식 문서는 진행 중 변경 요청의 검토 메모까지) → 파일에 [변경 요청 # 메모(A 수정본이 있는 동안)', flush=True)
            sbtn = pa.locator('[data-testid="save-hangul"]')
            ok(sbtn.inner_text().strip() == '한글로 저장' and pa.locator('.savemenu, .savemenu .dropdown').count() == 0 and '보이는 그대로 + 메모' in (sbtn.get_attribute('title') or ''),
               f"상단 [한글로 저장] 단추 하나(옛 ▾ 메뉴 없음) · 설명 「{sbtn.get_attribute('title')}」")
            with pa.expect_download(timeout=30000) as dl_info:
                sbtn.click()
            dl = dl_info.value
            fpath = os.path.join(tmp, 'review.hwpx')
            dl.save_as(fpath)
            ok(dl.suggested_filename == '메모_변경추적.hwpx', f'파일 이름 {dl.suggested_filename}(<제목>.hwpx)')
            texts = memo_texts_of_file(fpath)
            crm = [t for t in texts if t.startswith('[변경 요청 #')]
            ok(crm and f'[변경 요청 #{cid} · 수정 중] {A["name"]}' in crm[0], f"HwpxDoc 으로 읽힘 · 메모 {len(texts)}개 중 「{crm and crm[0].splitlines()[0]}」")
            ok(any(MEMO in t for t in texts), '방금 단 메모도 들어 있음')

            print('[7] A: 편집기 안 Ctrl+Z → 반영 되돌림 → 다음 자동 저장이 덩어리를 지움(B 표시도 사라짐)', flush=True)
            q = point(pa, 's0/p1', 2)
            pa.mouse.click(q['x'], q['y'])
            pa.keyboard.press('Control+z')
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p0')") == t0, timeout=6, msg='되돌리기')
            ok(True, 'Ctrl+Z → 원래 글')
            wait_until(lambda: chip_text(pa) == '수정 없음', timeout=15, msg='칩 수정 없음')
            ok(rest(f'/api/docs/{d1}/drafts/mine')['cr'] is None and store(pa, 's.myCr') is None, f"자동 저장이 초안 변경 요청을 지움(칩 「{chip_text(pa)}」)")
            wait_until(lambda: not b_draft(), timeout=10, msg='B 표시 사라짐')
            ok(True, 'B 편집기의 수정 중 표시도 사라짐')
            pp = next(x for x in rest(f'/api/docs/{d1}/proposals') if x['pid'] == pid)
            ok(pp['status'] == 'pending' and not pp.get('adopted'), f'제안 #{pid} 은(는) 다시 대기(반영 기록 풀림)')
            wait_until(lambda: any(x['kind'] == 'proposal' and x['id'] == str(pid) for x in overlays(pa)), timeout=8, msg='되돌린 제안 다시 그림')
            ok(True, f'되돌린 제안 #{pid} 은(는) 편집기에 다시 대기로 그림')
            shot(pa, '08_undone')

            print('[7b] 다른 문단 수정이 남아 서버 반영 기록이 남아도: 반영된 채면 다시 반영 막음 · Ctrl+Z 로 되돌린 뒤면 묻지 않고 제자리에', flush=True)
            # 「니다」의 둘째(있습니다) → 「니당」. 두 번 반영하면 첫째(문단입니다)가 바뀌던 결함
            pq2 = rest(f'/api/docs/{d1}/proposals', 'POST', {'ref': 's0/p0', 'find': '니다', 'replace': '니당', 'occurrence': 2, 'reason': '시험'})
            pid2 = pq2['pid']
            i2 = t0.index('니다', t0.index('니다') + 1)
            want_a = t0[:i2] + '니당' + t0[i2 + 2:]
            p2 = base1['s0/p2']; n2 = len(cps(p2))
            type_at(pa, 's0/p2', n2, ' 덧')
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='다른 문단 저장')
            r1 = adopt_answer(pa, pid2, True)
            ok(r1 == {'r': {'ok': True}, 'asked': 0} and cw(pa, "cw.debug.text('s0/p0')") == want_a, f'제안 #{pid2}(둘째 「니다」) 반영 → 「{want_a}」')
            wait_until(lambda: re.fullmatch(r'수정 2문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='반영 저장')
            cid3 = rest(f'/api/docs/{d1}/drafts/mine')['cr']['cid']
            wait_until(lambda: ((store(pa, f's.proposals.find((p) => p.pid === {pid2})') or {}).get('adopted') or {}).get('cid') == cid3 and 's0/p0' in store(pa, 's.draft.changed'), timeout=10, msg='반영 기록·바꾼 문단')
            again = adopt_answer(pa, pid2, False)
            ok(again['r'] == {'ok': False, 'reason': 'ADOPTED'} and again['asked'] == 1 and cw(pa, "cw.debug.text('s0/p0')") == want_a, f"다시 반영 → [취소] → {again['r']} · 첫째 「니다」 그대로")
            q = point(pa, 's0/p1', 2)
            pa.mouse.click(q['x'], q['y'])
            pa.keyboard.press('Control+z')
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p0')") == t0, timeout=6, msg='반영 되돌림')
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='되돌림 저장')
            pp2 = next(x for x in rest(f'/api/docs/{d1}/proposals') if x['pid'] == pid2)
            ok((pp2.get('adopted') or {}).get('cid') == cid3, f'되돌린 뒤에도 서버 반영 기록은 남음(변경 요청 #{cid3} 에 다른 문단 덩어리)')
            wait_until(lambda: 's0/p0' not in store(pa, 's.draft.changed'), timeout=5, msg='바꾼 문단에서 빠짐')
            r3 = adopt_answer(pa, pid2, False)
            ok(r3 == {'r': {'ok': True}, 'asked': 0} and cw(pa, "cw.debug.text('s0/p0')") == want_a, f'되돌린 뒤 다시 반영 → 묻지 않고 제자리(둘째 「니다」) 「{want_a}」')
            pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
            wait_until(lambda: chip_text(pa) == '수정 없음' and cw(pa, "cw.debug.text('s0/p0')") == t0, timeout=15, msg='정리')
            rest(f'/api/docs/{d1}/proposals/{pid2}/reject', 'POST', {}, token=USERS[0]['token'])

            print('[7c] 같은 사람의 두 창: 한 창이 저장하면 다른 창(수정 없음)은 그 수정본을 불러오고, 고치는 중이면 덮어쓰지 않고 멈춰 묻는다', flush=True)
            ctxA2, pa2 = context(A, 'A2')
            open_doc(pa2, d1)
            p1 = base1['s0/p1']; n1 = len(cps(p1)); n0 = len(cps(t0))
            type_at(pa, 's0/p1', n1, ' 탭하나')
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='창1 저장')
            wait_until(lambda: cw(pa2, "cw.debug.text('s0/p1')") == p1 + ' 탭하나' and store(pa2, 's.editor.ready && s.editor.source') == 'draft', timeout=10, msg='창2 가 창1 수정본을 불러옴')
            ok(re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa2)) is not None, f"창2(수정 없음) → 창1 이 저장한 수정본을 저절로 불러옴(칩 「{chip_text(pa2)}」)")
            cidT = rest(f'/api/docs/{d1}/drafts/mine')['cr']['cid']
            # 둘 다 고치는 중: 창2 가 치고(자동 저장 2.5초 전) 창1 이 다른 문단을 치고 바로 저장 → 창2 는 저장을 멈춘다
            type_at(pa, 's0/p2', n2)
            type_at(pa2, 's0/p0', n0, ' 탭둘')
            pa.keyboard.type(' 더')
            pa.evaluate('() => window.__doc.saveDraftNow()')
            wait_until(lambda: pa2.locator('[data-testid="chip-keep"]').count() == 1, timeout=8, msg='창2 저장 멈춤')
            # 알림(WS)으로 알면 '다른 창(기기)에서 바뀐 수정본', 알림보다 창2 저장이 먼저면 서버 409 DRAFT_STALE '다른 곳에서 바뀜' — 둘 다 멈춤
            ok(('다른 창' in chip_text(pa2) or '다른 곳에서 바뀜' in chip_text(pa2)) and store(pa2, 's.draft.stale') and store(pa2, 's.draft.dirty'), f"창2 칩 「{chip_text(pa2)}」 — 저장 멈춤")
            code = pa2.evaluate('(c) => window.__doc.mergeCr(c).then(() => "merged", (e) => e.code)', cidT)
            ok(code == 'CHANGED_ELSEWHERE', f'멈춘 창에서 반영 → 먼저 저장하지 못하니 반영하지 않음({code})')
            time.sleep(3.2)   # 창2 의 자동 저장(쉼 2.5초) 때가 지나도 덮어쓰지 않는다
            hk = {x['ref']: x['newText'] for x in rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks']}
            ok(hk == {'s0/p1': p1 + ' 탭하나', 's0/p2': p2 + ' 더'}, f'서버 수정본 = 창1 것 그대로({sorted(hk)})')
            shot(pa2, '08c_two_tabs_stopped')
            # [이 글로 저장] → 창2 글로 덮어씀 → 창1(수정 없음)이 그것을 불러옴
            pa2.click('[data-testid="chip-keep"]')
            want_k = {'s0/p0': t0 + ' 탭둘', 's0/p1': p1 + ' 탭하나'}
            wait_until(lambda: {x['ref']: x['newText'] for x in rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks']} == want_k, timeout=10, msg='창2 글로 저장')
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p0')") == t0 + ' 탭둘' and cw(pa, "cw.debug.text('s0/p2')") == p2, timeout=10, msg='창1 이 창2 글을 불러옴')
            ok(not store(pa2, 's.draft.stale') and not store(pa, 's.draft.stale'), "창2 [이 글로 저장] → 서버 = 창2 글 · 창1(수정 없음)은 그것을 불러옴")
            # 또: 창2 가 치는 중에 창1 이 저장 → 창2 [다시 열기] → 창1 것(창2 에서 친 글은 버림)
            type_at(pa, 's0/p2', n2)
            type_at(pa2, 's0/p1', 0, '앞 ')
            pa.keyboard.type(' 셋')
            pa.evaluate('() => window.__doc.saveDraftNow()')
            wait_until(lambda: store(pa2, 's.draft.stale') and pa2.locator('[data-testid="chip-retry"]').count() == 1, timeout=8, msg='창2 저장 멈춤(2)')
            pa2.click('[data-testid="chip-retry"]')
            wait_until(lambda: cw(pa2, "cw.debug.text('s0/p2')") == p2 + ' 셋' and cw(pa2, "cw.debug.text('s0/p1')") == p1 + ' 탭하나'
                       and re.fullmatch(r'수정 3문단 · 저장됨 \d\d:\d\d', chip_text(pa2)), timeout=15, msg='창2 다시 열기')
            ok(not store(pa2, 's.draft.stale') and not store(pa2, 's.draft.dirty'), f"창2 [다시 열기] → 창1 수정본(창2 에서 친 「앞 」은 버림, 칩 「{chip_text(pa2)}」)")
            ctxA2.close()
            pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
            wait_until(lambda: chip_text(pa) == '수정 없음' and cw(pa, "cw.debug.text('s0/p0')") == t0, timeout=15, msg='정리')

            print('[7d] 같은 사람의 두 창: 알림(WS)을 못 받은 창이 옛 판(rev)으로 저장 → 409 DRAFT_STALE → 칩 다른 곳에서 바뀜 → [이 글로 저장](rev 없이 덮어쓰기)', flush=True)
            ctxA3, pa3 = context(A, 'A3', hold_ws=True)
            open_doc(pa3, d1)
            r0 = rest(f'/api/docs/{d1}/drafts/mine')['rev']
            type_at(pa, 's0/p1', n1, ' 창일')
            pa.evaluate('() => window.__doc.saveDraftNow()')
            m1 = rest(f'/api/docs/{d1}/drafts/mine')
            ok(m1['cr'] and isinstance(m1.get('rev'), int) and m1['rev'] > r0, f"창1 저장 → 서버 수정본 판 {r0} → {m1.get('rev')}")
            wait_until(lambda: cw(pa3, "cw.debug.text('s0/p1')") == p1 + ' 창일' and store(pa3, 's.editor.ready && s.editor.source') == 'draft', timeout=10, msg='창3 이 창1 수정본을 불러옴')
            pa3.evaluate('() => { window.__wsHold = true; }')   # 이제부터 창3 에 오는 서버 알림은 붙잡아 둔다(알림이 늦은 창)
            type_at(pa, 's0/p0', n0, ' 더')
            pa.evaluate('() => window.__doc.saveDraftNow()')
            m2 = rest(f'/api/docs/{d1}/drafts/mine')
            ok(m2['rev'] > m1['rev'] and sorted(h['ref'] for h in m2['cr']['hunks']) == ['s0/p0', 's0/p1'], f"창1 다시 저장(창3 은 모름) → 판 {m2['rev']}")
            n_err = len(errors)
            type_at(pa3, 's0/p2', n2, ' 창삼')
            code = pa3.evaluate('() => window.__doc.saveDraftNow().then(() => "saved", (e) => e.code)')
            ok(code == 'DRAFT_STALE', f'창3 이 옛 판({m1["rev"]})으로 저장 → 서버 409 {code}')
            wait_until(lambda: pa3.locator('[data-testid="chip-keep"]').count() == 1 and pa3.locator('[data-testid="chip-retry"]').count() == 1, timeout=5, msg='칩 단추')
            ok('다른 곳에서 바뀜' in chip_text(pa3) and store(pa3, 's.draft.stale') and store(pa3, 's.draft.dirty')
               and pa3.locator('[data-testid="chip-retry"]').inner_text().strip() == '다시 열기' and pa3.locator('[data-testid="chip-keep"]').inner_text().strip() == '이 글로 저장',
               f"창3 칩 「{chip_text(pa3).splitlines()[0]}」 — 저장 멈춤 [다시 열기] [이 글로 저장]")
            shot(pa3, '08d_draft_stale')
            time.sleep(3.2)   # 자동 저장(쉼 2.5초) 때가 지나도 멈춘 채 — 덮어쓰지 않는다
            m3 = rest(f'/api/docs/{d1}/drafts/mine')
            ok(m3['rev'] == m2['rev'] and {h['ref']: h['newText'] for h in m3['cr']['hunks']} == {'s0/p0': t0 + ' 더', 's0/p1': p1 + ' 창일'}, '멈춘 창3 은 자동 저장도 하지 않음(서버 = 창1 것 그대로)')
            pa3.evaluate('() => window.__wsRelease()')   # 늦게 온 알림을 받아도 그대로 멈춤
            time.sleep(1.0)
            ok(store(pa3, 's.draft.stale') and pa3.locator('[data-testid="chip-keep"]').count() == 1 and '다른 곳에서 바뀜' in chip_text(pa3), f"늦게 온 알림 뒤에도 멈춘 채(칩 「{chip_text(pa3).splitlines()[0]}」)")
            pa3.click('[data-testid="chip-keep"]')
            want3 = {'s0/p1': p1 + ' 창일', 's0/p2': p2 + ' 창삼'}
            wait_until(lambda: {h['ref']: h['newText'] for h in rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks']} == want3, timeout=10, msg='창3 글로 덮어씀')
            m4 = rest(f'/api/docs/{d1}/drafts/mine')
            ok(m4['rev'] > m2['rev'] and not store(pa3, 's.draft.stale'), f"[이 글로 저장] → rev 없이 덮어씀(판 {m4['rev']}, 서버 = 창3 글)")
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p2')") == p2 + ' 창삼' and cw(pa, "cw.debug.text('s0/p0')") == t0, timeout=10, msg='창1 이 창3 글을 불러옴')
            ok(True, '창1(수정 없음)은 덮어쓴 수정본을 불러옴')
            # 덮어쓴 뒤 창3 은 새 판으로 계속 저장한다(헛된 DRAFT_STALE 없음)
            type_at(pa3, 's0/p1', 0, '앞 ')
            wait_until(lambda: {h['ref']: h['newText'] for h in rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks']}.get('s0/p1') == '앞 ' + p1 + ' 창일', timeout=15, msg='창3 자동 저장')
            ok(not store(pa3, 's.draft.stale') and rest(f'/api/docs/{d1}/drafts/mine')['rev'] > m4['rev'], f"창3 계속 고침 → 자동 저장(판 {rest(f'/api/docs/{d1}/drafts/mine')['rev']}, 멈춤 없음)")
            errors[n_err:] = [e for e in errors[n_err:] if 'status of 409' not in e]
            ctxA3.close()
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p1')") == '앞 ' + p1 + ' 창일', timeout=10, msg='창1 따라옴')
            pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
            wait_until(lambda: chip_text(pa) == '수정 없음' and cw(pa, "cw.debug.text('s0/p0')") == t0 and cw(pa, "cw.debug.text('s0/p1')") == p1, timeout=15, msg='정리')

            print('[8] A 타이핑 → [검토 요청] → 제출 → B 승인 → A 반영 → 두 편집기 모두 새 기준', flush=True)
            p2 = base1['s0/p2']; n2 = len(cps(p2))
            ADD = ' 덧붙인 문장'
            type_at(pa, 's0/p2', n2, ADD)   # 편집기를 눌러 키 입력이 가게(앞 단계의 잠금이 편집기 포커스를 뺐다)
            want2 = p2 + ADD
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p2')") == want2, timeout=6, msg='타이핑')
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='타이핑 뒤 자동 저장')
            ok(True, f"타이핑 → 자동 저장 칩 「{chip_text(pa)}」")
            cid2 = rest(f'/api/docs/{d1}/drafts/mine')['cr']['cid']
            pa.click('[data-testid="submit-cr"]')
            ok(store(pa, 's.tab') == 'cr' and store(pa, 's.submitOpen'), "[검토 요청] → 패널 '변경 요청' 탭 + 제출 창(s.submitOpen)")
            pa.wait_for_selector('.cr-submit .cr-submit-title', timeout=5000)
            # 제목 기본값 = 바뀐 것에서(문단 끝에 덧붙임 → '「덧붙인 문장」 추가') — 고칠 수 있다
            ttl0 = wait_until(lambda: pa.locator('.cr-submit .cr-submit-title').input_value(), timeout=10, msg='제목 기본값')
            ok(ttl0 == '「덧붙인 문장」 추가', f'검토 요청 제목 기본값 = 바뀐 낱말에서 「{ttl0}」')
            pa.fill('.cr-submit .cr-submit-title', '셋째 문단 보완')
            pa.click('.cr-submit .cr-submit-go')
            wait_until(lambda: pa.locator('[data-testid="cr-chip"]').count() == 1, timeout=10, msg='검토 중 칩')
            crchip = pa.locator('[data-testid="cr-chip"]').inner_text().strip()
            ok(crchip == f'검토 중 #{cid2} · 승인 0', f'칩 「{crchip}」')
            tt = wait_until(lambda: next((t for t in pa.locator('.toasts .toast').all_inner_texts() if f'#{cid2}' in t and '검토 요청했습니다' in t), None), timeout=5, msg='검토 요청 알림')
            ok('을(를)' not in tt and '(를)' not in tt, f'검토 요청 알림 — 조사를 골라 씀 「{tt}」')
            shot(pa, '09_submitted')
            # 승인 전 반영 → NEED_APPROVAL(store 가 서버 오류 코드를 그대로 던진다)
            # (일부러 부르는 실패 — 브라우저가 403 응답을 console.error 로 남기므로 이 사이에 생긴 403 기록만 뺀다)
            n_err = len(errors)
            code = pa.evaluate('(c) => window.__doc.mergeCr(c).then(() => "merged", (e) => e.code)', cid2)
            ok(code == 'NEED_APPROVAL', f'승인 전 반영 → {code}')
            time.sleep(0.3)
            errors[n_err:] = [e for e in errors[n_err:] if 'status of 403' not in e]
            wait_until(lambda: any(c['cid'] == cid2 and c['status'] == 'open' for c in store(pb, 's.crs')), timeout=10, msg='B 목록에 검토 중')
            pb.evaluate("(c) => window.__doc.reviewCr(c, 'approve', '좋습니다')", cid2)
            ok(True, 'B 승인(d.reviewCr)')
            # 작성자(A)에게: 남이 내 변경 요청을 승인함 → 알림 + 칩의 승인 수
            ta = wait_until(lambda: next((t for t in pa.locator('.toasts .toast').all_inner_texts() if f"{B['name']} 님이 내 변경 요청 #{cid2}" in t), None), timeout=10, msg='A 에게 승인 알림')
            ok('승인했습니다' in ta and '(를)' not in ta, f'A 알림 「{ta}」')
            want_chip = f'검토 중 #{cid2} · 승인 1'
            wait_until(lambda: pa.locator('[data-testid="cr-chip"]').inner_text().strip() == want_chip, timeout=10, msg='칩 승인 1')
            ok(True, f'A 칩 「{want_chip}」')
            # 승인 뒤 막판에 친 글(자동 저장 전): 반영 전에 먼저 저장한다(반영·다시 열기 동안 편집기 잠금). 승인은 승인한 내용에만 붙으므로
            # (서버 §3.3 — 승인 뒤 수정본이 바뀌면 그 승인은 다시 받아야 함) 그 반영은 NEED_APPROVAL 로 막히고 막판 글은 수정본에 저장된다 → 다시 승인 → 반영
            LAST = '막판 '
            type_at(pa, 's0/p2', 0, LAST)
            ok(store(pa, 's.draft.dirty') and rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks'][0]['newText'] == want2, '막판 타이핑 — 아직 서버에 저장 전')
            n_err = len(errors)
            mr = pa.evaluate('async (c) => { const d = window.__doc; const p = d.mergeCr(c).then((r) => ({ r }), (e) => ({ code: e.code, message: e.message })); const f = () => d.editor.frame();'
                             ' const lock = { label: d.editor.locked, inert: !!f().inert }; const r = await p; return { r, lock, after: { label: d.editor.locked, inert: !!f().inert } }; }', cid2)
            ok(mr['lock']['label'] == '반영하는 중…' and mr['lock']['inert'] and not mr['after']['label'] and not mr['after']['inert'], f"반영하는 동안 편집기 잠금({mr['lock']['label']}, inert) → 끝나면 풂")
            time.sleep(0.3)
            errors[n_err:] = [e for e in errors[n_err:] if 'status of 403' not in e]
            ok(mr['r'].get('code') == 'NEED_APPROVAL' and rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks'][0]['newText'] == LAST + want2,
               f"승인 뒤 막판 글 → 반영 전에 저장(수정본에 「{LAST}…」) → 승인이 낡아 반영 막힘({mr['r'].get('code')})")
            # 승인한 사람(B)에게: 내 승인이 낡음(작성자가 승인 뒤 수정본을 바꿈) → 알림 · 검토 목록에 '승인(내용 바뀜)'(옅게) ·
            # 수는 CRView staleApprovals(승인 0 · 다시 승인 필요 1). 작성자(A) 칩도 승인 0
            tb2 = wait_until(lambda: next((t for t in pb.locator('.toasts .toast').all_inner_texts() if f'변경 요청 #{cid2} 내용이 바뀌어 내 승인이 무효가 됐습니다' in t), None), timeout=10, msg='B 에게 승인 무효 알림')
            ok('다시 확인해 주세요' in tb2, f'B 알림 「{tb2}」')
            pb.evaluate("(c) => { const s = window.__doc.s; s.tab = 'cr'; s.crOpen = c; }", cid2)
            detb = pb.locator(f'.cr-detail[data-cid="{cid2}"]')
            wait_until(lambda: detb.locator('.cr-review.stale').count() == 1, timeout=10, msg='B 상세: 낡은 승인')
            metab = detb.locator('.cr-meta').first.inner_text()
            stale_pill = detb.locator('.cr-review.stale .pill').inner_text().strip()
            ok(stale_pill == '승인(내용 바뀜)' and '승인 0' in metab and '다시 승인 필요 1' in metab
               and detb.locator('.cr-review.stale').evaluate('(e) => Number(getComputedStyle(e).opacity) < 0.9'),
               f'B 상세: 낡은 승인 「{stale_pill}」(옅게) · 수 「{metab.strip()[:60]}」')
            want_chip0 = f'검토 중 #{cid2} · 승인 0'
            wait_until(lambda: pa.locator('[data-testid="cr-chip"]').inner_text().strip() == want_chip0, timeout=10, msg='A 칩 승인 0')
            shot(pb, '09b_stale_approval')
            pb.evaluate("(c) => window.__doc.reviewCr(c, 'approve', '막판 글도 좋습니다')", cid2)
            wait_until(lambda: detb.locator('.cr-review[data-verdict="approve"]:not(.stale)').count() == 1 and '다시 승인 필요' not in detb.locator('.cr-meta').first.inner_text(), timeout=10, msg='B 다시 승인 → 살아 있는 승인')
            ok(True, 'B 다시 승인 → 검토 목록에 새 승인(낡은 것은 옅게 남음) · 다시 승인 필요 없어짐')
            mr = pa.evaluate('async (c) => { const d = window.__doc; const p = d.mergeCr(c); const f = () => d.editor.frame();'
                             ' const lock = { label: d.editor.locked, inert: !!f().inert }; const r = await p; return { r, lock, after: { label: d.editor.locked, inert: !!f().inert } }; }', cid2)
            res = mr['r']
            ok(mr['lock']['label'] == '반영하는 중…' and not mr['after']['label'] and not mr['after']['inert'], f"다시 승인 → 반영하는 동안 잠금({mr['lock']['label']}) → 끝나면 풂")
            ok(res and res.get('version') and res['cr']['status'] == 'merged', f"A 반영(d.mergeCr) → v{res and res.get('version')}")
            want2 = LAST + want2
            ok(para_text(d1, 's0/p2') == want2, f'기준 문서에 반영됨(막판에 친 「{LAST}」 포함)')
            wait_until(lambda: store(pa, 's.editor.ready && s.editor.source') == 'working' and chip_text(pa) == '수정 없음', timeout=20, msg='A 편집기 새 기준')
            ok(cw(pa, "cw.debug.text('s0/p2')") == want2, 'A 편집기 = 새 기준(수정본 끝)')
            wait_until(lambda: cw(pb, "cw.debug.text('s0/p2')") == want2, timeout=20, msg='B 편집기 새 기준')
            ok(store(pb, 's.editor.baseVersion') == res['version'] and store(pb, 's.draft.behind') == 0, f"B 편집기도 새 기준 v{res['version']}로 다시 열림")
            shot(pa, '10_merged_A')
            shot(pb, '10_merged_B')
            pb.evaluate("() => { const s = window.__doc.s; s.crOpen = null; s.tab = 'review'; }")

            print('[8b] A 수정 중에 기준 글이 바뀜 → 칩 최신 반영 필요 → [최신 반영] → 다시 맞춘 수정본 · B(수정 없음)는 저절로 새 기준', flush=True)
            p1 = base1['s0/p1']; n1 = len(cps(p1))
            ADD1 = ' 고침'
            q = point(pa, 's0/p1', 2)
            pa.mouse.click(q['x'], q['y'])   # 키 입력이 편집기로 가게(앞 단계에서 호스트 창을 눌렀다)
            cw(pa, 'cw.debug.select(arg[0], arg[1], arg[1])', ['s0/p1', n1])
            settle(pa)
            pa.keyboard.type(ADD1)
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='A 수정본 저장')
            v_before = rest(f'/api/docs/{d1}')['version']
            admin = USERS[0]['token']
            # 다른 문단(s0/p0 — 처리 안 된 변경 추적이 없는 곳)을 관리자가 기준에 바로 고친다
            pq = rest(f'/api/docs/{d1}/proposals', 'POST', {'ref': 's0/p0', 'find': '여기', 'replace': '이곳에', 'reason': '시험'}, token=admin)
            rest(f"/api/docs/{d1}/proposals/{pq['pid']}/apply", 'POST', {}, token=admin)
            new_p0 = para_text(d1, 's0/p0')
            ok('이곳에' in new_p0 and rest(f'/api/docs/{d1}')['version'] > v_before, f'관리자가 기준에 바로 적용 → s0/p0 「{new_p0}」')
            pa.locator('[data-testid="behind-chip"]').wait_for(timeout=10000)
            bt = pa.locator('[data-testid="behind-chip"]').inner_text()
            # 칩은 번호 없이(§9.7 — 기록 번호를 내지 않음): '새 버전 있음 → [최신으로 맞추기]', 설명에 'v1 이후 바뀜'
            btip = pa.locator('[data-testid="behind-chip"]').get_attribute('title') or ''
            ok('새 버전 있음' in bt and '최신으로 맞추기' in bt and not re.search(r'v\d', bt) and re.search(r'v\d+ 이후 바뀜', btip) and cw(pa, "cw.debug.text('s0/p0')") == t0,
               f"A 칩 「{bt.strip()}」(설명 「{btip[:30]}…」) · 편집기는 내 수정본 그대로(옛 기준)")
            wait_until(lambda: cw(pb, "cw.debug.text('s0/p0')") == new_p0, timeout=15, msg='B 저절로 새 기준')
            ok(store(pb, 's.draft.behind') == 0 and pb.locator('[data-testid="behind-chip"]').count() == 0, 'B(수정 없음)는 저절로 새 기준으로 다시 열림')
            shot(pa, '10b_behind')
            pa.locator('[data-testid="behind-chip"] button').click()
            wait_until(lambda: pa.locator('[data-testid="behind-chip"]').count() == 0 and cw(pa, "cw.debug.text('s0/p0')") == new_p0, timeout=20, msg='최신 반영')
            ok(cw(pa, "cw.debug.text('s0/p1')") == p1 + ADD1, f"[최신 반영] → 편집기 = 새 기준 + 내 수정(s0/p1 「…{ADD1}」, s0/p0 새 글)")
            mine = rest(f'/api/docs/{d1}/drafts/mine')
            ok(mine['cr'] and mine['cr']['baseVersion'] == rest(f'/api/docs/{d1}')['version'] and mine['cr']['hunkCount'] == 1, f"서버 수정본 기준 v{mine['cr'] and mine['cr']['baseVersion']}(지금 버전) · 덩어리 {mine['cr'] and mine['cr']['hunkCount']}")
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=10, msg='칩')
            ok(True, f"칩 「{chip_text(pa)}」")
            # 닫기 직전 친 글(자동 저장 전)도 닫힌 수정본에 남는다 → 다시 열면 돌아온다
            cid4 = mine['cr']['cid']
            CLOSE = '닫기 전 '
            type_at(pa, 's0/p1', 0, CLOSE)
            ok(store(pa, 's.draft.dirty'), '닫기 직전 타이핑(저장 전)')
            pa.evaluate('(c) => window.__doc.closeCr(c)', cid4)
            wait_until(lambda: store(pa, 's.editor.ready && s.editor.source') == 'working' and cw(pa, "cw.debug.text('s0/p1')") == p1, timeout=15, msg='닫음 → 기준')
            ok(rest(f'/api/docs/{d1}/change-requests/{cid4}')['status'] == 'closed', f'변경 요청 #{cid4} 닫힘 → 편집기 = 기준')
            # 관리자가 다시 열면(이 창 밖) 수정 없는 A 편집기는 그 수정본을 저절로 연다 — 닫기 전에 저장했으므로 막판 글도 있다
            rest(f'/api/docs/{d1}/change-requests/{cid4}/reopen', 'POST', {}, token=admin)
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p1')") == CLOSE + p1 + ADD1 and store(pa, 's.editor.ready && s.editor.source') == 'draft', timeout=15, msg='관리자 다시 열기 → A 편집기')
            ok(store(pa, 's.myCr && s.myCr.cid') == cid4 and not store(pa, 's.draft.stale'), f'관리자가 다시 엶 → A 편집기가 그 수정본을 저절로 엶(「{CLOSE}…{ADD1}」)')
            pa.evaluate('(c) => window.__doc.closeCr(c)', cid4)
            wait_until(lambda: store(pa, 's.editor.ready && s.editor.source') == 'working' and cw(pa, "cw.debug.text('s0/p1')") == p1, timeout=15, msg='다시 닫음')
            pa.evaluate('(c) => window.__doc.reopenCr(c)', cid4)
            wait_until(lambda: cw(pa, "cw.debug.text('s0/p1')") == CLOSE + p1 + ADD1 and store(pa, 's.editor.ready && s.editor.source') == 'draft', timeout=15, msg='다시 열기')
            ok(store(pa, 's.myCr && s.myCr.cid') == cid4, f'd.closeCr → d.reopenCr → 편집기 = 그 수정본(변경 요청 #{cid4})')
            pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
            wait_until(lambda: chip_text(pa) == '수정 없음' and cw(pa, "cw.debug.text('s0/p1')") == p1, timeout=15, msg='수정 버리기')
            ok(rest(f'/api/docs/{d1}/drafts/mine')['cr'] is None, 'd.discardMine → 수정본 없음 · 편집기 = 기준')

            print('[8c] 관리자가 내 변경 요청을 반영할 때 A 가 치는 중이면 다시 열지 않고 멈춤 → [이 글로 저장] → [최신 반영] → 친 글만 남음', flush=True)
            type_at(pa, 's0/p1', n1, ' 마지막')
            wait_until(lambda: re.fullmatch(r'수정 1문단 · 저장됨 \d\d:\d\d', chip_text(pa)), timeout=20, msg='저장')
            cid5 = rest(f'/api/docs/{d1}/drafts/mine')['cr']['cid']
            rest(f'/api/docs/{d1}/change-requests/{cid5}/submit', 'POST', {'title': '마지막 문장'})
            pa.keyboard.type(' 미저장')
            ok(store(pa, 's.draft.dirty'), 'A 치는 중(자동 저장 전)')
            rest(f'/api/docs/{d1}/change-requests/{cid5}/merge', 'POST', {}, token=admin)
            wait_until(lambda: store(pa, 's.draft.stale') and pa.locator('[data-testid="chip-keep"]').count() == 1, timeout=10, msg='A 저장 멈춤')
            ok(f'#{cid5} 반영됨' in chip_text(pa) and cw(pa, "cw.debug.text('s0/p1')") == p1 + ' 마지막 미저장' and para_text(d1, 's0/p1') == p1 + ' 마지막',
               f"관리자 반영 → A 편집기는 다시 열지 않음(친 글 남음) · 칩 「{chip_text(pa).splitlines()[0]}」")
            shot(pa, '10c_merged_while_typing')
            pa.click('[data-testid="chip-keep"]')
            wait_until(lambda: not store(pa, 's.draft.stale') and store(pa, 's.myCr && s.myCr.cid') not in (None, cid5) and pa.locator('[data-testid="behind-chip"]').count() == 1, timeout=10, msg='이 글로 저장')
            ok(True, '[이 글로 저장] → 새 수정본(옛 기준) · 칩 최신 반영 필요')
            pa.locator('[data-testid="behind-chip"] button').click()
            wait_until(lambda: pa.locator('[data-testid="behind-chip"]').count() == 0 and store(pa, 's.editor.ready && s.editor.source') == 'draft' and not store(pa, 's.editor.locked'), timeout=20, msg='최신 반영')
            hk5 = [(x['ref'], x['newText']) for x in rest(f'/api/docs/{d1}/drafts/mine')['cr']['hunks']]
            ok(hk5 == [('s0/p1', p1 + ' 마지막 미저장')] and cw(pa, "cw.debug.text('s0/p1')") == p1 + ' 마지막 미저장', f'[최신 반영] → 수정본 = 반영된 기준 + 친 글({hk5})')
            pa.evaluate('() => window.__doc.discardMine({ confirmFirst: false })')
            wait_until(lambda: chip_text(pa) == '수정 없음' and rest(f'/api/docs/{d1}/drafts/mine')['cr'] is None, timeout=15, msg='정리')

            print('[9] 좁은 창(880px — 패널이 아래로) → 문서 옆 메모 숨고 패널 검토 탭', flush=True)
            pa.set_viewport_size({'width': 880, 'height': 900})
            wait_until(lambda: pa.locator('[data-testid="rail"]').count() == 0, timeout=5, msg='문서 옆 메모 숨음')
            ok(store(pa, 's.railOpen') is False and store(pa, 's.tab') == 'review', "메모 숨음 → 패널 '검토' 탭")
            ok(pa.locator('.panel .tab-review').is_visible() and MEMO in pa.locator('.panel .tab-review').inner_text(), '검토 탭에 카드(메모)')
            fw = pa.evaluate(f'() => {FRAME_JS}.getBoundingClientRect().width')
            ok(fw > 600, f'편집기 폭 {fw:.0f}px')
            shot(pa, '11_narrow')
            pa.set_viewport_size({'width': 1440, 'height': 960})
            wait_until(lambda: pa.locator('[data-testid="rail"]').count() == 1, timeout=5, msg='문서 옆 메모 다시')
            ok(True, '넓히면 문서 옆 메모가 다시')

            if doc2:
                print('[10] 치자마자 다른 문서로 옮겨도 저장하고 옮김 → 표 문서 → 표 칸 선택 → 우클릭 AI에게 맡기기(표 칸 대상)', flush=True)
                d2 = doc2['id']
                QUICK = ' 급히'
                type_at(pa, 's0/p1', len(cps(para_text(d1, 's0/p1'))), QUICK)   # 지금 기준 글 끝([8c] 반영으로 늘었다)
                ok(store(pa, 's.draft.dirty') and rest(f'/api/docs/{d1}/drafts/mine')['cr'] is None, '친 직후(자동 저장 전) — 아직 서버에 수정본 없음')
                open_doc(pa, d2)   # 주소만 바꿈(브라우저 '뒤로'와 같은 길) → 화면을 옮기기 전에 저장
                mine = rest(f'/api/docs/{d1}/drafts/mine')
                ok(mine['cr'] and mine['cr']['hunks'][0]['newText'].endswith(QUICK), '옮기기 전에 저장(leaveGuard) — 수정본에 방금 친 글')
                rest(f'/api/docs/{d1}/drafts/mine', 'DELETE')
                fa = editor_frame(pa)
                paras2 = rest(f'/api/docs/{d2}/paragraphs')
                cell = next(x for x in paras2 if x.get('cell') and x['text'] == '268')
                ok(chip_text(pa) == '수정 없음' and store(pa, 's.draft.count') == 0, '표 문서: 열자마자 바꾼 문단 없음')
                cw(pa, 'cw.debug.select(arg[0], 0, 3)', [cell['ref']])
                settle(pa)
                sel = wait_until(lambda: (lambda x: x if x and x.get('ref') == cell['ref'] else None)(store(pa, 's.sel')), timeout=5, msg='표 칸 선택')
                ok(sel['cell'] and sel['text'] == '268', f"표 칸 선택 → {sel['ref']}")
                cp = point(pa, cell['ref'], 1)
                pa.mouse.click(cp['x'], cp['y'], button='right')
                fa.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
                ok(fa.evaluate("() => !document.querySelector('.context-menu [data-cowork-action=\"fill_table\"]')"), '표 칸 우클릭 → AI에게 맡기기(표 채우기 항목 없음 — 지시로)')
                fa.click('.context-menu [data-cowork-action="instruct"]')
                pa.wait_for_selector('.composer-win', timeout=5000)
                cmt = store(pa, '{ ref: s.composer.target.ref, kind: s.composer.kind }')
                ok(cmt['ref'] == cell['ref'] and cmt['kind'] == 'instruct' and pa.locator('.composer-win .chip.k.on').inner_text().strip() == '요청', f"요청 창: 표 칸 대상 · 종류 칩 '요청' {cmt}")
                pa.keyboard.press('Escape')
                shot(pa, '12_table_doc')

            v031_jobs(pa, tmp)
            review_fixes(context, pa, tmp, errors)
            v04_live(context, tmp, errors)
            v04_cell_enter(context, tmp, errors)

            bad = [e for e in errors if 'favicon' not in e]
            ok(not bad, f'페이지 오류 없음{"" if not bad else ": " + " | ".join(bad[:5])}')
            br.close()
    except OnlyReview:
        pass
    except Exception as ex:  # noqa: BLE001
        if not isinstance(ex, AssertionError):
            traceback.print_exc()
        elif not RESULTS or RESULTS[-1][0]:
            print(f'  ✗ {ex}', flush=True)
        RESULTS.append((False, f'중단: {ex}'))
        if errors:
            print('브라우저 오류:', *errors[:12], sep='\n  ', flush=True)
    finally:
        if srv:
            srv.terminate()
            try:
                srv.wait(timeout=10)
            except Exception:  # noqa: BLE001
                srv.kill()
        if log:
            log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    passed = sum(1 for r in RESULTS if r[0])
    print(f'\n결과: {passed}/{len(RESULTS)} 통과', flush=True)
    sys.exit(0 if passed == len(RESULTS) else 1)


if __name__ == '__main__':
    main()
