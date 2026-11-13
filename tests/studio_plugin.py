# studio cowork 플러그인 단독 시험(docs/V3_SPEC.md §6.1): 시험용 호스트 페이지(web/studio-test.html)로
# ready · 선택→ref(본문·표 칸) · 미니 도구 막대 · 우클릭 '검토' 구역(머리글·하위 메뉴·키보드, 표 개체 선택 중엔 없음) ·
# 강조 사각형 = studio 선택 사각형(배율 바꿔도) · 여백 표식·수정 중·입력 중·AI 작업·문단 추가 제안 표시 · focusRange(깜빡임·선택) ·
# applyText·insertParagraphAfter → studio 되돌리기 · applyBatch(여러 제안 — 되돌리기 한 번·다시하기 한 번, §9.6) ·
# 내 수정 표시(바꿈·넣음·지움) · edited/draft/editing/key/anchors 이벤트 ·
# (있으면) 표 문서·큰 보고서: 열자마자 정렬이 맞는지, 보이는 쪽만 계산하는지, 타이핑 중 플러그인 시간 ·
# 여러 문단 메모의 우클릭 구역 · 표 줄 추가(격자 바뀜) 뒤 칸 짝 끊김 · ?token= 을 주소창·Referer 에 남기지 않음 ·
# v0.4(docs/V4_SPEC.md §2.5): syncToBase(글 바꿈 — 손대지 않은 글 서식 그대로·칸·문단 넣기·지우기·STRUCTURE·캐럿·선택·스크롤 그대로·
# 되돌리기 기록 비움·edited 없음·큰 보고서 시간·칸 안 Enter/Backspace 로 칸 문단 수만 다른 칸은 접기(줄바꿈 — 다시 열지 않고 캐럿 그 자리)) ·
# setOptions({ readOnly })(입력 막힘·우클릭 반영 항목 숨김·맞추기는 됨·풀면 다시 입력) · flash.
#   python -I tests/studio_plugin.py   → 스크린숏 tests/out/studio_*.png, 서버 기록 tests/out/studio_server.log
# 서버는 포트 8793 에 임시 data 폴더 + 임시 config(토큰도 새로 만듦) + 모의 AI 로 띄운다(진짜 config.json·data/ 는 쓰지 않음).
# 편집기 빌드(studio/dist)가 cowork 플러그인을 품고 있어야 한다: node scripts/build-studio.mjs
import json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, time, traceback, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('STUDIO_PLUGIN_PORT', '8793'))
BASE = f'http://localhost:{PORT}'          # 브라우저 주소(CLAUDE.md)
REST = f'http://127.0.0.1:{PORT}'          # 시험 코드의 REST(IPv6 우회 지연 없이)
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/tests/fixtures/tool_memo_tracked.hwpx'
SMALL = f'{ROOT}/tests/samples/경영대학_경영전문대학원_응답자수_기초통계_2021-2025.hwpx'
BIG = f'{ROOT}/tests/samples/2025년_전체종합보고서.hwpx'
RESULTS = []
USERS = [
    {'name': '관리자', 'role': 'admin', 'token': secrets.token_hex(16)},
    {'name': '홍길동', 'role': 'editor', 'token': secrets.token_hex(16)},
    {'name': '김검토', 'role': 'editor', 'token': secrets.token_hex(16)},
]
ME = USERS[1]


def ok(cond, msg):
    RESULTS.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)
    if not cond:
        raise AssertionError(msg)


def rest(path, method='GET', body=None, headers=None, raw=False, token=None):
    h = {'Authorization': f'Bearer {token or ME["token"]}'}
    h.update(headers or {})
    data = None
    if body is not None:
        if raw:
            data = body
        else:
            data = json.dumps(body).encode('utf-8'); h['Content-Type'] = 'application/json'
    req = urllib.request.Request(REST + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        b = r.read()
        return json.loads(b) if 'json' in (r.headers.get('content-type') or '') else b


def upload(path, name):
    with open(path, 'rb') as f:
        return rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote(name), 'Content-Type': 'application/octet-stream'}, raw=True)


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
    pg.screenshot(path=f'{OUT}/studio_{name}.png')
    print(f'    → tests/out/studio_{name}.png', flush=True)


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
    }
    cfg_path = os.path.join(tmp, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=cfg_path, HWPX_COWORK_DATA_DIR=data, HWPX_COWORK_AI_MOCK='1', HWPX_COWORK_PORT=str(PORT), HWPX_COWORK_HOST='127.0.0.1')
    log = open(f'{OUT}/studio_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    conf = None
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError(f'서버가 시작하다 끝났습니다(code {srv.returncode}) — tests/out/studio_server.log')
        try:
            conf = json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read())
            if conf.get('nonce'):
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    if not conf or not conf.get('nonce'):
        raise RuntimeError('서버가 뜨지 않았습니다')
    me = rest('/api/me')
    if me.get('name') != ME['name']:
        raise RuntimeError(f'포트 {PORT} 의 서버가 이 시험의 서버가 아닙니다: {me}')
    return srv, log, conf


def open_doc(pg, did):
    pg.goto(f'{BASE}/studio-test.html?doc={did}')
    pg.wait_for_function('() => window.__ready === true || !!window.__error', timeout=120000)
    err = pg.evaluate('window.__error')
    ok(not err, f'시험 호스트 준비{"" if not err else ": " + err}')
    settle(pg)


def settle(pg):
    pg.evaluate('() => window.__cowork.debug.settled()')


def events(pg, typ, since=0):
    return pg.evaluate('([t, s]) => window.__events.filter((e) => e.type === t && e.t >= s).map((e) => e.payload)', [typ, since])


def now_ms(pg):
    return pg.evaluate('Date.now()')


def frame_offset(pg):
    return pg.evaluate("() => { const r = document.querySelector('#editor iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; }")


def point(pg, ref, off):
    """기준 (ref, offset) 의 화면 좌표(페이지 좌표 = iframe client + iframe 자리)"""
    p = pg.evaluate('([r, o]) => window.__cowork.debug.pointFor(r, o)', [ref, off])
    assert p, f'pointFor({ref}, {off}) 가 null'
    o = frame_offset(pg)
    return {'x': p['x'] + o['x'], 'y': p['y'] + o['y']}


def drag_select(pg, ref, start, end):
    a = point(pg, ref, start)
    b = point(pg, ref, end)
    a = point(pg, ref, start)  # 스크롤이 움직였을 수 있어 다시
    pg.mouse.move(a['x'], a['y'])
    pg.mouse.down()
    pg.mouse.move((a['x'] + b['x']) / 2, b['y'], steps=4)
    pg.mouse.move(b['x'], b['y'], steps=4)
    pg.mouse.up()
    time.sleep(0.2)
    settle(pg)


def selection(pg):
    return pg.evaluate('() => window.__cowork.debug.selection()')


def studio_highlights(fr):
    """studio 선택 표시(SelectionRenderer)의 보이는 사각형 — iframe client 좌표"""
    return fr.evaluate("""() => [...document.querySelectorAll('.selection-layer .selection-highlight')]
        .filter((d) => d.style.display !== 'none').map((d) => { const r = d.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })""")


def overlay_rects(pg, kind, oid):
    return [o['rect'] for o in pg.evaluate('() => window.__cowork.debug.overlays()') if o['kind'] == kind and o['id'] == oid and 'cw-box' in o['cls']]


def same_rects(a, b, tol=1.0):
    if len(a) != len(b):
        return False
    key = lambda r: (round(r['y']), round(r['x']))  # noqa: E731
    for p, q in zip(sorted(a, key=key), sorted(b, key=key)):
        if any(abs(p[k] - q[k]) > tol for k in ('x', 'y', 'w', 'h')):
            return False
    return True


def para_text(did, ref):
    return next((p['text'] for p in rest(f'/api/docs/{did}/paragraphs') if p['ref'] == ref), None)


# ───────── v0.4 맞추기(syncToBase) 시험 도우미 ─────────

BODY_RE = re.compile(r'^s(\d+)/p(\d+)$')


def make_base(paras, set_text=None, insert_after=None, remove=None):
    """서버 문단 목록(기준) → 남이 고친 새 기준 목록(본문 ref 를 다시 매김 — 중첩 ref·parent·표 열쇠도 따라감).
    set_text = {옛 ref: 새 글}(본문·칸), insert_after = {옛 본문 ref | '^s<구역>'(맨 앞): [넣을 글…]}, remove = [지울 옛 본문 ref].
    → (새 목록, {옛 본문 ref: 새 본문 ref})"""
    set_text = set_text or {}; insert_after = insert_after or {}; remove = set(remove or [])
    nested = {}
    for p in paras:
        if p.get('parent'):
            nested.setdefault(re.match(r'^(s\d+/p\d+)', p['ref']).group(1), []).append(p)
    secs = {}
    for p in paras:
        m = BODY_RE.match(p['ref'])
        if m and not p.get('parent'):
            secs.setdefault(int(m.group(1)), []).append(p)
    out = []; mapping = {}
    new_para = lambda ref, t: {'ref': ref, 'text': t, 'where': '본문', 'parent': None, 'kind': 'text' if t else 'empty', 'sig': ''}  # noqa: E731
    for s in sorted(secs):
        k = 0
        for t in insert_after.get(f'^s{s}', []):
            out.append(new_para(f's{s}/p{k}', t)); k += 1
        for p in sorted(secs[s], key=lambda q: int(BODY_RE.match(q['ref']).group(2))):
            old = p['ref']
            if old not in remove:
                new = f's{s}/p{k}'; k += 1; mapping[old] = new
                out.append(dict(p, ref=new, text=set_text.get(old, p['text'])))
                for n in nested.get(old, []):
                    r = dict(n, ref=new + n['ref'][len(old):], text=set_text.get(n['ref'], n['text']))
                    if r.get('parent'):
                        r['parent'] = new + r['parent'][len(old):]
                    if r.get('cell'):
                        r['cell'] = dict(r['cell'], table=new + r['cell']['table'][len(old):])
                    out.append(r)
            for t in insert_after.get(old, []):
                out.append(new_para(f's{s}/p{k}', t)); k += 1
    return out, mapping


def split_cell_base(paras, ref, parts):
    """기준 목록에서 1단 칸 문단 ref 하나를 parts 의 문단들로(같은 칸 — 칸 문단이 여럿인 서버 문서 꼴). 같은 본문 문단의 뒤 중첩 ref 는 그만큼 밀린다"""
    m = re.match(r'^(s\d+/p\d+)/n(\d+)$', ref)
    body, k = m.group(1), int(m.group(2)); extra = len(parts) - 1
    out = []
    for p in paras:
        mm = re.match(r'^(s\d+/p\d+)/n(\d+)(.*)$', p['ref'])
        if p['ref'] == ref:
            out.extend(dict(p, ref=f'{body}/n{k + t}', text=txt) for t, txt in enumerate(parts))
        elif mm and mm.group(1) == body and int(mm.group(2)) > k:
            out.append(dict(p, ref=f'{body}/n{int(mm.group(2)) + extra}{mm.group(3)}'))
        else:
            out.append(p)
    return out


def body_texts(paras):
    return {p['ref']: p['text'] for p in paras if not p.get('parent') and BODY_RE.match(p['ref'])}


def set_base(pg, paras, version):
    pg.evaluate('([b, v]) => window.__cowork.setBase({ version: v, paragraphs: b })', [paras, version])


def sync(pg):
    return pg.evaluate('() => window.__cowork.syncToBase()')


def texts_of(pg, refs):
    return pg.evaluate('(rs) => rs.map((r) => window.__cowork.debug.text(r))', list(refs))


def cw_stats(pg):
    return pg.evaluate('window.__cowork.debug.stats()')


def char_props(pg, ref, off):
    return pg.evaluate('([r, o]) => window.__cowork.debug.charProps(r, o)', [ref, off])


def scroll_pos(frame):
    return frame.evaluate("() => { const c = document.getElementById('scroll-container'); return [c.scrollTop, c.scrollLeft]; }")


def menu_info(frame):
    """열린 우클릭 메뉴의 '검토' 구역: 위층 동작·하위 메뉴(그 안 동작)"""
    return frame.evaluate("""() => {
        const m = document.querySelector('.context-menu');
        if (!m) return null;
        return {
          actions: [...m.querySelectorAll(':scope > [data-cowork-action]')].map((x) => x.dataset.coworkAction),
          subs: Object.fromEntries([...m.querySelectorAll(':scope > [data-cowork-sub]')].map((x) => [x.dataset.coworkSub,
            [...x.querySelectorAll('.cw-sub-panel [data-cowork-action]')].map((y) => y.dataset.coworkAction)])),
        };
    }""")


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx_studio_plugin_')
    srv = log = None
    errors = []
    try:
        srv, log, conf = start_server(tmp)
        st = conf.get('studio') or {}
        print(f'server up v{conf.get("version")} port {PORT} aiMock={conf.get("aiMock")} studio={st.get("mode")} built={st.get("built")} plugin={((st.get("buildInfo") or {}).get("plugin") or {}).get("version")}', flush=True)
        ok(st.get('built') and any(p['id'] == 'context-menu-hook' for p in (st.get('buildInfo') or {}).get('patches', [])), '편집기 빌드에 cowork 패치 2개(빌드 정보)')

        doc1 = upload(FIX, '메모_변경추적.hwpx'); d1 = doc1['id']
        base1 = {p['ref']: p['text'] for p in rest(f'/api/docs/{d1}/paragraphs')}
        # 사람 메모 하나(긴 범위) + 대기 제안 하나를 더 둔다
        t1 = base1['s0/p1']
        ms, me_ = cp_index(t1, '있던 낱말을 지우고')
        memo = rest(f'/api/docs/{d1}/memos', 'POST', {'ref': 's0/p1', 'start': ms, 'end': me_, 'text': '이 표현을 다듬어 주세요'})
        memo_id = memo.get('id') or memo.get('memoId') or (memo.get('memo') or {}).get('id')
        prop = rest(f'/api/docs/{d1}/proposals', 'POST', {'ref': 's0/p2', 'find': '셋째 문단은', 'replace': '셋째 문단도', 'reason': '시험'}, token=USERS[2]['token'])
        print(f'doc1 {d1} memo {memo_id} proposal #{prop.get("pid")}', flush=True)

        doc2 = upload(SMALL, '경영대학_기초통계.hwpx') if os.path.exists(SMALL) else None
        d2 = doc2['id'] if doc2 else None

        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)
            ctx = br.new_context(viewport={'width': 1400, 'height': 1000}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(ME['token'])}); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
            # 맞추기(v0.4) 절은 플러그인 경고·커서 자리 실패 경고도 없어야 한다(트랜잭션 안 커서 옮기기가 고친 문서에서 유효한지)
            warns = []
            pg.on('console', lambda m: warns.append(m.text) if m.type == 'warning' and ('[cowork]' in m.text or 'updateRect' in m.text) else None)
            pg.on('dialog', lambda d: d.accept())

            print('[1] 준비(ready)', flush=True)
            open_doc(pg, d1)
            frame = next(f for f in pg.frames if '/studio/' in f.url)
            ok(pg.evaluate('window.__cowork.version') == '0.4.0', '플러그인 판 0.4.0')
            ok(all(pg.evaluate(f'typeof window.__cowork.{n} === "function"') for n in ('syncToBase', 'flash', 'setOptions', 'applyBatch')), 'v0.4 API: syncToBase·flash')
            ok(len(events(pg, 'ready')) >= 1, 'ready 이벤트')
            stats = pg.evaluate('window.__cowork.debug.stats()')
            ok(stats['align']['hasBase'] and stats['viewReady'], f"기준 정렬 준비(본문 다시 읽기 {stats['align']['scans']}번)")
            names = frame.evaluate("() => [...document.querySelectorAll('.menu-item[data-menu] .md-item[data-cmd^=\"ext:cowork\"]')].map((e) => e.dataset.cmd)")
            ok(set(names) >= {'ext:cowork.memo', 'ext:cowork.ai-review', 'ext:cowork.panel'}, f'메뉴바 항목 {names}')
            shot(pg, '01_ready')

            print('[2] 선택 → 기준 ref (debug.select · 마우스 끌기)', flush=True)
            t0 = base1['s0/p0']
            s, e = cp_index(t0, '메모 대상 문장')
            since = now_ms(pg)
            ok(pg.evaluate('([r, s, e]) => window.__cowork.debug.select(r, s, e)', ['s0/p0', s, e]), 'debug.select')
            settle(pg)
            sel = pg.evaluate('() => window.__cowork.getSelection()')
            ok(sel and sel['ref'] == 's0/p0' and sel['start'] == s and sel['end'] == e and sel['text'] == '메모 대상 문장' and not sel['collapsed'], f"getSelection {sel and (sel['ref'], sel['start'], sel['end'], sel['text'])}")
            evs = wait_until(lambda: [x for x in events(pg, 'selection', since) if x and x['text'] == '메모 대상 문장'], msg='selection 이벤트')
            ok(evs[-1]['source'] == 'base' and evs[-1]['rect'] and evs[-1]['refs'] == ['s0/p0'], f"selection 이벤트 source={evs[-1]['source']} rect={evs[-1]['rect']}")
            # 마우스 끌기(메모 범위 '있던 낱말을 지우고' 안의 '낱말을')
            s2, e2 = cp_index(base1['s0/p1'], '낱말을')
            ok(ms <= s2 and e2 <= me_, '끌 자리가 메모 범위 안')
            drag_select(pg, 's0/p1', s2, e2)
            sel = selection(pg)
            ok(sel and sel['ref'] == 's0/p1' and (sel['start'], sel['end']) == (s2, e2) and sel['text'] == '낱말을', f"마우스 끌기 선택 {sel and (sel['ref'], sel['start'], sel['end'], sel['text'])}")
            ok(pg.evaluate("() => !!window.__frame.contentDocument.querySelector('.cw-mini') && window.__frame.contentDocument.querySelector('.cw-mini').style.display !== 'none'"), '미니 도구 막대가 보임')
            shot(pg, '02_selection')
            # 미니 도구 막대: [AI에게 맡기기] [AI에게 빠르게 맡기기 ▾] | [메모](docs/UI_TERMS.md §4 — 2026-11-03)
            bar = frame.evaluate("() => [...document.querySelectorAll('.cw-mini > button')].map((b) => [b.dataset.coworkAction, b.textContent])")
            ok(bar == [['instruct', 'AI에게 맡기기'], ['quick', 'AI에게 빠르게 맡기기 ▾'], ['memo', '메모']], f'도구 막대 세 단추 {bar}')
            # [AI에게 빠르게 맡기기 ▾] → 목록(검토하기·문장 고쳐 쓰기·구분선·다듬기 기준) → 공문서체로 → menu-action quick(id polish:formal)
            frame.click('.cw-mini [data-cowork-action="quick"]')
            drop = frame.evaluate("() => [...document.querySelectorAll('.cw-mini-drop > *')].map((x) => x.dataset.coworkQuick || x.className)")
            ok(drop[:4] == ['review', 'suggest', 'cw-mini-line', 'polish:concise'], f'빠르게 맡기기 목록(옵션 quickSend 없음 = 머리글 없음) {drop[:4]}')
            since = now_ms(pg)
            frame.click('.cw-mini-drop [data-cowork-quick="polish:formal"]')
            tb = wait_until(lambda: events(pg, 'menu-action', since), msg='빠르게 맡기기 menu-action')[-1]
            ok(tb['action'] == 'quick' and tb['quick'] == 'polish:formal' and tb['kind'] == 'instruct' and tb['source'] == 'toolbar' and tb['target']['text'] == '낱말을', f"도구 막대 빠르게 맡기기 → quick {tb.get('quick')}({tb.get('kind')})")
            # 바로 보내기(setOptions quickSend) → 목록 맨 위 보낼 곳 머리글 · 항목 cw-send
            pg.evaluate("() => window.__cowork.setOptions({ quickSend: 'Claude Code로 보내기' })")
            drag_select(pg, 's0/p1', s2, e2)
            frame.click('.cw-mini [data-cowork-action="quick"]')
            head = frame.evaluate("() => ({ head: document.querySelector('.cw-mini-drop .cw-mini-head')?.textContent, send: [...document.querySelectorAll('.cw-mini-drop button')].every((b) => b.classList.contains('cw-send')) })")
            ok(head['head'] == 'Claude Code로 보내기' and head['send'], f'바로 보내기: 머리글·보라 표시 {head}')
            frame.click('.cw-mini [data-cowork-action="quick"]')
            drag_select(pg, 's0/p1', s2, e2)
            # [AI에게 맡기기] → menu-action(source toolbar), 누른 뒤에도 선택은 그대로(mousedown 막음)
            since = now_ms(pg)
            frame.click('.cw-mini [data-cowork-action="instruct"]')
            tb = wait_until(lambda: events(pg, 'menu-action', since), msg='도구 막대 menu-action')[-1]
            ok(tb['action'] == 'instruct' and tb['source'] == 'toolbar' and tb['target']['ref'] == 's0/p1' and tb['target']['text'] == '낱말을', f"미니 도구 막대 [AI에게 맡기기] → menu-action {tb['action']}({tb['source']})")
            ok(selection(pg)['text'] == '낱말을' and frame.evaluate("() => document.querySelector('.cw-mini').style.display") == 'none', '누르면 막대는 숨고 선택은 그대로')

            print('[3] 우클릭 → 검토 구역', flush=True)
            mid = point(pg, 's0/p1', s2 + 1)
            pg.mouse.click(mid['x'], mid['y'], button='right')
            frame.wait_for_selector('.context-menu', timeout=5000)
            info = frame.evaluate("""() => {
                const m = document.querySelector('.context-menu');
                const kids = [...m.children];
                // 좁은 화면에서도 숨지 않게 studio '전체 선택' 하나는 검토 구역 위에 둔다(studio/plugin/menu.ts hook, 2026-11-01)
                const head = kids.findIndex((k) => k.matches('.cw-menu-head'));
                const firstStudio = kids.findIndex((k, i) => i > head && k.matches('.md-item[data-cmd]'));
                const lastCowork = kids.map((k, i) => (k.matches('[data-cowork-action],[data-cowork-sub],[data-cowork-head],[data-cowork-sep]') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
                return {
                  head: m.querySelector('.cw-menu-head')?.textContent, headIndex: kids.findIndex((k) => k.matches('.cw-menu-head')),
                  actions: [...m.querySelectorAll(':scope > [data-cowork-action]')].map((x) => x.dataset.coworkAction),
                  labels: [...m.querySelectorAll(':scope > .cw-row .md-label')].map((x) => x.textContent),
                  subs: [...m.querySelectorAll(':scope > [data-cowork-sub]')].map((x) => x.dataset.coworkSub),
                  above: kids.slice(0, Math.max(0, head)).map((k) => k.dataset.cmd || k.className),
                  firstStudio, lastCowork, studio: kids.filter((k) => k.matches('.md-item[data-cmd]')).length,
                };
            }""")
            print('    메뉴:', json.dumps(info, ensure_ascii=False), flush=True)
            ok(info['head'] == '검토' and info['above'] in ([], ['edit:select-all']), f"머리글 '검토'(위에는 studio 전체 선택만) {info['above']}")
            ok(info['lastCowork'] < info['firstStudio'] and info['studio'] > 3, f"검토 구역이 studio 항목({info['studio']}개) 위")
            ok(info['actions'] == ['instruct', 'memo'], f"위층: AI에게 맡기기… + 메모 달기 {info['actions']}")
            ok('AI에게 맡기기…' in info['labels'] and 'AI에게 빠르게 맡기기' in info['labels'], f"이름표 {info['labels']}")
            msub = next((x for x in info['subs'] if x.startswith('rv-memo:')), None)
            qacts = frame.evaluate("() => [...document.querySelectorAll('[data-cowork-sub=\"ai-shortcuts\"] .cw-sub-panel [data-cowork-action]')].map((x) => x.dataset.coworkAction)")
            ok(msub and 'ai-shortcuts' in info['subs'] and qacts and set(qacts) == {'quick'}, f"덮는 메모 하위 메뉴 · 빠르게 맡기기 하위 메뉴(모두 quick) {info['subs']} {qacts}")
            shot(pg, '03_menu')
            # 키보드: ↓ 로 덮는 메모 하위 메뉴까지 → → 로 하위 메뉴 → Esc 로 하위만 닫힘 → Esc 로 메뉴 닫힘
            rows = frame.evaluate("""() => [...document.querySelector('.context-menu').children]
                .filter((el) => (el.classList.contains('md-item') || el.classList.contains('cw-sub')) && !el.classList.contains('disabled'))
                .map((el) => el.dataset.coworkSub || el.dataset.coworkAction || el.dataset.cmd)""")
            k = rows.index(msub)
            for _ in range(k + 1):
                pg.keyboard.press('ArrowDown')
            cur = frame.evaluate("() => document.querySelector('.context-menu .cw-kb')?.dataset.coworkSub")
            ok(cur == msub, f'↓×{k + 1} → 메모 하위 메뉴 강조({cur})')
            pg.keyboard.press('ArrowRight')
            vis = frame.evaluate("""(id) => { const p = [...document.querySelectorAll('[data-cowork-sub]')].find((x) => x.dataset.coworkSub === id).querySelector(':scope > .cw-sub-panel'); const r = p.getBoundingClientRect();
                return { shown: getComputedStyle(p).display !== 'none' && r.width > 0, items: [...p.querySelectorAll('.md-item')].map((x) => x.textContent), kb: p.querySelector('.cw-kb')?.textContent }; }""", msub)
            ok(vis['shown'] and len(vis['items']) >= 2 and '보기' in vis['items'][0] and '답글' in vis['items'][1] and '보기' in vis['kb'], f"→ 로 메모 하위 메뉴(보기·답글 …, 첫 항목 강조) {vis}")
            pg.keyboard.press('ArrowDown')
            ok('답글' in frame.evaluate("(id) => [...document.querySelectorAll('[data-cowork-sub]')].find((x) => x.dataset.coworkSub === id).querySelector('.cw-kb')?.textContent", msub), '하위 메뉴 안 ↓')
            shot(pg, '04_submenu')
            pg.keyboard.press('Escape')
            ok(frame.evaluate("() => !!document.querySelector('.context-menu') && !document.querySelector('.cw-sub.cw-open')"), 'Esc → 하위 메뉴만 닫힘')
            pg.keyboard.press('Escape')
            ok(frame.evaluate("() => !document.querySelector('.context-menu')"), 'Esc → 메뉴 닫힘')
            ok(selection(pg)['text'] == '낱말을', '메뉴를 다룬 뒤에도 선택 그대로(↑↓ 가 편집기로 가지 않음)')
            # 'AI에게 맡기기…' → menu-action
            pg.mouse.click(mid['x'], mid['y'], button='right')
            frame.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
            since = now_ms(pg)
            frame.click('.context-menu [data-cowork-action="instruct"]')
            act = wait_until(lambda: events(pg, 'menu-action', since), msg='menu-action')[-1]
            ok(act['action'] == 'instruct' and act['kind'] == 'instruct' and act['target']['ref'] == 's0/p1' and act['target']['text'] == '낱말을' and act['anchor']['w'] >= 0, f"menu-action instruct target={act['target']['ref']} 「{act['target']['text']}」")
            ok(frame.evaluate("() => !document.querySelector('.context-menu')"), '누르면 메뉴가 닫힘')
            # 선택 밖을 우클릭 → 문단 전체 대상(힌트 '문단 전체')
            far = point(pg, 's0/p2', 2)
            pg.mouse.click(far['x'], far['y'], button='right')
            frame.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
            hint = frame.evaluate("() => document.querySelector('.context-menu [data-cowork-action=\"instruct\"] .md-shortcut')?.textContent")
            ok(hint == '문단 전체', f"AI에게 맡기기 → 범위 힌트 '문단 전체'({hint})")
            psubs = frame.evaluate("() => [...document.querySelectorAll('.context-menu > [data-cowork-sub]')].map((x) => x.dataset.coworkSub)")
            ok(any(x.startswith('rv-proposal:') for x in psubs), f'덮는 제안 하위 메뉴 {psubs}')
            since = now_ms(pg)
            frame.click('.context-menu [data-cowork-action="instruct"]')
            act = wait_until(lambda: events(pg, 'menu-action', since), msg='menu-action instruct(문단 전체)')[-1]
            ok(act['action'] == 'instruct' and act['target']['whole'] and act['target']['ref'] == 's0/p2' and act['target']['text'] == base1['s0/p2'], '문단 전체 대상(menu-action)')

            print('[4] 강조 사각형 = studio 선택 사각형(배율 바꿔도)', flush=True)
            mem = next(m for m in pg.evaluate('window.__annotations.memos') if m['id'] == str(memo_id))
            ok(mem['ref'] == 's0/p1' and (mem['start'], mem['end']) == (ms, me_), f'메모 범위 {mem["ref"]} {mem["start"]}..{mem["end"]}')
            for step in ('100%', 'zoom'):
                if step == 'zoom':
                    pg.evaluate("() => window.__studio.commands.execute('view:zoom-in')")
                    time.sleep(0.3)
                    pg.evaluate("() => window.__studio.commands.execute('view:zoom-in')")
                    time.sleep(0.4)
                settle(pg)
                pg.evaluate('([r, s, e]) => window.__cowork.debug.select(r, s, e)', ['s0/p1', ms, me_])
                settle(pg)
                want = studio_highlights(frame)
                have = overlay_rects(pg, 'memo', str(memo_id))
                zoom = frame.evaluate("() => document.getElementById('sb-zoom-val')?.textContent")
                ok(want and same_rects(have, want), f'{step}({zoom}): 메모 강조 {len(have)}개 = studio 선택 {len(want)}개 (±1px)')
            shot(pg, '05_overlay_zoom')
            pg.evaluate("() => window.__studio.commands.execute('view:zoom-100')")
            time.sleep(0.4); settle(pg)
            marks = [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-mark' in o['cls']]
            ok(len(marks) >= 2, f'오른쪽 여백 표식 {len(marks)}개')
            anchors = pg.evaluate('() => window.__cowork.anchors()')
            kinds = sorted({a['kind'] for a in anchors})
            ok({'memo', 'proposal', 'change'} <= set(kinds), f'anchors 종류 {kinds}')
            since = now_ms(pg)
            mk = next(m for m in marks if m['kind'] == 'memo' and m['id'] == str(memo_id)) if any(m['kind'] == 'memo' and m['id'] == str(memo_id) for m in marks) else marks[0]
            o = frame_offset(pg)
            pg.mouse.click(o['x'] + mk['rect']['x'] + mk['rect']['w'] / 2, o['y'] + mk['rect']['y'] + mk['rect']['h'] / 2)
            clk = wait_until(lambda: events(pg, 'annotation-click', since), msg='annotation-click')[-1]
            ok(clk['kind'] in ('memo', 'proposal', 'change', 'request') and clk['id'], f"여백 표식 클릭 → annotation-click {clk['kind']} {clk['id']}")
            # 강조 위 hover → annotation-hover, 강조를 그냥 누르면 annotation-click
            hb = overlay_rects(pg, 'memo', str(memo_id))[0]
            since = now_ms(pg)
            pg.mouse.move(o['x'] + hb['x'] + 4, o['y'] + hb['y'] + hb['h'] / 2)
            pg.mouse.move(o['x'] + hb['x'] + 8, o['y'] + hb['y'] + hb['h'] / 2)
            hv = wait_until(lambda: [x for x in events(pg, 'annotation-hover', since) if x and x['id'] == str(memo_id)], msg='annotation-hover')
            ok(hv[-1]['kind'] == 'memo', f"annotation-hover {hv[-1]}")
            pg.mouse.click(o['x'] + hb['x'] + 8, o['y'] + hb['y'] + hb['h'] / 2)
            ck = wait_until(lambda: [x for x in events(pg, 'annotation-click', since) if x['id'] == str(memo_id)], msg='강조 클릭')
            ok(ck[-1]['kind'] == 'memo' and ck[-1]['anchor']['w'] > 0, '강조 누르기 → annotation-click(메모)')
            pg.mouse.move(o['x'] + 5, o['y'] + 5)
            # setActive → 진하게, setOptions(overlays:false) → 숨김
            pg.evaluate("(id) => window.__cowork.setActive({ kind: 'memo', id })", str(memo_id))
            settle(pg)
            act_cls = [x['cls'] for x in pg.evaluate('() => window.__cowork.debug.overlays()') if x['id'] == str(memo_id)]
            ok(act_cls and all('cw-active' in c for c in act_cls), f'setActive → cw-active({len(act_cls)}개)')
            pg.evaluate('() => window.__cowork.setActive(null)')
            pg.evaluate('() => window.__cowork.setOptions({ overlays: false })')
            settle(pg)
            ok(frame.evaluate("() => getComputedStyle(document.querySelector('#scroll-content > .cowork-layer')).display") == 'none', 'setOptions({ overlays: false }) → 강조 층 숨김')
            pg.evaluate('() => window.__cowork.setOptions({ overlays: true })')
            settle(pg)
            ok(frame.evaluate("() => getComputedStyle(document.querySelector('#scroll-content > .cowork-layer')).display") != 'none', '다시 켬')

            print('[4b] 남의 수정 중 · 입력 중 표시 + 우클릭 하위 메뉴(제안·수정 중)', flush=True)
            pg.evaluate("""() => window.__cowork.setAnnotations({ ...window.__annotations,
                memos: [...window.__annotations.memos, { id: 'rq9', ref: 's0/p2', start: 7, end: 9, kind: 'request', label: 'AI 작업 #9', author: '홍길동', color: '#1c7ed6', status: 'working' }],
                proposals: [...window.__annotations.proposals, { pid: 99, type: 'insert', ref: 's0/p0', afterRef: 's0/p0', start: 0, end: 5, status: 'pending', label: '제안 #99 · 모의 AI' }],
                drafts: [{ cid: 3, user: '김검토', color: '#c2255c', status: 'open', hunks: [{ hid: 'h1', type: 'replace', ref: 's0/p2', preview: '셋째 문단을 이렇게 고쳤습니다' }] }],
                editing: [{ user: '김검토', color: '#c2255c', ref: 's0/p0' }] })""")
            settle(pg)
            ov = pg.evaluate('() => window.__cowork.debug.overlays()')
            ok(any('cw-dbar' in x['cls'] and x['id'] == '3:h1' for x in ov) and any('cw-dtag' in x['cls'] and x['text'] == '✎ 김검토' for x in ov), '수정 중 막대 + 이름표 ✎ 김검토')
            # 입력 중 표는 '● 이름'만(왼쪽 여백이 좁아 '입력 중'까지 쓰면 기본 배율에서 잘린다) — 마우스를 올리면 '이름 님이 입력 중', 누르기는 없음
            etag = next((x for x in ov if 'cw-etag' in x['cls']), None)
            ok(etag and etag['text'] == '● 김검토', f"입력 중 표 「{etag and etag['text']}」(이름만)")
            fit = frame.evaluate("() => { const e = document.querySelector('.cowork-marks > .cw-etag'); return e ? { sw: e.scrollWidth, cw: e.clientWidth } : null; }")
            ok(fit and fit['cw'] > 0 and fit['sw'] <= fit['cw'] + 1, f"입력 중 표가 잘리지 않음(글 {fit and fit['sw']}px ≤ 칸 {fit and fit['cw']}px)")
            o = frame_offset(pg)
            ex, ey = o['x'] + etag['rect']['x'] + etag['rect']['w'] - 6, o['y'] + etag['rect']['y'] + etag['rect']['h'] / 2
            pg.mouse.move(ex - 20, ey)
            pg.mouse.move(ex, ey)
            tip = wait_until(lambda: frame.evaluate("() => { const t = document.querySelector('.cw-tip'); return t && t.style.display !== 'none' ? t.textContent : null; }"), timeout=5, msg='입력 중 표 설명')
            ok(tip == '김검토 님이 입력 중', f'입력 중 표에 마우스 → 설명 「{tip}」')
            since = now_ms(pg)
            pg.mouse.click(ex, ey)
            time.sleep(0.4)
            ok(not events(pg, 'annotation-click', since), '입력 중 표를 눌러도 annotation-click 없음(알림만)')
            pg.mouse.move(o['x'] + 5, o['y'] + 5)
            ok(any('cw-box' in x['cls'] and 'cw-request' in x['cls'] and x['id'] == 'rq9' and x['kind'] == 'request' for x in ov), 'AI 작업 메모 = 보라 강조(cw-request)')
            ok(any('cw-proposal-after' in x['cls'] and x['id'] == '99' for x in ov), '문단 추가 제안 = 문단 끝 아래 주황 점선(cw-proposal-after)')
            ok(any('cw-mark-ai' in x['cls'] or 'cw-mark-mixed' in x['cls'] for x in ov), '여백 표식에 AI 작업(보라 또는 겹침)')
            ok(any(a['kind'] == 'draft' and a.get('cid') == 3 for a in pg.evaluate('() => window.__cowork.anchors()')), 'anchors 에 수정 중(draft)')
            shot(pg, '05b_drafts')
            bar = next(x for x in ov if 'cw-dbar' in x['cls'] and x['id'] == '3:h1')
            o = frame_offset(pg)
            since = now_ms(pg)
            pg.mouse.click(o['x'] + bar['rect']['x'] + bar['rect']['w'] / 2, o['y'] + bar['rect']['y'] + bar['rect']['h'] / 2)
            time.sleep(0.4)
            clicks = events(pg, 'annotation-click', since)
            ok(len(clicks) == 1 and clicks[0]['kind'] == 'draft' and clicks[0].get('cid') == 3 and clicks[0].get('hid') == 'h1', f'수정 중 막대 클릭 → annotation-click 한 번 {clicks}')
            pr = point(pg, 's0/p2', 2)
            pg.mouse.click(pr['x'], pr['y'], button='right')
            frame.wait_for_selector('.context-menu [data-cowork-sub="rv-draft:3:h1"]', timeout=5000)
            lab = frame.evaluate("() => document.querySelector('[data-cowork-sub=\"rv-draft:3:h1\"] > .md-label').textContent")
            lab_hint = frame.evaluate("() => document.querySelector('[data-cowork-sub=\"rv-draft:3:h1\"] > .md-shortcut')?.textContent")
            ok(lab == '✎ 김검토 수정 중' and lab_hint == '#3 검토 중', f'수정 중 하위 메뉴 「{lab}」 [{lab_hint}]')
            frame.hover(f'[data-cowork-sub="rv-proposal:{prop["pid"]}"]')
            since = now_ms(pg)
            frame.click(f'[data-cowork-sub="rv-proposal:{prop["pid"]}"] [data-cowork-action="proposal-adopt"]')
            ad = wait_until(lambda: events(pg, 'menu-action', since), msg='proposal-adopt')[-1]
            ok(ad['action'] == 'proposal-adopt' and ad['pid'] == prop['pid'] and ad['kind'] == 'proposal', f"제안 하위 메뉴 → menu-action proposal-adopt #{ad.get('pid')}")
            pg.mouse.click(pr['x'], pr['y'], button='right')
            frame.wait_for_selector('.context-menu [data-cowork-sub="rv-draft:3:h1"]', timeout=5000)
            frame.hover('[data-cowork-sub="rv-draft:3:h1"]')
            since = now_ms(pg)
            frame.click('[data-cowork-sub="rv-draft:3:h1"] [data-cowork-action="draft-comment"]')
            dc = wait_until(lambda: events(pg, 'menu-action', since), msg='draft-comment')[-1]
            ok(dc['action'] == 'draft-comment' and dc['cid'] == 3 and dc['hid'] == 'h1' and dc['kind'] == 'draft', f"수정 중 하위 메뉴 → menu-action draft-comment {dc.get('cid')}/{dc.get('hid')}")
            pg.evaluate('() => window.__cowork.setAnnotations(window.__annotations)')
            settle(pg)
            ok(not [x for x in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-dbar' in x['cls']], 'setAnnotations 는 통째로 바꾼다(수정 중 표시 사라짐)')
            # 여러 문단 메모(한글에서 단 메모 — 엔진은 end 없음 + endRef): buildAnnotations 가 끝 문단 끝까지로 채운 범위 그대로,
            # 가운데·끝 문단을 우클릭해도 그 메모 하위 메뉴가 나와야 한다(우클릭 구역이 범위를 첫 문단으로 줄이면 안 됨)
            mm = pg.evaluate("""async () => {
                const { buildAnnotations } = await import('/annotations.js');
                const a = buildAnnotations({ memos: [{ id: 'mm', ref: 's0/p0', start: 2, end: null, endRef: 's0/p2', author: '관리자', text: '여러 문단' }],
                    paragraphs: window.__paragraphs }, { me: window.__me.name });
                await window.__cowork.setAnnotations({ ...window.__annotations, memos: a.memos });
                return a.memos[0];
            }""")
            settle(pg)
            ok(mm['endRef'] == 's0/p2' and mm['end'] == len(cps(base1['s0/p2'])), f"buildAnnotations 여러 문단 메모 {mm['ref']}..{mm['endRef']}:{mm['end']}")
            ys = {round(r['y']) for r in overlay_rects(pg, 'memo', 'mm')}
            ok(len(ys) >= 3, f'여러 문단 메모 강조가 세 문단에 걸침(줄 {len(ys)}개)')
            for ref in ('s0/p0', 's0/p1', 's0/p2'):
                q = point(pg, ref, 3)
                pg.mouse.click(q['x'], q['y'], button='right')
                frame.wait_for_selector('.context-menu', timeout=5000)
                subs = frame.evaluate("() => [...document.querySelectorAll('.context-menu > [data-cowork-sub]')].map((x) => x.dataset.coworkSub)")
                ok('rv-memo:mm' in subs, f'여러 문단 메모 — {ref} 우클릭에 메모 하위 메뉴 {subs}')
                pg.keyboard.press('Escape')
                wait_until(lambda: frame.evaluate("() => !document.querySelector('.context-menu')"), timeout=5, msg='메뉴 닫힘')
            pg.evaluate('() => window.__cowork.setAnnotations(window.__annotations)')
            settle(pg)
            # 메뉴바 항목·호스트 단축키
            since = now_ms(pg)
            pg.evaluate("() => window.__studio.commands.execute('ext:cowork.memo')")
            mb = wait_until(lambda: events(pg, 'menu-action', since), msg='메뉴바 menu-action')[-1]
            ok(mb['action'] == 'memo' and mb['source'] == 'menubar' and mb['target'] and mb['target']['ref'], f"메뉴바 '메모 달기' → menu-action(source menubar, {mb['target']['ref']})")
            pg.evaluate("() => window.__cowork.debug.select('s0/p0', 1, 1)")
            pg.keyboard.press('Control+Alt+m')
            ok(any(k['key'] == 'M' and k['ctrl'] and k['alt'] for k in events(pg, 'key', since)), 'Ctrl+Alt+M → key 이벤트')

            print('[5] focusRange — 스크롤 + 깜빡임', flush=True)
            if d2:
                open_doc(pg, d2)
                frame = next(f for f in pg.frames if '/studio/' in f.url)
                paras2 = rest(f'/api/docs/{d2}/paragraphs')
                ds2 = pg.evaluate('() => window.__cowork.draftState()')
                st2 = pg.evaluate('window.__cowork.debug.stats()')['align']
                ok(st2['paired'] == st2['basePara'] == st2['curPara'] and not ds2['changed'] and not ds2['inserted'] and not ds2['deleted'],
                   f"표 문서를 열자마자 정렬이 맞다(본문 {st2['paired']}/{st2['basePara']} 짝, 바꾼 문단·칸 없음 — 캡션 빈칸 차이는 같은 글)")
                ok(st2['sigDiff'] == 0 and st2['gridChanged'] == 0, f"열자마자 표 구조가 기준과 같다(sig 다름 {st2['sigDiff']}, 격자 다름 {st2['gridChanged']})")
                last = [p for p in paras2 if not p.get('parent') and p['text']][-1]
                frame.evaluate("() => { document.getElementById('scroll-container').scrollTop = 0; }")
                time.sleep(0.2)
                top0 = frame.evaluate("() => document.getElementById('scroll-container').scrollTop")
                okf = pg.evaluate('(r) => window.__cowork.focusRange({ ref: r, flash: true })', last['ref'])
                time.sleep(0.15)
                top1 = frame.evaluate("() => document.getElementById('scroll-container').scrollTop")
                flash = [x for x in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-flash' in x['cls']]
                vh = frame.evaluate("() => { const c = document.getElementById('scroll-container').getBoundingClientRect(); return { top: c.top, bottom: c.bottom }; }")
                ok(okf and top1 > top0 + 100, f'focusRange({last["ref"]}) 스크롤 {top0}→{top1}')
                ok(flash and all(vh['top'] <= f['rect']['y'] <= vh['bottom'] for f in flash), f'깜빡임 {len(flash)}개가 화면 안')
                shot(pg, '06_focus_flash')
                time.sleep(1.8)
                ok(not [x for x in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-flash' in x['cls']], '1.6초 뒤 깜빡임 사라짐')
                # select: 기준 범위가 편집기 선택이 된다(맨 위로 돌아간 뒤 — 스크롤도 다시)
                frame.evaluate("() => { document.getElementById('scroll-container').scrollTop = 0; }")
                time.sleep(0.2)
                okf = pg.evaluate('(r) => window.__cowork.focusRange({ ref: r, start: 1, end: 4, select: true, flash: false })', last['ref'])
                settle(pg)
                sel = selection(pg)
                ok(okf and sel and (sel['ref'], sel['start'], sel['end']) == (last['ref'], 1, 4) and sel['text'] == ''.join(cps(last['text'])[1:4]),
                   f"focusRange(select) → 선택 {sel and (sel['ref'], sel['start'], sel['end'], sel['text'])}")
                ok(frame.evaluate("() => document.getElementById('scroll-container').scrollTop") > 100, 'focusRange(select) 도 스크롤')

                print('[6] 표 칸 선택 → 중첩 ref', flush=True)
                cell = next(p for p in paras2 if p.get('cell') and p['text'] == '268')
                since = now_ms(pg)
                drag_select(pg, cell['ref'], 0, 3)
                sel = selection(pg)
                ok(sel and sel['ref'] == cell['ref'] and (sel['start'], sel['end']) == (0, 3) and sel['text'] == '268' and sel['cell'] and sel['tableKey'] == cell['cell']['table'], f"표 칸 끌기 {sel and (sel['ref'], sel['start'], sel['end'], sel['text'], sel['cell'], sel['tableKey'])}")
                ev = wait_until(lambda: [x for x in events(pg, 'selection', since) if x and x['ref'] == cell['ref'] and x['text'] == '268'], msg='표 칸 selection 이벤트')
                ok(ev[-1]['cell'] and ev[-1]['source'] == 'base', f"표 칸 selection 이벤트 {ev[-1]['ref']} cell={ev[-1]['cell']}")
                cm = point(pg, cell['ref'], 1)
                pg.mouse.click(cm['x'], cm['y'], button='right')
                frame.wait_for_selector('.context-menu [data-cowork-action="instruct"]', timeout=5000)
                ok(frame.evaluate("() => !document.querySelector('.context-menu [data-cowork-action=\"fill_table\"]')"), '표 칸 우클릭 → AI에게 맡기기(표 채우기 항목은 없음 — 지시로)')
                shot(pg, '07_cell_menu')
                pg.keyboard.press('Escape')
                ok(frame.evaluate("() => !document.querySelector('.context-menu')") and selection(pg)['text'] == '268', 'Esc 는 메뉴만 닫는다(표 개체 선택으로 넘어가지 않음)')
                # 표 개체 선택(칸 안에서 Esc) 중 우클릭 → studio 표 개체 메뉴만, '검토' 구역은 넣지 않는다
                pg.keyboard.press('Escape')
                wait_until(lambda: pg.evaluate('window.__cowork.debug.stats().editor.tableObject'), timeout=5, msg='표 개체 선택')
                pg.mouse.click(cm['x'], cm['y'], button='right')
                frame.wait_for_selector('.context-menu', timeout=5000)
                info = frame.evaluate("() => ({ head: !!document.querySelector('.context-menu .cw-menu-head'), cowork: document.querySelectorAll('.context-menu [data-cowork-action]').length, studio: document.querySelectorAll('.context-menu .md-item[data-cmd]').length })")
                ok(not info['head'] and info['cowork'] == 0 and info['studio'] > 0, f"표 개체 선택 중 우클릭 → 검토 구역 없음(studio 항목 {info['studio']}개)")
                ok(pg.evaluate('() => window.__cowork.debug.selection()') is None, '표 개체 선택 중 selection 은 null')
                pg.keyboard.press('Escape')
                wait_until(lambda: frame.evaluate("() => !document.querySelector('.context-menu')"), timeout=5, msg='메뉴 닫힘')
                cap = next(p for p in paras2 if p['ref'].endswith('/n0') and p['text'].startswith('[표'))
                pg.evaluate('([r]) => window.__cowork.debug.select(r, 0, 3)', [cap['ref']])
                settle(pg)
                sel = selection(pg)
                ok(sel and sel['ref'] == cap['ref'] and sel['source'] == 'base', f"캡션 선택 → {sel and (sel['ref'], sel['source'], sel['text'])}")
                # 표 칸에 반영 → 되돌리기
                since = now_ms(pg)
                res = pg.evaluate('(r) => window.__cowork.applyText({ ref: r, find: "268", replace: "270" })', cell['ref'])
                ok(res and res['ok'] and pg.evaluate('(r) => window.__cowork.debug.text(r)', cell['ref']) == '270', f'표 칸 applyText {res}')
                dr = wait_until(lambda: [x for x in events(pg, 'draft', since) if cell['ref'] in x['changed']], timeout=5, msg='표 칸 draft')
                ok(dr[-1]['changed'] == [cell['ref']], f"draft 칸 ref {dr[-1]['changed']}")
                pg.keyboard.press('Control+z')
                wait_until(lambda: pg.evaluate('(r) => window.__cowork.debug.text(r)', cell['ref']) == '268', timeout=5, msg='표 칸 되돌리기')
                ok(True, '표 칸 Ctrl+Z → 268')

                print('[6b] 표 줄 추가(격자 바뀜) → 그 표 칸은 기준 칸과 짝짓지 않음 · 표 문단만 바꾼 문단 → 되돌리기', flush=True)
                # 줄·칸을 넣거나 지우면 같은 (표, 행, 열) 자리에 다른 칸이 온다 — 자리로 짝지으면 메모·선택·반영이 엉뚱한 칸으로 간다(V3_SPEC §1.3)
                tbl_ref = cell['parent']
                below = next(p for p in paras2 if p.get('cell') and p['cell']['table'] == cell['cell']['table']
                             and p['cell']['row'] == cell['cell']['row'] + 1 and p['cell']['col'] == cell['cell']['col'])
                pg.evaluate("""(c) => window.__cowork.setAnnotations({ ...window.__annotations,
                    memos: [...window.__annotations.memos, { id: 'cm', ref: c, start: 0, end: 3, kind: 'memo', label: '관리자', author: '관리자', color: '#c2255c' }] })""", cell['ref'])
                settle(pg)
                ok(overlay_rects(pg, 'memo', 'cm'), '칸 메모 강조(줄 추가 전)')
                ok(pg.evaluate('([r]) => window.__cowork.debug.select(r, 1, 1)', [cell['ref']]), '268 칸에 캐럿')
                settle(pg)
                since = now_ms(pg)
                res = pg.evaluate("() => window.__studio.commands.execute('table:insert-row-above')")
                ok(res and res.get('ok'), f'table:insert-row-above {res}')
                dr = wait_until(lambda: [x for x in events(pg, 'draft', since) if x['changed'] == [tbl_ref]], timeout=5, msg='줄 추가 뒤 draft')
                ok(not dr[-1]['inserted'] and not dr[-1]['deleted'], f"draft 바꾼 문단 = 표 문단 하나 {dr[-1]['changed']}(칸 ref 없음)")
                settle(pg)
                texts = pg.evaluate('(rs) => rs.map((r) => window.__cowork.debug.text(r))', [cell['ref'], below['ref']])
                ok(texts == [None, None], f"격자가 바뀐 표의 칸은 지도 밖({cell['ref']}·{below['ref']} → {texts})")
                al = pg.evaluate('window.__cowork.debug.stats()')['align']
                ok(al['gridChanged'] == 1, f"격자가 바뀐 문단 {al['gridChanged']}개")
                ov = pg.evaluate('() => window.__cowork.debug.overlays()')
                ok(not [o for o in ov if o['kind'] == 'memo' and o['id'] == 'cm'], '그 표 칸의 메모는 그리지 않는다(새 빈 줄에 엉뚱하게 그리지 않음)')
                ok(any('cw-mine-changed' in o['cls'] for o in ov), '표 문단 왼쪽 여백에 바꾼 문단 막대')
                # 옮겨진 268 칸을 누르면: 칸 ref 가 아니라 표를 품은 본문 문단(근사, source draft) — 아래 칸(기준 77)의 ref 로 가지 않는다
                q = pg.evaluate("() => window.__cowork.debug.pointForText('268', 1, true)")
                ok(q, f'옮겨진 268 칸 자리 {q}')
                o = frame_offset(pg)
                pg.mouse.click(q['x'] + o['x'], q['y'] + o['y'])
                time.sleep(0.3)
                settle(pg)
                sel = pg.evaluate('() => window.__cowork.getSelection()')
                ok(sel and sel['ref'] == tbl_ref and sel['source'] == 'draft' and sel.get('paragraphText') == '268' and sel['cell'],
                   f"옮겨진 268 칸 누르기 → {sel and (sel['ref'], sel['source'], sel.get('paragraphText'), sel['cell'])}")
                shot(pg, '07b_row_inserted')
                # 빈 칸 채우기 꼴(find '')·바꿈 제안을 다른 칸에 쓰지 않는다, focusRange 도 엉뚱한 칸으로 가지 않는다
                r1 = pg.evaluate("(r) => window.__cowork.applyText({ ref: r, find: '', replace: '★' })", below['ref'])
                r2 = pg.evaluate("(r) => window.__cowork.applyText({ ref: r, find: '268', replace: '270' })", cell['ref'])
                ok(r1['reason'] == 'NO_PARAGRAPH' and r2['reason'] == 'NO_PARAGRAPH', f'격자가 바뀐 표 칸 applyText → {r1} {r2}')
                ok(pg.evaluate('(r) => window.__cowork.focusRange({ ref: r })', cell['ref']) is False, 'focusRange(격자가 바뀐 표 칸) → false')
                ok(pg.evaluate("() => window.__cowork.debug.pointForText('268★')") is None, '268 칸 글은 그대로')
                pg.keyboard.press('Control+z')
                wait_until(lambda: pg.evaluate('(r) => window.__cowork.debug.text(r)', cell['ref']) == '268', timeout=5, msg='줄 추가 되돌리기')
                settle(pg)
                ok(not pg.evaluate('() => window.__cowork.draftState()')['changed'] and overlay_rects(pg, 'memo', 'cm'), 'Ctrl+Z → 칸 짝이 돌아오고 칸 메모 강조도 다시')
                # 줄 하나 지우고 다른 줄 하나 넣기 — 행·열 수는 그대로라 격자만 보면 못 알아챈다(사이 줄이 한 칸씩 밀림). 줄 글로 알아채고 역시 짝짓지 않는다
                counts = {}
                for p in paras2:
                    counts[p['text']] = counts.get(p['text'], 0) + 1
                tcells = [p for p in paras2 if p.get('cell') and p['cell']['table'] == cell['cell']['table']]
                last_row = max(p['cell']['row'] for p in tcells)
                anchor = next((p for p in tcells if p['cell']['row'] == last_row and p['text'] and counts[p['text']] == 1), None)
                ok(anchor, f"마지막 줄에서 한 번만 나오는 칸 「{anchor and anchor['text']}」")
                pg.evaluate('([r]) => window.__cowork.debug.select(r, 1, 1)', [cell['ref']])
                settle(pg)
                since = now_ms(pg)
                pg.evaluate("() => window.__studio.commands.execute('table:delete-row')")
                wait_until(lambda: [x for x in events(pg, 'draft', since) if x['changed'] == [tbl_ref]], timeout=5, msg='줄 지운 뒤 draft')
                q = pg.evaluate('(t) => window.__cowork.debug.pointForText(t, 1, true)', anchor['text'])
                ok(q, f"줄을 지운 뒤 마지막 줄 칸 자리 {q}")
                o = frame_offset(pg)
                pg.mouse.click(q['x'] + o['x'], q['y'] + o['y'])
                time.sleep(0.3)
                settle(pg)
                since = now_ms(pg)
                res = pg.evaluate("() => window.__studio.commands.execute('table:insert-row-below')")
                wait_until(lambda: events(pg, 'draft', since), timeout=5, msg='줄 넣은 뒤 draft')
                settle(pg)
                al = pg.evaluate('window.__cowork.debug.stats()')['align']
                ds = pg.evaluate('() => window.__cowork.draftState()')
                texts = pg.evaluate('(rs) => rs.map((r) => window.__cowork.debug.text(r))', [cell['ref'], below['ref']])
                ok(res.get('ok') and al['sigDiff'] == 0 and al['gridChanged'] == 1 and texts == [None, None] and ds['changed'] == [tbl_ref],
                   f"줄 지우기 + 줄 넣기(격자 그대로, sig 다름 {al['sigDiff']}) → 줄 밀림을 알아채 칸 짝 끊김({texts}, 바꾼 문단 {ds['changed']})")
                ok(not overlay_rects(pg, 'memo', 'cm'), '밀린 표의 칸 메모도 그리지 않는다(아래 줄 칸에 엉뚱하게 그리지 않음)')
                for _ in range(2):
                    pg.keyboard.press('Control+z')
                    time.sleep(0.3)
                wait_until(lambda: pg.evaluate('(r) => window.__cowork.debug.text(r)', cell['ref']) == '268', timeout=5, msg='줄 지우기·넣기 되돌리기')
                settle(pg)
                ok(not pg.evaluate('() => window.__cowork.draftState()')['changed'] and overlay_rects(pg, 'memo', 'cm'), 'Ctrl+Z 두 번 → 칸 짝·칸 메모 강조가 돌아옴')
                pg.evaluate('() => window.__cowork.setAnnotations(window.__annotations)')

                print('[6c] applyBatch — 여러 문단·같은 문단 두 곳·표 칸·문단 뒤에 넣기·겹침·못 찾음 → 되돌리기 한 번·다시하기 한 번', flush=True)
                open_doc(pg, d2)  # 새로 열어 되돌리기 기록을 비운다
                frame = next(f for f in pg.frames if '/studio/' in f.url)
                b2 = {p['ref']: p['text'] for p in paras2}
                n8 = 's0/p3/n8'
                ok(b2[n8] == '268' and b2['s0/p3'] == '' and b2['s0/p4'].count('소계는') == 1, '시험 문단(표 문단 s0/p3 · 칸 268 · 주석 문단 s0/p4)')
                items = [
                    {'op': 'text', 'ref': 's0/p4', 'find': '소계는', 'replace': '소계란', 'key': 'a'},
                    {'op': 'text', 'ref': 's0/p4', 'find': '진행과정', 'replace': '재학과정', 'key': 'b'},        # 같은 문단 두 곳
                    {'op': 'text', 'ref': n8, 'find': '268', 'replace': '270', 'key': 'c'},                    # 표 칸
                    {'op': 'insert', 'afterRef': 's0/p2', 'text': '새 문단 하나\n새 문단 둘', 'key': 'd'},     # 문단 뒤에 넣기(두 줄)
                    {'op': 'text', 'ref': 's0/p2', 'find': '응답자 수', 'replace': '응답자수', 'key': 'e'},     # + 같은 문단 바꾸기
                    {'op': 'text', 'ref': 's0/p4', 'find': '경영대학 소계', 'replace': 'X', 'key': 'f'},       # a 와 겹침 → OVERLAP
                    {'op': 'text', 'ref': 's0/p0', 'find': '없는 글', 'replace': 'x', 'key': 'g'},            # NOT_FOUND
                    {'op': 'text', 'ref': 's0/p99', 'find': 'a', 'replace': 'b'},                             # NO_PARAGRAPH(key 없음 → 7)
                    {'op': 'text', 'ref': 's0/p0', 'find': '응답자 수', 'replace': '응답자 인원'},                # key 없음 → 8, 문서 맨 앞 항목
                    {'op': 'insert', 'afterRef': 's0/p3', 'text': '표 뒤 문단', 'key': 'h'},                 # 표만 있는 문단 뒤(다음 문단 s0/p4 앞을 나눔)
                    {'op': 'text', 'ref': 's0/p6', 'start': 3, 'end': 3, 'replace': '★', 'key': 'i'},        # 한 점에 넣기
                    {'op': 'text', 'ref': 's0/p6', 'start': 3, 'end': 3, 'replace': '☆', 'key': 'j'},        # 같은 점 → OVERLAP
                ]
                since = now_ms(pg)
                t0 = time.time()
                res = pg.evaluate('(xs) => window.__cowork.applyBatch(xs)', items)
                batch_ms = (time.time() - t0) * 1000
                got = [(r['key'], r['ok'], r.get('reason')) for r in res['results']]
                want = [('a', True, None), ('b', True, None), ('c', True, None), ('d', True, None), ('e', True, None), ('f', False, 'OVERLAP'),
                        ('g', False, 'NOT_FOUND'), (7, False, 'NO_PARAGRAPH'), (8, True, None), ('h', True, None), ('i', True, None), ('j', False, 'OVERLAP')]
                ok(res['ok'] and res['applied'] == 8 and got == want, f"applyBatch {batch_ms:.0f}ms → applied {res['applied']}, 결과(items 순서·key 그대로, 없으면 번호) {got}")
                p6 = cps(b2['s0/p6'])
                expect = {
                    's0/p0': b2['s0/p0'].replace('응답자 수', '응답자 인원', 1),
                    's0/p2': b2['s0/p2'].replace('응답자 수', '응답자수', 1),
                    's0/p4': b2['s0/p4'].replace('소계는', '소계란', 1).replace('진행과정', '재학과정', 1),
                    's0/p6': ''.join(p6[:3]) + '★' + ''.join(p6[3:]),
                    n8: '270',
                }
                brefs = list(expect)
                btexts = lambda: pg.evaluate('(rs) => rs.map((r) => window.__cowork.debug.text(r))', brefs)  # noqa: E731
                now = btexts()
                ok(now == [expect[x] for x in brefs], f'바뀐 글 {dict(zip(brefs, now))}')
                ins_want = [{'afterRef': 's0/p2', 'text': '새 문단 하나'}, {'afterRef': 's0/p2', 'text': '새 문단 둘'}, {'afterRef': 's0/p3', 'text': '표 뒤 문단'}]
                ds = pg.evaluate('() => window.__cowork.draftState()')
                ok(sorted(ds['changed']) == sorted(brefs) and ds['inserted'] == ins_want and not ds['deleted'],
                   f"draftState: 바꾼 문단 {sorted(ds['changed'])} · 넣은 문단(문서 순서) {ds['inserted']}")
                caret = pg.evaluate('window.__cowork.debug.stats().editor.caret')
                # 2026-11-04 FIFO '모두 반영'(controller.ts commit): 입력 차례로 처리하고 캐럿은 마지막으로 처리한 편집의 끝 —
                # 마지막 성공 항목 i(s0/p6 의 3 에 '★')는 d(두 문단)·h(한 문단)를 넣은 뒤라 p9, 끝은 3 + 1
                ok(caret and caret['sectionIndex'] == 0 and caret['paragraphIndex'] == 9 and caret['charOffset'] == 4 and caret.get('parentParaIndex') is None,
                   f"캐럿 = 마지막으로 처리한 항목 i 의 끝(s0/p9:4) {caret}")
                settle(pg)
                eds = events(pg, 'edited', since)
                ok(len(eds) == 1, f'edited 이벤트 {len(eds)}번(트랜잭션 하나)')
                shot(pg, '07c_batch')
                pg.keyboard.press('Control+z')
                wait_until(lambda: btexts() == [b2[x] for x in brefs], timeout=5, msg='묶음 되돌리기 한 번')
                ds = pg.evaluate('() => window.__cowork.draftState()')
                ok(not ds['changed'] and not ds['inserted'] and not ds['deleted'], f'Ctrl+Z 한 번 → 여덟 항목이 모두 빠짐(바꾼·넣은 문단 없음) {ds}')
                pg.keyboard.press('Control+Shift+z')   # 다시 실행(Ctrl+Y 는 한/글처럼 한 줄 지우기 — CHANGELOG 2026-10-29)
                wait_until(lambda: btexts() == [expect[x] for x in brefs], timeout=5, msg='묶음 다시하기 한 번')
                ds = pg.evaluate('() => window.__cowork.draftState()')
                ok(sorted(ds['changed']) == sorted(brefs) and ds['inserted'] == ins_want, 'Ctrl+Y 한 번 → 모두 돌아옴(넣은 문단 차례까지)')
                # 뒤이은 하나짜리 applyText 는 따로 된 되돌리기(묶음과 섞이지 않음)
                r1 = pg.evaluate("() => window.__cowork.applyText({ ref: 's0/p3/n9', find: '205', replace: '207' })")
                ok(r1['ok'] and pg.evaluate("() => window.__cowork.debug.text('s0/p3/n9')") == '207', f'뒤이은 applyText {r1}')
                pg.keyboard.press('Control+z')
                wait_until(lambda: pg.evaluate("() => window.__cowork.debug.text('s0/p3/n9')") == '205', timeout=5, msg='applyText 되돌리기')
                ok(btexts() == [expect[x] for x in brefs], 'Ctrl+Z → 뒤이은 applyText 만 빠짐(묶음 반영은 그대로)')
                pg.keyboard.press('Control+z')
                wait_until(lambda: btexts() == [b2[x] for x in brefs], timeout=5, msg='묶음 되돌리기')
                ok(not pg.evaluate('() => window.__cowork.draftState()')['inserted'], 'Ctrl+Z 한 번 더 → 묶음 반영이 모두 빠짐')
                # 칸 문단 바꾸기 + 그 칸 문단 뒤에 넣기: 넣기를 먼저 고친다(나눌 자리 = 편집 전 길이). 거꾸로면 '205' + '칸 둘째 줄★' 이 된다
                res = pg.evaluate("""() => window.__cowork.applyBatch([
                    { op: 'text', ref: 's0/p3/n9', find: '205', replace: '205★' },
                    { op: 'insert', afterRef: 's0/p3/n9', text: '칸 둘째 줄' }])""")
                qa = pg.evaluate("() => window.__cowork.debug.pointForText('205★', 1, true)")
                qb = pg.evaluate("() => window.__cowork.debug.pointForText('칸 둘째 줄', 1, true)")
                ok(res['ok'] and res['applied'] == 2 and qa and qb and pg.evaluate("() => window.__cowork.debug.text('s0/p3/n9')") == '205★',
                   f"칸 문단 바꾸기 + 그 칸 문단 뒤에 넣기 → 칸 글 「205★」·「칸 둘째 줄」 {res['results']}")
                pg.keyboard.press('Control+z')
                wait_until(lambda: pg.evaluate("() => window.__cowork.debug.pointForText('칸 둘째 줄', 1, true)") is None, timeout=5, msg='칸 묶음 되돌리기')
                ok(pg.evaluate("() => window.__cowork.debug.text('s0/p3/n9')") == '205', 'Ctrl+Z 한 번 → 칸 둘 다 빠짐')
                # 같은 문단 뒤에 넣기 여럿(표만 있는 문단·글 문단) → 넣은 문단이 items 순서로 놓인다
                res = pg.evaluate("""() => window.__cowork.applyBatch([
                    { op: 'insert', afterRef: 's0/p3', text: '표 뒤 1' }, { op: 'insert', afterRef: 's0/p6', text: '글 뒤 1' },
                    { op: 'insert', afterRef: 's0/p3', text: '표 뒤 2' }, { op: 'insert', afterRef: 's0/p6', text: '글 뒤 2' }])""")
                ins = pg.evaluate('() => window.__cowork.draftState()')['inserted']
                ok(res['ok'] and res['applied'] == 4 and ins == [{'afterRef': 's0/p3', 'text': '표 뒤 1'}, {'afterRef': 's0/p3', 'text': '표 뒤 2'},
                                                                 {'afterRef': 's0/p6', 'text': '글 뒤 1'}, {'afterRef': 's0/p6', 'text': '글 뒤 2'}],
                   f'같은 문단 뒤에 넣기 여럿 → items 순서로 {ins}')
                pg.keyboard.press('Control+z')
                wait_until(lambda: not pg.evaluate('() => window.__cowork.draftState()')['inserted'], timeout=5, msg='넣기 여럿 되돌리기')
                ok(True, 'Ctrl+Z 한 번 → 넣은 문단 넷 모두 빠짐')
                # 한도·빈 목록·고칠 것 없음(트랜잭션을 만들지 않음 — edited 없음)
                since = now_ms(pg)
                many = [{'op': 'text', 'ref': 's0/p0', 'find': '응답자', 'replace': '응답자들'}] * 201
                rm = pg.evaluate('(xs) => window.__cowork.applyBatch(xs)', many)
                ok(not rm['ok'] and rm['reason'] == 'TOO_MANY' and rm['applied'] == 0 and len(rm['results']) == 201 and not any(x['ok'] for x in rm['results']),
                   f"201개 → TOO_MANY(results {len(rm['results'])}개 모두 실패)")
                re_ = pg.evaluate('() => window.__cowork.applyBatch([])')
                ok(re_['ok'] and re_['applied'] == 0 and re_['results'] == [], f'빈 목록 → {re_}')
                rn = pg.evaluate("""() => window.__cowork.applyBatch([{ op: 'text', ref: 's0/p0', find: '없는 글', replace: 'x' },
                    { op: 'insert', afterRef: 's0/p999', text: 'x' }, { op: 'table', ref: 's0/p0' }])""")
                time.sleep(0.4)
                ok(rn['ok'] and rn['applied'] == 0 and [x.get('reason') for x in rn['results']] == ['NOT_FOUND', 'NO_PARAGRAPH', 'BAD_ITEM'],
                   f"고칠 것이 없는 묶음 → ok·applied 0 {[x.get('reason') for x in rn['results']]}")
                ok(not events(pg, 'edited', since) and btexts() == [b2[x] for x in brefs], '한도 넘음·빈 목록·고칠 것 없음 → 트랜잭션 없음(edited 없음, 문서 그대로)')
                open_doc(pg, d1)
                frame = next(f for f in pg.frames if '/studio/' in f.url)

            print('[7] applyText → 되돌리기 1번', flush=True)
            since = now_ms(pg)
            res = pg.evaluate("() => window.__cowork.applyText({ ref: 's0/p2', find: '셋째 문단은', replace: '셋째 문단도' })")
            ok(res and res['ok'], f'applyText {res}')
            cur = pg.evaluate("() => window.__cowork.debug.text('s0/p2')")
            ok(cur == base1['s0/p2'].replace('셋째 문단은', '셋째 문단도', 1), f'문단 글 바뀜 「{cur}」')
            ed = wait_until(lambda: events(pg, 'edited', since), msg='edited')
            ok(ed[-1]['changeSeq'] >= 1, f"edited changeSeq={ed[-1]['changeSeq']}")
            dr = wait_until(lambda: [x for x in events(pg, 'draft', since) if 's0/p2' in x['changed']], timeout=5, msg='draft 이벤트')
            ok(dr[-1]['dirty'] and dr[-1]['changed'] == ['s0/p2'], f"draft {dr[-1]}")
            settle(pg)
            mine = [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-mine-changed' in o['cls']]
            ok(len(mine) == 1, f'내 수정 막대 {len(mine)}개')
            shot(pg, '08_applied')
            undo_from = now_ms(pg)
            pg.keyboard.press('Control+z')
            wait_until(lambda: pg.evaluate("() => window.__cowork.debug.text('s0/p2')") == base1['s0/p2'], timeout=5, msg='되돌리기')
            ok(True, 'Ctrl+Z 한 번으로 원래 글')
            dr2 = wait_until(lambda: [x for x in events(pg, 'draft', undo_from) if not x['changed']], timeout=5, msg='되돌린 뒤 draft')
            ok(not dr2[-1]['changed'], 'draft: 바꾼 문단 없음')
            settle(pg)
            ok(not [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-mine-changed' in o['cls']], '내 수정 막대 사라짐')
            # 찾는 글이 없으면 NOT_FOUND, 없는 문단이면 NO_PARAGRAPH
            ok(pg.evaluate("() => window.__cowork.applyText({ ref: 's0/p2', find: '없는 글', replace: 'x' })")['reason'] == 'NOT_FOUND', 'NOT_FOUND')
            ok(pg.evaluate("() => window.__cowork.applyText({ ref: 's0/p99', find: 'a', replace: 'x' })")['reason'] == 'NO_PARAGRAPH', 'NO_PARAGRAPH')

            print('[8] 문단 추가 → 정렬(기준 ref 유지) → 되돌리기', flush=True)
            since = now_ms(pg)
            res = pg.evaluate("() => window.__cowork.insertParagraphAfter({ afterRef: 's0/p0', text: '새로 넣은 문단입니다.' })")
            ok(res and res['ok'], f'insertParagraphAfter {res}')
            dr = wait_until(lambda: [x for x in events(pg, 'draft', since) if x['inserted']], timeout=5, msg='draft inserted')
            ok(dr[-1]['inserted'] == [{'afterRef': 's0/p0', 'text': '새로 넣은 문단입니다.'}] and not dr[-1]['changed'] and not dr[-1]['deleted'], f"draft {dr[-1]}")
            ok(pg.evaluate("() => window.__cowork.debug.text('s0/p1')") == base1['s0/p1'], '뒤 문단의 기준 ref 는 그대로(정렬)')
            settle(pg)
            have = overlay_rects(pg, 'memo', str(memo_id))
            pg.evaluate('([r, s, e]) => window.__cowork.debug.select(r, s, e)', ['s0/p1', ms, me_])
            settle(pg)
            ok(same_rects(have, studio_highlights(frame)), '문단을 넣은 뒤에도 메모 강조가 제자리')
            ins = [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-mine-inserted' in o['cls']]
            ok(len(ins) == 1, f'넣은 문단 = 왼쪽 여백 초록 막대 {len(ins)}개')
            pg.keyboard.press('Control+z')
            wait_until(lambda: not pg.evaluate('() => window.__cowork.draftState()')['inserted'], timeout=5, msg='되돌리기')
            ok(True, 'Ctrl+Z → 넣은 문단 사라짐')

            print('[8b] 문단 합치기(셋째 문단 지움) → 지운 자리 표시 → 되돌리기', flush=True)
            n1 = len(cps(base1['s0/p1']))
            # 문단 끝에 붙은 범위(변경 #1 삽입 「 (AI가 추가한 문장)」, s0/p1 32..45 = 문단 끝)의 강조 — 합친 뒤에도 그대로여야 한다
            ch1 = next(c for c in pg.evaluate('window.__annotations.changes') if c['type'] == 'Insert' and c['ref'] == 's0/p1' and c['end'] == n1)
            before = overlay_rects(pg, 'change', str(ch1['id']))
            ref_before = overlay_rects(pg, 'memo', str(memo_id))  # 같은 문단 첫 줄의 메모(스크롤과 무관한 비교 기준)
            pg.evaluate('(n) => window.__cowork.debug.select("s0/p1", n, n)', n1)
            settle(pg)
            ok(not pg.evaluate('window.__cowork.debug.stats().editor.selection'), '빈 범위 select 는 캐럿만(길이 0 선택을 남기지 않음)')
            since = now_ms(pg)
            pg.keyboard.press('Delete')
            dr = wait_until(lambda: [x for x in events(pg, 'draft', since) if x['deleted']], timeout=5, msg='draft deleted')
            ok(len(dr[-1]['deleted']) == 1 and len(dr[-1]['changed']) == 1 and not dr[-1]['inserted'], f"문단 끝에서 Delete → draft {dr[-1]}")
            settle(pg)
            ov = pg.evaluate('() => window.__cowork.debug.overlays()')
            ok(any('cw-mine-del' in o['cls'] for o in ov) and any('cw-mine-changed' in o['cls'] for o in ov), '지운 자리 빨간 삼각 + 바꾼 문단 파란 막대')
            after = overlay_rects(pg, 'change', str(ch1['id']))
            ref_after = overlay_rects(pg, 'memo', str(memo_id))
            # 합친 뒤 첫 줄은 양쪽 맞춤으로 글자 간격이 조금 벌어진다 — 같은 줄 한 조각, 너비가 거의 같으면 된다(늘어났다면 다음 줄까지 두 조각)
            ok(len(before) == 1 and len(after) == 1 and ref_before and ref_after
               and abs((after[0]['y'] - ref_after[0]['y']) - (before[0]['y'] - ref_before[0]['y'])) <= 1 and after[0]['w'] < before[0]['w'] * 1.3,
               f"문단 끝 범위는 합쳐 들어온 글까지 늘어나지 않는다(강조 {len(before)}→{len(after)}조각, 너비 {before and round(before[0]['w'])}→{after and round(after[0]['w'])})")
            shot(pg, '08b_merged')
            pg.keyboard.press('Control+z')
            wait_until(lambda: not pg.evaluate('() => window.__cowork.draftState()')['deleted'], timeout=5, msg='합치기 되돌리기')
            ok(pg.evaluate("() => window.__cowork.debug.text('s0/p2')") == base1['s0/p2'], 'Ctrl+Z → 문단이 다시 나뉨')
            settle(pg)
            ok(not [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-mine' in o['cls']], '내 수정 표시가 모두 사라짐')

            print('[9] 타이핑 → edited · editing · draft', flush=True)
            pg.evaluate("() => window.__cowork.debug.select('s0/p0', 2, 2)")
            settle(pg)
            since = now_ms(pg)
            pg.keyboard.type('가나')
            wait_until(lambda: [x for x in events(pg, 'editing', since) if x and x['ref'] == 's0/p0'], timeout=5, msg='editing 이벤트')
            ok(True, 'editing { ref: s0/p0 }')
            dr = wait_until(lambda: [x for x in events(pg, 'draft', since) if x['changed'] == ['s0/p0']], timeout=5, msg='draft')
            ok(len(events(pg, 'edited', since)) >= 2, f"edited {len(events(pg, 'edited', since))}번")
            sel = selection(pg)
            ok(sel and sel['source'] == 'draft' and sel['ref'] == 's0/p0' and sel['paragraphText'].startswith(base1['s0/p0'][:2] + '가나'), f"고친 문단 안 선택 source=draft ({sel and sel['start']})")
            pg.keyboard.press('Escape')
            ok(any(k['key'] == 'Escape' for k in events(pg, 'key', since)), 'key 이벤트(Esc)')
            shot(pg, '09_typed')

            print('[9b] 같은 편집기에 문서 다시 열기 → ready · 강조 층 다시 붙음', flush=True)
            n_ready = len(events(pg, 'ready'))
            pg.evaluate("""async () => {
                const r = await fetch(`/api/docs/${new URLSearchParams(location.search).get('doc')}/file?kind=working`, { headers: { Authorization: `Bearer ${localStorage.getItem('hwpx.token')}` } });
                await window.__studio.loadFile(new Uint8Array(await r.arrayBuffer()), 'document.hwpx', { suppressDialogs: true, skipUnsavedGuard: true });
            }""")
            wait_until(lambda: len(events(pg, 'ready')) > n_ready, timeout=20, msg='ready 다시')
            pg.evaluate('() => window.__cowork.setBase({ version: window.__version, paragraphs: window.__paragraphs })')
            pg.evaluate('() => window.__cowork.markClean()')
            pg.evaluate('() => window.__refreshAnnotations()')
            settle(pg)
            ok(frame.evaluate("() => !!document.querySelector('#scroll-content > .cowork-layer') && !!document.querySelector('#scroll-content > .cowork-marks')"), '강조 층이 #scroll-content 에 다시 붙음')
            ok(overlay_rects(pg, 'memo', str(memo_id)), '다시 연 문서에 메모 강조')
            dsx = pg.evaluate('() => window.__cowork.draftState()')
            ok(not dsx['dirty'] and not dsx['changed'], f'다시 연 문서는 깨끗함 {dsx}')

            print('[9c] syncToBase — 같은 문단 두 곳 바꿈(손대지 않은 글 서식 그대로)·문단 넣기·캐럿·되돌리기 기록 비움·edited 없음', flush=True)
            warn0 = len(warns)
            open_doc(pg, d1)  # 새로 열어 되돌리기 기록·내 수정을 비운다
            frame = next(f for f in pg.frames if '/studio/' in f.url)
            paras1 = rest(f'/api/docs/{d1}/paragraphs')
            ok(pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [], '새로 연 문서는 맞출 것이 없음(debug.syncPlan)')
            t1 = base1['s0/p1']
            ws, we = cp_index(t1, '낱말을')
            pg.evaluate('([r, s, e]) => window.__cowork.debug.select(r, s, e)', ['s0/p1', ws, we])
            ok((pg.evaluate("() => window.__studio.commands.execute('format:bold')") or {}).get('ok'), "사용자가 '낱말을' 굵게(손대지 않을 글의 서식)")
            settle(pg)
            ok(char_props(pg, 's0/p1', ws + 1)['bold'] and not char_props(pg, 's0/p1', 1)['bold'], '굵게 확인(그 낱말만)')
            k2 = cp_index(base1['s0/p2'], '문단은')[0]
            pg.evaluate('([r, s]) => window.__cowork.debug.select(r, s, s)', ['s0/p2', k2])
            settle(pg)
            sc0 = scroll_pos(frame)
            new_p1 = t1.replace('낱말을', '앞에 넣은 말 낱말을', 1)
            new_p1 = ''.join(cps(new_p1)[:-3]) + '끝을 바꿈'
            new_p0 = base1['s0/p0'].replace('메모 대상', '메모(바뀜) 대상', 1)
            base2, map2 = make_base(paras1, set_text={'s0/p0': new_p0, 's0/p1': new_p1}, insert_after={'s0/p0': ['남이 넣은 문단']})
            want2 = body_texts(base2)
            plan = pg.evaluate('(b) => { window.__cowork.setBase({ version: 2, paragraphs: b }); return window.__cowork.debug.syncPlan(); }', base2)
            ok(plan['ok'] and [e['op'] for e in plan['edits']] == ['text', 'ins', 'text'] and len(plan['edits'][0]['ops']) == 2,
               f"계획: 문서 뒤쪽부터 — 둘째 문단 글 조각 2개 → 첫 문단 뒤에 넣기 → 첫 문단 글 {[e['op'] for e in plan['edits']]}")
            since = now_ms(pg)
            res = sync(pg)
            ok(res['ok'] and res['changed'] == ['s0/p0', 's0/p2'] and res['inserted'] == ['s0/p1'] and res['deleted'] == 0,
               f"syncToBase → changed·inserted(기준 ref) {res}")
            ok(texts_of(pg, want2) == list(want2.values()), '편집기 본문 글 = 기준 글(바꾼 문단 둘·넣은 문단·그대로인 문단)')
            wb = cp_index(new_p1, '낱말을')[0]; wi = cp_index(new_p1, '앞에 넣은')[0]
            ok(char_props(pg, 's0/p2', wb + 1)['bold'] and not char_props(pg, 's0/p2', wi + 1)['bold'] and not char_props(pg, 's0/p2', 1)['bold'],
               '손대지 않은 낱말의 굵게는 그대로(넣은 글·앞 글은 굵게 아님)')
            caret = cw_stats(pg)['editor']['caret']
            ok(caret and (caret['paragraphIndex'], caret['charOffset']) == (3, k2) and caret.get('parentParaIndex') is None,
               f"캐럿: 뒤 문단은 넣은 문단만큼 밀리고 같은 글자 앞(s0/p2:{k2} → s0/p3:{k2}) {caret}")
            ok(scroll_pos(frame) == sc0, f'스크롤 그대로 {sc0}')
            st = cw_stats(pg)
            ok(st['canUndo'] is False and st['canRedo'] is False, '되돌리기·다시하기 기록 비움(굵게 한 기록도)')
            pg.keyboard.press('Control+z')
            time.sleep(0.4)
            ok(texts_of(pg, want2) == list(want2.values()) and char_props(pg, 's0/p2', wb + 1)['bold'], 'Ctrl+Z 를 눌러도 그대로(남의 글을 되돌리지 않음)')
            settle(pg)
            ok(not events(pg, 'edited', since), "맞추기는 'edited' 를 내지 않는다(호스트가 밀어 넣기를 예약하지 않게)")
            dr = wait_until(lambda: events(pg, 'draft', since), timeout=5, msg='맞춘 뒤 draft')
            ok(not dr[-1]['dirty'] and not dr[-1]['changed'] and not dr[-1]['inserted'] and not dr[-1]['deleted'], f"draft: 깨끗함(편집기 = 새 기준) {dr[-1]}")
            ok(st['changeSeq'] == st['cleanSeq'], f"changeSeq 그대로·깨끗함 {st['changeSeq']}/{st['cleanSeq']}")
            ok(pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [], '다시 맞출 것이 없음')
            r0 = sync(pg)
            ok(r0 == {'ok': True, 'changed': [], 'inserted': [], 'deleted': 0}, f'고칠 것이 없으면 트랜잭션 없이 ok {r0}')
            shot(pg, '09c_synced')
            # 글자 조각이 많으면(8개 넘음) 앞뒤 같은 부분을 뺀 가운데 하나로 — 다시 옛 기준으로 맞추기(되돌림)도 같은 길
            p3 = want2['s0/p3']
            p3m = ''.join(ch + ('·' if k % 2 == 0 else '') for k, ch in enumerate(cps(p3)))
            base2b, _ = make_base(base2, set_text={'s0/p3': p3m})
            plan = pg.evaluate('(b) => { window.__cowork.setBase({ version: 3, paragraphs: b }); return window.__cowork.debug.syncPlan(); }', base2b)
            ok(plan['ok'] and len(plan['edits']) == 1 and len(plan['edits'][0]['ops']) == 1, f"조각 {len(cps(p3m)) - len(cps(p3))}개 → 가운데 하나 {plan['edits'][0]['ops'] if plan.get('edits') else plan}")
            res = sync(pg)
            ok(res['ok'] and res['changed'] == ['s0/p3'] and texts_of(pg, ['s0/p3']) == [p3m], f'가운데 바꿈으로 맞춤 {res}')
            set_base(pg, base2, 2)
            res = sync(pg)
            ok(res['ok'] and res['changed'] == ['s0/p3'] and texts_of(pg, want2) == list(want2.values()) and char_props(pg, 's0/p2', wb + 1)['bold'],
               '옛 기준으로 다시 맞춤(되돌림 — 다른 문단 서식 그대로)')

            print('[9d] syncToBase — 편집기에만 있는 문단 지우기(그 안 캐럿 → 다음 문단 처음) · 선택 그대로(방향까지)', flush=True)
            pg.evaluate("() => window.__cowork.debug.select('s0/p1', 2, 2)")  # 남이 넣었던 문단 안
            settle(pg)
            base3, _ = make_base(base2, remove=['s0/p1'])
            want3 = body_texts(base3)
            set_base(pg, base3, 3)
            since = now_ms(pg)
            res = sync(pg)
            ok(res['ok'] and res['deleted'] == 1 and not res['changed'] and not res['inserted'], f'기준에서 지운 문단 → 편집기 문단 지움 {res}')
            ok(texts_of(pg, want3) == list(want3.values()) and len(want3) == 3, '편집기 본문 글 = 기준 글(세 문단)')
            caret = cw_stats(pg)['editor']['caret']
            ok(caret and (caret['paragraphIndex'], caret['charOffset']) == (1, 0), f'지운 문단 안 캐럿 → 다음 문단 처음(s0/p1:0) {caret}')
            # 선택: 셋째 문단의 '문단은'을 뒤에서 앞으로 선택한 채, 남이 그 앞에 글을 넣음 → 선택이 같은 글자에(방향 그대로)
            k3 = cp_index(want3['s0/p2'], '문단은')
            pg.evaluate('([r, s]) => window.__cowork.debug.select(r, s, s)', ['s0/p2', k3[1]])
            for _ in range(3):
                pg.keyboard.press('Shift+ArrowLeft')  # anchor 뒤 → focus 앞(거꾸로 선택)
            settle(pg)
            sel0 = selection(pg)
            ok(sel0 and sel0['text'] == '문단은' and cw_stats(pg)['editor']['caret']['charOffset'] == k3[0], f"거꾸로 선택 「{sel0 and sel0['text']}」")
            sel0 = (sel0['ref'], sel0['start'], sel0['end'])
            p2b = '앞에 ' + want3['s0/p2']
            base4, _ = make_base(base3, set_text={'s0/p2': p2b})
            set_base(pg, base4, 4)
            res = sync(pg)
            settle(pg)
            sel = selection(pg)
            raw = cw_stats(pg)['editor']
            ok(res['ok'] and res['changed'] == ['s0/p2'] and sel and (sel['ref'], sel['text']) == ('s0/p2', '문단은'),
               f"선택이 같은 글자에 남음({sel0} → {sel and (sel['ref'], sel['start'], sel['end'], sel['text'])})")
            ok(raw['caret']['charOffset'] == k3[0] + 3, f"focus(캐럿)는 앞쪽 그대로 — 방향 유지 {raw['caret']}")
            ok(not events(pg, 'edited', since) and not cw_stats(pg)['canUndo'], 'edited 없음·되돌리기 기록 없음')
            # 구역 맨 앞에 넣기(첫 문단을 앞에서 나눔 — 구역 정의는 첫 문단에 남는다) + 빈 줄
            pg.evaluate("() => window.__cowork.debug.select('s0/p0', 2, 2)")
            settle(pg)
            pages0 = cw_stats(pg)['pages']
            base5x, _ = make_base(base4, insert_after={'^s0': ['맨 앞에 남이 넣은 문단', '']})
            want5x = body_texts(base5x)
            set_base(pg, base5x, 5)
            res = sync(pg)
            ok(res['ok'] and res['inserted'] == ['s0/p0', 's0/p1'] and not res['changed'] and res['deleted'] == 0, f'구역 맨 앞에 글 문단 + 빈 줄 {res}')
            ok(texts_of(pg, want5x) == list(want5x.values()) and pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [], '편집기 본문 글 = 기준 글(다섯 문단)')
            caret = cw_stats(pg)['editor']['caret']
            ok(caret and (caret['paragraphIndex'], caret['charOffset']) == (2, 2), f'캐럿: 첫 문단 → 두 문단 밀림(s0/p0:2 → s0/p2:2) {caret}')
            ok(cw_stats(pg)['pages'] == pages0, f"쪽 수 그대로 {pages0}(구역 정의·쪽 설정이 첫 문단에 남음)")

            if d2:
                print('[9e] syncToBase — 표 칸·표 뒤에 넣기·스크롤 그대로·STRUCTURE(표 문단 지움·칸 지도 없음) · flash', flush=True)
                open_doc(pg, d2)
                frame = next(f for f in pg.frames if '/studio/' in f.url)
                paras2 = rest(f'/api/docs/{d2}/paragraphs')
                b2 = {p['ref']: p['text'] for p in paras2}
                n8 = 's0/p3/n8'
                ok(b2[n8] == '268', '시험 칸 s0/p3/n8 = 268')
                sp0 = pg.evaluate('() => window.__cowork.debug.syncPlan()')
                ok(sp0['ok'] and sp0['edits'] == [] and not sp0['issues'], f"표 문서를 새로 열면 맞출 것 없음(캡션 '[표  ]' 의 자동 번호 빈칸은 같은 글) {sp0['issues'][:2]}")
                pg.evaluate('([r]) => window.__cowork.debug.select(r, 1, 1)', [n8])
                settle(pg)
                frame.evaluate("() => { const c = document.getElementById('scroll-container'); c.scrollTop = c.scrollTop + 140; }")
                time.sleep(0.3)
                sc0 = scroll_pos(frame)
                cell0 = cw_stats(pg)['editor']['caret']
                p4 = b2['s0/p4'].replace('소계는', '소계(남이 고침)는', 1)
                base5, map5 = make_base(paras2, set_text={n8: '1,268', 's0/p4': p4}, insert_after={'s0/p3': ['표 뒤에 남이 넣은 문단']})
                want5 = body_texts(base5)
                set_base(pg, base5, 2)
                since = now_ms(pg)
                t0 = time.time()
                res = sync(pg)
                sync_ms = (time.time() - t0) * 1000
                ok(res['ok'] and res['changed'] == [n8, 's0/p5'] and res['inserted'] == ['s0/p4'] and res['deleted'] == 0, f'칸·본문·표 뒤 넣기 {sync_ms:.0f}ms {res}')
                ok(pg.evaluate('(r) => window.__cowork.debug.text(r)', n8) == '1,268' and texts_of(pg, want5) == list(want5.values()), '칸 글·본문 글 = 기준')
                al = cw_stats(pg)['align']
                ds = pg.evaluate('() => window.__cowork.draftState()')
                ok(al['sigDiff'] == 0 and al['gridChanged'] == 0 and not ds['changed'] and not ds['inserted'] and not ds['deleted'] and not ds['dirty'],
                   f"표는 그대로(표 뒤에 넣은 문단은 다음 문단 앞을 나눔 — sig 다름 {al['sigDiff']}, 격자 다름 {al['gridChanged']})")
                caret = cw_stats(pg)['editor']['caret']
                ok(caret and caret.get('parentParaIndex') == 3 and caret.get('cellIndex') == cell0.get('cellIndex') and caret['charOffset'] == 3,
                   f"칸 캐럿: 넣은 '1,' 만큼 뒤로(268 의 '6' 앞) {caret}")
                ok(scroll_pos(frame) == sc0, f'스크롤 그대로 {sc0} → {scroll_pos(frame)}(캐럿이 화면 밖이어도 끌려가지 않음)')
                ok(not events(pg, 'edited', since), 'edited 없음')
                # flash: 화면 안 범위는 밑줄 표시, 화면 밖 범위가 있어도 스크롤하지 않음
                frame.evaluate("() => { document.getElementById('scroll-container').scrollTop = 0; }")
                time.sleep(0.3); settle(pg)
                last = [p for p in base5 if not p.get('parent') and p['text']][-1]
                sc1 = scroll_pos(frame)
                okf = pg.evaluate("([a, b]) => window.__cowork.flash([{ ref: a }, { ref: b, start: 0, end: 4 }], { color: '#c2255c' })", ['s0/p0', last['ref']])
                settle(pg)
                fl = [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-rflash' in o['cls']]
                ok(okf is True and fl and all(o['rect']['h'] > 0 for o in fl), f'flash → 밑줄 {len(fl)}개(보이는 쪽)')
                ok(scroll_pos(frame) == sc1, f'flash 는 스크롤하지 않음 {sc1}')
                shot(pg, '09e_flash')
                time.sleep(1.8); settle(pg)
                ok(not [o for o in pg.evaluate('() => window.__cowork.debug.overlays()') if 'cw-rflash' in o['cls']], '1.5초 뒤 밑줄 사라짐')
                ok(pg.evaluate("() => window.__cowork.flash([{ ref: 's0/p999' }])") is False, '없는 문단 flash → false')
                # STRUCTURE: 기준에서 표 문단을 지움(편집기 표 문단을 지워야 함) → 아무것도 고치지 않음
                base6, _ = make_base(base5, remove=['s0/p3'])
                set_base(pg, base6, 3)
                since = now_ms(pg)
                res = sync(pg)
                ok(not res['ok'] and res['reason'] == 'STRUCTURE' and not res['changed'] and not res['inserted'] and res['deleted'] == 0, f'표 문단 지움 → STRUCTURE {res}')
                set_base(pg, base5, 2)
                ok(pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [], '편집기는 그대로(앞 기준과 같음)')
                # STRUCTURE: 기준에서 칸 문단 하나가 빠짐(칸 지도 없음) — 다른 문단 글이 바뀌었어도 아무것도 고치지 않는다
                base7 = [p for p in base5 if p['ref'] != n8]
                base7 = [dict(p, text=p['text'] + '!') if p['ref'] == 's0/p0' else p for p in base7]
                set_base(pg, base7, 4)
                res = sync(pg)
                ok(not res['ok'] and res['reason'] == 'STRUCTURE', f'칸 문단이 짝을 잃음 → STRUCTURE {res}')
                set_base(pg, base5, 2)
                ok(pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [] and pg.evaluate('(r) => window.__cowork.debug.text(r)', n8) == '1,268',
                   'STRUCTURE 뒤에도 편집기는 그대로(첫 문단도 안 바뀜)')
                ok(not events(pg, 'edited', since), 'STRUCTURE 는 edited 도 없음')

                print('[9e2] syncToBase — 칸 안 Enter·Backspace(칸 문단 수만 다름 — 서버는 글을 줄바꿈으로 접어 넣음) → 접기: 다시 열지 않고 캐럿 그 글자 자리 · '
                      '같은 표 다른 칸 남의 고침 · 빈 칸 문단 만들기 · 되돌리기 기록 비움 · edited 없음', flush=True)
                open_doc(pg, d2)  # 새로 연다(앞 절의 기준·고침 없이)
                frame = next(f for f in pg.frames if '/studio/' in f.url)
                paras2 = rest(f'/api/docs/{d2}/paragraphs')
                n14 = 's0/p3/n14'
                ok({p['ref']: p['text'] for p in paras2}[n14] == '77', '같은 표 다른 칸 s0/p3/n14 = 77')
                warn0 = len(warns)
                pg.evaluate('([r]) => window.__cowork.debug.select(r, 2, 2)', [n8])
                settle(pg)
                pg.keyboard.press('Enter')   # 칸 안 Enter → 칸 문단 둘('26' · '8')
                pg.keyboard.type('X')
                settle(pg)
                c0 = cw_stats(pg)['editor']['caret']
                ok(c0.get('parentParaIndex') == 3 and c0.get('cellParaIndex') == 1 and c0['charOffset'] == 1, f"칸 안 Enter + 'X' → 캐럿은 칸의 둘째 문단 {c0}")
                # 서버가 만드는 기준: 그 칸 문단 글은 '26⏎X8'(칸 문단 수 그대로) + 그새 남이 같은 표 다른 칸(77)을 고침
                base_f, _ = make_base(paras2, set_text={n8: '26\nX8', n14: '77(남)'})
                plan = pg.evaluate('(b) => { window.__cowork.setBase({ version: 2, paragraphs: b }); return window.__cowork.debug.syncPlan(); }', base_f)
                ok(plan['ok'] and sorted(e['op'] for e in plan['edits']) == ['fold', 'text'] and next(e for e in plan['edits'] if e['op'] == 'fold')['groups'][0] == 2,
                   f"계획: 그 칸 접기(칸 문단 둘 → 하나 · 줄바꿈) + 다른 칸 글 조각 {plan.get('edits') or plan}")
                since = now_ms(pg)
                syncs0 = cw_stats(pg)['perf'].get('syncs', 0)
                res = sync(pg)
                ok(res['ok'] and res['changed'] == [n14] and res['inserted'] == [] and res['deleted'] == 0,
                   f'syncToBase → ok(STRUCTURE 아님 — 다시 열지 않음) · 바뀐 자리는 남이 고친 칸만(내 줄바꿈 접기는 밑줄 깜빡임 없음) {res}')
                ok(texts_of(pg, [n8, n14]) == ['26\nX8', '77(남)'] and pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [],
                   '편집기 칸 글 = 기준(내 칸은 한 문단 안 줄바꿈 「26⏎X8」, 남이 고친 칸도) · 다시 맞출 것 없음(칸 문단 수도 같음)')
                c1 = cw_stats(pg)['editor']['caret']
                ok(c1.get('parentParaIndex') == 3 and c1.get('cellIndex') == c0.get('cellIndex') and c1.get('cellParaIndex') == 0 and c1['charOffset'] == 4,
                   f"캐럿: 접힌 문단 안 같은 글자 자리('26⏎X' 뒤 = 4) {c1}")
                st = cw_stats(pg)
                ok(st['canUndo'] is False and st['perf'].get('syncs', 0) == syncs0 + 1 and not events(pg, 'edited', since), "트랜잭션 한 번 · 되돌리기 기록 비움 · 'edited' 없음(밀어 넣기 예약 안 함)")
                pg.keyboard.type('Y')   # 이어 치면 그 자리에(표 밖·다른 줄로 가지 않음)
                settle(pg)
                ok(texts_of(pg, [n8]) == ['26\nXY8'], f"이어 친 'Y' 는 캐럿 자리에 「{(texts_of(pg, [n8])[0] or '').replace(chr(10), '⏎')}」")
                # 반대 꼴: 기준 칸 문단이 편집기보다 많음(내가 Backspace 로 칸 문단을 합친 뒤 서버가 뒤 문단을 비워 둔 모양) → 빈 칸 문단을 만들어 맞춤
                base_b = split_cell_base(make_base(paras2, set_text={n8: '26\nXY8', n14: '77(남)'})[0], n8, ['26\nXY8', ''])
                set_base(pg, base_b, 3)
                since = now_ms(pg)
                res = sync(pg)
                ok(res['ok'] and res['changed'] == [] and res['inserted'] == [] and res['deleted'] == 0, f'칸 문단 하나 모자람 → 빈 칸 문단을 만들어 맞춤(바뀐 글 없음) {res}')
                ok(texts_of(pg, [n8, 's0/p3/n9', 's0/p3/n10', 's0/p3/n15']) == ['26\nXY8', '', '205', '77(남)'] and pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [],
                   '편집기 칸 (1,1) = [「26⏎XY8」, 빈 문단] · 뒤 칸 글 그대로(기준 ref 가 하나씩 밀림)')
                c2 = cw_stats(pg)['editor']['caret']
                ok(c2.get('cellParaIndex') == 0 and c2['charOffset'] == 5 and not events(pg, 'edited', since), f"캐럿 그대로(첫 칸 문단 'Y' 뒤 = 5) · edited 없음 {c2}")
                ok(len(warns) == warn0, f'플러그인 경고 없음 {warns[warn0:][:2]}')
                shot(pg, '09e2_cell_fold')

            print('[9f] readOnly — 입력 막힘·반영 API READONLY·우클릭 반영/거절 숨김(메모·AI 요청 남김)·맞추기는 됨·풀면 다시 입력', flush=True)
            open_doc(pg, d1)
            frame = next(f for f in pg.frames if '/studio/' in f.url)
            pg.evaluate('() => window.__cowork.setOptions({ readOnly: true })')
            st = cw_stats(pg)
            ok(st['readOnly'] and st['editMode'] == 'form' and st['canUndo'] is False, f"readOnly → studio 양식 모드 {st['editMode']}")
            pg.evaluate("() => window.__cowork.debug.select('s0/p0', 2, 2)")
            settle(pg)
            since = now_ms(pg)
            pg.keyboard.type('가나')
            pg.keyboard.press('Backspace')
            pg.keyboard.press('Delete')
            time.sleep(0.5)
            ok(pg.evaluate("() => window.__cowork.debug.text('s0/p0')") == base1['s0/p0'] and not events(pg, 'edited', since), '읽기 전용: 타이핑·지우기가 들어가지 않음(edited 없음)')
            ra = pg.evaluate("() => window.__cowork.applyText({ ref: 's0/p2', find: '셋째', replace: '넷째' })")
            rb = pg.evaluate("() => window.__cowork.applyBatch([{ ref: 's0/p2', find: '셋째', replace: '넷째' }])")
            ri = pg.evaluate("() => window.__cowork.insertParagraphAfter({ afterRef: 's0/p0', text: 'x' })")
            ok(ra['reason'] == 'READONLY' and rb['reason'] == 'READONLY' and ri['reason'] == 'READONLY', f"반영 API → READONLY {ra} {rb['reason']} {ri}")
            pr = point(pg, 's0/p2', 2)
            pg.mouse.click(pr['x'], pr['y'], button='right')
            frame.wait_for_selector('.context-menu .cw-menu-head', timeout=5000)
            mi = menu_info(frame)
            psub = mi['subs'].get(f'rv-proposal:{prop["pid"]}')
            ok(psub == ['proposal-show'], f'제안 하위 메뉴에 반영·거절 없음(보기만) {psub}')
            ok({'instruct', 'memo'} <= set(mi['actions']) and set(mi['subs'].get('ai-shortcuts', [])) == {'quick'},
               f"AI에게 맡기기·빠르게 맡기기·메모 달기는 남음 {mi['actions']}")
            pg.keyboard.press('Escape')
            wait_until(lambda: frame.evaluate("() => !document.querySelector('.context-menu')"), timeout=5, msg='메뉴 닫힘')
            q = point(pg, 's0/p1', ms + 1)
            pg.mouse.click(q['x'], q['y'], button='right')
            frame.wait_for_selector('.context-menu .cw-menu-head', timeout=5000)
            mi = menu_info(frame)
            msub = mi['subs'].get(f'rv-memo:{memo_id}')
            ok(msub and {'memo-show', 'memo-reply', 'memo-resolve'} <= set(msub), f'메모 하위 메뉴(보기·답글·완료)는 그대로 {msub}')
            pg.keyboard.press('Escape')
            wait_until(lambda: frame.evaluate("() => !document.querySelector('.context-menu')"), timeout=5, msg='메뉴 닫힘')
            # 읽기 전용에서도 맞추기는 된다(양식 모드는 그대로)
            base8, _ = make_base(paras1, set_text={'s0/p0': base1['s0/p0'] + ' 읽기 전용에서도 들어옴'})
            set_base(pg, base8, 5)
            res = sync(pg)
            st = cw_stats(pg)
            ok(res['ok'] and res['changed'] == ['s0/p0'] and pg.evaluate("() => window.__cowork.debug.text('s0/p0')") == base8[0]['text'] and st['editMode'] == 'form',
               f"읽기 전용에서 syncToBase → 맞춤(양식 모드 그대로) {res}")
            # 보기 메뉴 등으로 양식 모드를 풀어도 읽기 전용이면 다시 양식 모드
            pg.evaluate("() => window.__studio.commands.execute('view:form-mode')")
            time.sleep(0.2)
            ok(cw_stats(pg)['editMode'] == 'form', '읽기 전용 동안 양식 모드를 풀면 다시 양식 모드')
            pg.evaluate('() => window.__cowork.setOptions({ readOnly: false })')
            ok(cw_stats(pg)['editMode'] == 'normal' and not cw_stats(pg)['readOnly'], 'readOnly 끔 → normal')
            pg.evaluate("() => window.__cowork.debug.select('s0/p0', 2, 2)")
            settle(pg)
            since = now_ms(pg)
            pg.keyboard.type('가나')
            wait_until(lambda: events(pg, 'edited', since), timeout=5, msg='readOnly 끈 뒤 edited')
            cur0 = pg.evaluate("() => window.__cowork.debug.text('s0/p0')")
            ok(''.join(cps(cur0)[2:4]) == '가나', f'readOnly 를 끄면 다시 입력된다 「{cur0[:12]}…」')
            ok(pg.evaluate("() => window.__cowork.applyText({ ref: 's0/p2', find: '셋째', replace: '넷째' })")['ok'], 'readOnly 끈 뒤 applyText 된다')
            ok(not warns[warn0:], f"맞추기·읽기 전용 절에 플러그인·커서 경고 없음{'' if not warns[warn0:] else ': ' + ' | '.join(warns[warn0:][:3])}")

            if os.path.exists(BIG):
                print('[10] 큰 보고서 — 반응(정렬·강조 계산 시간)', flush=True)
                doc3 = upload(BIG, '2025년_전체종합보고서.hwpx'); d3 = doc3['id']
                paras3 = rest(f'/api/docs/{d3}/paragraphs')
                body3 = [p for p in paras3 if not p.get('parent') and len(p['text']) > 20]
                for k, bp in enumerate(body3[5:60:6]):
                    tx = bp['text']
                    rest(f'/api/docs/{d3}/memos', 'POST', {'ref': bp['ref'], 'start': 0, 'end': min(8, len(cps(tx))), 'text': f'메모 {k}'})
                open_doc(pg, d3)
                frame = next(f for f in pg.frames if '/studio/' in f.url)
                tm = pg.evaluate('window.__timing')
                st = pg.evaluate('window.__cowork.debug.stats()')
                print(f"    열기 {tm.get('load')}ms · setBase {tm.get('setBase')}ms · 본문 읽기 {st['align']['lastScanMs']:.1f}ms · 강조 만들기 {st['perf']['lastBuildMs']:.1f}ms · 그리기 {st['perf']['lastRenderMs']:.1f}ms · 내 수정 계산 {st['perf']['lastDraftMs']:.1f}ms", flush=True)
                ok(st['align']['lastScanMs'] < 120, f"본문 다시 읽기 {st['align']['lastScanMs']:.1f}ms < 120ms")
                ok(st['perf']['lastDraftMs'] < 400, f"내 수정(칸 포함) 계산 {st['perf']['lastDraftMs']:.1f}ms < 400ms")
                ds3 = pg.evaluate('() => window.__cowork.draftState()')
                al = pg.evaluate('window.__cowork.debug.stats()')['align']
                ok(al['paired'] == al['basePara'] == al['curPara'] and not ds3['changed'] and not ds3['inserted'] and not ds3['deleted'],
                   f"큰 보고서도 열자마자 정렬이 맞다(본문 {al['paired']}/{al['basePara']} 짝, 칸 포함 바꾼 것 없음)")
                ok(al['sigDiff'] == 0 and al['gridChanged'] == 0, f"큰 보고서도 열자마자 표 구조가 기준과 같다(sig 다름 {al['sigDiff']}, 격자 다름 {al['gridChanged']})")
                sp3 = pg.evaluate('() => window.__cowork.debug.syncPlan()')
                ok(sp3['ok'] and sp3['edits'] == [] and not sp3['issues'], f"큰 보고서도 새로 열면 맞출 것 없음(표·그림 캡션·꼬리말) {sp3['issues'][:2]}")
                ok(0 < st['perf']['specs'] and st['perf']['candidates'] < st['perf']['specs'], f"보이는 쪽 근처만 사각형을 구한다(후보 {st['perf']['candidates']}/{st['perf']['specs']})")
                # anchors 이벤트: 스크롤하면 레일 자리(y)가 따라온다
                m0 = pg.evaluate('window.__annotations.memos')[0]
                pg.evaluate('(r) => window.__cowork.focusRange({ ref: r, flash: false })', m0['ref'])
                settle(pg)
                a0 = next(a for a in pg.evaluate('() => window.__cowork.anchors()') if a['id'] == m0['id'])
                since = now_ms(pg)
                frame.evaluate("() => { document.getElementById('scroll-container').scrollTop += 60; }")

                def moved():
                    for evs in reversed(events(pg, 'anchors', since)):
                        for a in evs:
                            if a['id'] == m0['id'] and abs((a0['y'] - a['y']) - 60) <= 2:
                                return a
                    return None
                a1 = wait_until(moved, timeout=5, msg='스크롤 뒤 anchors 이벤트')
                ok(a0['visible'] and a1['visible'] and a1['kind'] == 'memo', f"스크롤 60px → anchors 이벤트 y {a0['y']}→{a1['y']}")
                target = body3[30]
                pg.evaluate('(r) => window.__cowork.focusRange({ ref: r, flash: false })', target['ref'])
                pg.evaluate('(r) => window.__cowork.debug.select(r, 1, 1)', target['ref'])
                settle(pg)
                busy0 = pg.evaluate('window.__cowork.debug.stats().busy.ms')
                t0 = time.time()
                pg.keyboard.type('테스트 입력', delay=40)
                typing = time.time() - t0
                settle(pg)
                st = pg.evaluate('window.__cowork.debug.stats()')
                plugin_ms = st['busy']['ms'] - busy0
                ok(pg.evaluate('(r) => window.__cowork.debug.text(r)', target['ref']).startswith(target['text'][:1] + '테스트 입력'), '큰 문서 타이핑 반영')
                print(f"    6글자 타이핑 {typing * 1000:.0f}ms(그중 플러그인 {plugin_ms:.0f}ms — 나머지는 studio 조판) · 정렬 다시 {st['perf']['relayouts']}번(마지막 {st['perf']['lastRelayoutMs']:.1f}ms) · 선택 계산 {st['perf']['lastSelectionMs']:.1f}ms", flush=True)
                ok(st['perf']['lastRelayoutMs'] < 250, f"타이핑 뒤 정렬·강조 다시 계산 {st['perf']['lastRelayoutMs']:.1f}ms < 250ms")
                ok(plugin_ms < 6 * 40, f'타이핑 중 플러그인이 쓴 시간 {plugin_ms:.0f}ms(6글자, 글자당 40ms 미만)')
                # 문단을 넣은 뒤에도 그 아래 메모 강조가 studio 선택과 겹치는지(큰 문서 정렬)
                memos3 = pg.evaluate('window.__annotations.memos')
                below = next((m for m in memos3 if int(m['ref'].split('/p')[1]) > int(target['ref'].split('/p')[1])), None)
                if below:
                    res = pg.evaluate('(r) => window.__cowork.insertParagraphAfter({ afterRef: r, text: "큰 문서에 넣은 문단" })', target['ref'])
                    ok(res['ok'], f'큰 문서 insertParagraphAfter {res}')
                    settle(pg)
                    pg.evaluate('(r) => window.__cowork.focusRange({ ref: r, flash: false })', below['ref'])
                    settle(pg)
                    have = overlay_rects(pg, 'memo', below['id'])
                    pg.evaluate('([r, s, e]) => window.__cowork.debug.select(r, s, e)', [below['ref'], below['start'], below['end']])
                    settle(pg)
                    ok(have and same_rects(have, studio_highlights(frame)), f"문단을 넣은 뒤 아래 메모({below['ref']}) 강조 = studio 선택")
                # 큰 문서에 여러 제안 한 번에(요청 하나 = 제안 16건 꼴) — 걸린 시간 · 되돌리기 한 번
                picks = body3[60:76]
                bitems = [{'op': 'text', 'ref': bp['ref'], 'find': ''.join(cps(bp['text'])[:3]), 'replace': ''.join(cps(bp['text'])[:3]) + '※', 'key': bp['ref']} for bp in picks]
                bwant = [''.join(cps(bp['text'])[:3]) + '※' + ''.join(cps(bp['text'])[3:]) for bp in picks]
                prefs = [bp['ref'] for bp in picks]
                ptexts = lambda: pg.evaluate('(rs) => rs.map((r) => window.__cowork.debug.text(r))', prefs)  # noqa: E731
                t0 = time.time()
                res = pg.evaluate('(xs) => window.__cowork.applyBatch(xs)', bitems)
                big_ms = (time.time() - t0) * 1000
                print(f'    큰 문서 applyBatch {len(bitems)}건 {big_ms:.0f}ms', flush=True)
                ok(res['ok'] and res['applied'] == len(bitems) and ptexts() == bwant, f"큰 문서 applyBatch {res['applied']}/{len(bitems)}건 반영({big_ms:.0f}ms)")
                ok(big_ms < 15000, f'큰 문서 applyBatch {len(bitems)}건 {big_ms:.0f}ms < 15초')
                pg.keyboard.press('Control+z')
                wait_until(lambda: ptexts() == [bp['text'] for bp in picks], timeout=10, msg='큰 문서 묶음 되돌리기')
                ok(True, f'큰 문서 Ctrl+Z 한 번 → {len(bitems)}건 모두 빠짐')
                shot(pg, '10_big')

                print('[10b] 큰 보고서 syncToBase — 남이 고친 문단 16개·넣은 문단 하나 + 내 저장 안 된 글(타이핑·넣은 문단)은 기준으로 → 시간·캐럿·스크롤', flush=True)
                warn1 = len(warns)
                picks2 = body3[80:96]
                set_t = {bp['ref']: ''.join(cps(bp['text'])[:2]) + '◆' + ''.join(cps(bp['text'])[2:]) for bp in picks2}
                after_ref = body3[100]['ref']
                base9, map9 = make_base(paras3, set_text=set_t, insert_after={after_ref: ['남이 넣은 문단(큰 문서)']})
                ins_ref = f"s0/p{int(map9[after_ref].split('/p')[1]) + 1}"
                ctarget = body3[120]
                pg.evaluate('(r) => window.__cowork.focusRange({ ref: r, flash: false })', ctarget['ref'])
                pg.evaluate('(r) => window.__cowork.debug.select(r, 2, 2)', ctarget['ref'])
                settle(pg)
                sc0 = scroll_pos(frame)
                set_base(pg, base9, 2)
                since = now_ms(pg)
                t0 = time.time()
                res = sync(pg)
                sync_big = (time.time() - t0) * 1000
                st = cw_stats(pg)
                print(f"    큰 문서 syncToBase 편집 {st['perf']['lastSyncEdits']}개(문단 {len(res.get('changed') or [])} 바꿈·{len(res.get('inserted') or [])} 넣음·{res.get('deleted')} 지움) "
                      f"{sync_big:.0f}ms(evaluate 왕복 — studio 다시 그리기 포함) · 플러그인 안 {res.get('ms')}ms(계획 {st['perf']['lastSyncPlanMs']:.1f}ms · 트랜잭션 {st['perf']['lastSyncTxMs']:.1f}ms)", flush=True)
                want_changed = {map9[r] for r in set_t} | {map9[target['ref']]}
                ok(res['ok'] and set(res['changed']) == want_changed and res['inserted'] == [ins_ref] and res['deleted'] == (1 if below else 0),
                   f"큰 문서 syncToBase → 바꿈 {len(res.get('changed') or [])}(남이 고친 16 + 내가 친 1) · 넣음 {res.get('inserted')} · 지움 {res.get('deleted')}")
                ok(sync_big < 10000, f'큰 문서 syncToBase {sync_big:.0f}ms < 10초')
                ok(pg.evaluate('() => window.__cowork.debug.syncPlan()')['edits'] == [], '맞춘 뒤 편집기 = 기준(다시 맞출 것 없음 — 본문·칸 전부)')
                ok(texts_of(pg, [map9[r] for r in set_t]) == [set_t[r] for r in set_t], '남이 고친 16문단 글이 들어옴')
                caret = st['editor']['caret']
                cidx = int(map9[ctarget['ref']].split('/p')[1])
                ok(caret and (caret['paragraphIndex'], caret['charOffset']) == (cidx, 2), f"캐럿: {ctarget['ref']}:2 → {map9[ctarget['ref']]}:2 {caret}")
                ok(scroll_pos(frame) == sc0, f'스크롤 그대로 {sc0}')
                ok(not events(pg, 'edited', since) and st['canUndo'] is False, 'edited 없음·되돌리기 기록 비움')
                shot(pg, '10b_big_synced')
                # 맞추기가 보지 못하는 글(꼬리말)이 바뀌면 STRUCTURE(문서를 다시 열 때까지) — 편집기에 들이지 못한 채 두면 다음 밀어 넣기가 남의 고침을 되돌린다
                foot = next((p for p in base9 if p.get('container') == 'hp:footer'), None)
                ok(foot, f"꼬리말 문단 {foot and foot['ref']}")
                base10 = [dict(p, text=p['text'] + '꼬리말 고침') if p['ref'] == foot['ref'] else p for p in base9]
                cref = map9[ctarget['ref']]
                base10 = [dict(p, text='◇' + p['text']) if p['ref'] == cref else p for p in base10]
                set_base(pg, base10, 3)
                res = sync(pg)
                ok(not res['ok'] and res['reason'] == 'STRUCTURE' and pg.evaluate('(r) => window.__cowork.debug.text(r)', cref) == ctarget['text'],
                   f"꼬리말이 바뀐 기준 → STRUCTURE(본문도 고치지 않음) {res.get('message')}")
                set_base(pg, base9, 2)
                ok(sync(pg)['reason'] == 'STRUCTURE', '한 번 어긋나면 다시 열 때까지 STRUCTURE(되돌린 기준이어도)')
                ok(not warns[warn1:], f"큰 문서 맞추기에 플러그인·커서 경고 없음{'' if not warns[warn1:] else ': ' + ' | '.join(warns[warn1:][:3])}")

            print('[11] ?token= 으로 열기(localStorage 없음) → 주소창·Referer 에 토큰을 남기지 않음', flush=True)
            ctx2 = br.new_context(viewport={'width': 1200, 'height': 800}, device_scale_factor=1)
            pg2 = ctx2.new_page()
            pg2.on('pageerror', lambda e: errors.append(f'pageerror(2): {e}'))
            pg2.on('console', lambda m: errors.append(f'console.{m.type}(2): {m.text}') if m.type == 'error' else None)
            reqs = []
            pg2.on('request', lambda r: reqs.append(r))
            pg2.goto(f'{BASE}/studio-test.html?doc={d1}&token={ME["token"]}')
            pg2.wait_for_function('() => window.__ready === true || !!window.__error', timeout=120000)
            err2 = pg2.evaluate('window.__error')
            ok(not err2, f"?token= 으로 준비{'' if not err2 else ': ' + err2}")
            ok(pg2.evaluate('location.search') == f'?doc={d1}', f"주소창에서 토큰을 지움({pg2.evaluate('location.search')})")
            def referer(r):
                # r.headers(요청 때 머리글 — 드라이버를 기다리지 않음). header_value 는 아직 끝나지 않은 요청이면 응답을 기다리며 멈춘다(2026-11-03 35분 멈춤)
                try:
                    return (r.headers or {}).get('referer') or ''
                except Exception:  # noqa: BLE001 — blob:·data: 요청 등
                    return ''
            leaked = [r.url for r in reqs if ME['token'] in referer(r)]
            ok(len(reqs) > 5 and not leaked, f'요청 {len(reqs)}개의 Referer 에 토큰 없음{"" if not leaked else ": " + leaked[0]}')
            ctx2.close()

            bad = [e for e in errors if 'favicon' not in e]
            ok(not bad, f'페이지 오류 없음{"" if not bad else ": " + " | ".join(bad[:5])}')
            br.close()
    except Exception as ex:  # noqa: BLE001
        if not isinstance(ex, AssertionError):
            traceback.print_exc()
        elif not RESULTS or RESULTS[-1][0]:  # ok() 가 이미 ✗ 로 찍은 것이 아니면(wait_until 시간 초과 등) 이유를 찍는다
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
