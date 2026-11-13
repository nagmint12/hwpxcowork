# 화면 시험(조판 부호 — 2026-10-28): 편집기에서 Backspace·Delete 로 조판 부호를 지우고 실시간 저장 → 한글로 저장에 실리는가.
#   1) 표 캡션 '[표 1] 표' 번호 뒤 Backspace → 한/글 같은 '지우기 — [번호 넣기] 를 지울까요?' 창 → Y → 번호만 사라짐('[표 ] 표')
#      → 공유 문서·한글로 저장(kind=export)에 번호 없음
#   2) Ctrl+Z → 번호가 돌아옴(편집기)
#   3) [쪽 → 새 번호로 시작](번호 종류 '표', 5) → 조판 부호 보기를 끄면 숨은 부호라 문단 앞 Delete 는 글자를 지운다(묻지 않음 — 한/글 2026-10-30 실측)
#      → 보기를 켜고 ← 로 부호 앞에 서서 Delete → '[새 번호] 를 지울까요?' → [취소] 뒤 다시 Delete 도 같은 부호를 묻는다 → Enter(지움) → 부호만 지움
#   8) 글자처럼 취급한 그림 뒤 Backspace → '[그림] 을 지울까요?' → N(그대로) → 다시 Backspace → Y → 그림이 지워져 한글로 저장에서 빠짐 · 그림 앞 Delete 도 묻는다
#   9) 표 아래 빈 줄(표를 품은 문단)에 캐럿을 둘 수 있다(종전에는 건너뜀) → Backspace → '[표] 를 지울까요?' → Enter → 표가 지워져 한글로 저장에서 빠짐
#      (표 아래 빈 줄은 글머리표 문단 — 한/글은 조판 부호 보기를 꺼도 이 Backspace 에 '[표] 를 지울까요?' 를 묻는다. 2026-10-30 재실측)
#  10) 조판 부호 보기를 켜도 부호 하나를 지울 때는 묻는다 · 끌어 고른 범위 지우기는 묻지 않는다
#  11) 한/글 실측 차례(tests/fixtures/codes_hangul_all.hwpx s0/p18 '가나[감추기][선]다라'):
#      보기 켬 Backspace → [선](취소 뒤 다시 [선]) → [감추기] → 나 → 가, Ctrl+Z 한 번에 하나씩 · 보기 켬 Delete(부호 앞) → [감추기] → [선] → 다
#      보기 끔 Backspace → 나 → 가 → 앞 문단과 합침(부호는 따라감, 묻지 않음) · 표지가 제자리에 그려진 화면(codes_ui_11_*.png)
#  10b) 글머리표 문단 머리 Backspace → 한/글처럼 글머리표를 먼저 뗀다(공유 문서에도), 다음 Backspace 가 합친다, Ctrl+Z 로 둘 다 돌아온다
#  12) 틈 가운데 글 넣기 — [감추기]와 [선] 사이에 X·IME 조합 '한' · 지운 글자 되돌리기는 부호 앞 제자리
#  13) 표 칸 안 부호(tests/fixtures/codes_hangul_cells.hwpx) — ←/→ 틈 자리, Backspace 묻기(취소 뒤 다시), 칸 안 글 넣기, 보기 끔 글자 지우기
#   python -I tests/ui_codes.py   → 스크린숏 tests/out/codes_ui_*.png, 서버 기록 tests/out/codes_ui_server.log
# 서버는 포트 8785(UI_CODES_PORT)에 임시 data 폴더 + 임시 config + AI 끔(진짜 config.json·data/ 는 읽지도 쓰지도 않음).
# 편집기 빌드(studio/dist)가 있어야 한다: npm run build:engine && npm run build:studio
import io, json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, time, traceback, urllib.parse, urllib.request, zipfile
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_CODES_PORT', '8785'))
BASE = f'http://localhost:{PORT}'
REST = f'http://127.0.0.1:{PORT}'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/testdata/매크로테스트용_저장.hwpx'
FIX_CODES = f'{ROOT}/tests/fixtures/codes_hangul_all.hwpx'
FIX_CELLS = f'{ROOT}/tests/fixtures/codes_hangul_cells.hwpx'   # 한/글이 만든 표: 칸1 '가나[책갈피]다라', 칸2 메모, 캡션 번호   # 한/글이 만든 조판 부호 시험지(문단마다 '가나'+부호+'다라')
A = {'name': '홍길동', 'role': 'admin', 'token': secrets.token_hex(16)}
RESULTS = []
FRAME_JS = "document.querySelector('.editorhost iframe')"


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


def start_server(tmp):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        if s.connect_ex(('127.0.0.1', PORT)) == 0:
            raise RuntimeError(f'포트 {PORT} 를 이미 다른 프로세스가 쓰고 있습니다')
    data = os.path.join(tmp, 'data'); os.makedirs(data, exist_ok=True)
    cfg = {'host': '127.0.0.1', 'port': PORT, 'dataDir': './data', 'tutorial': {'enabled': False}, 'users': [A],
           'ai': {'enabled': False, 'mock': False, 'keyFile': os.path.join(tmp, 'no-such-key.txt')}, 'studio': {'mode': 'local'}}
    cfg_path = os.path.join(tmp, 'config.json')
    with open(cfg_path, 'w', encoding='utf-8', newline='') as f:
        json.dump(cfg, f, ensure_ascii=False)
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=cfg_path, HWPX_COWORK_DATA_DIR=data, HWPX_COWORK_AI='off', HWPX_COWORK_PORT=str(PORT), HWPX_COWORK_HOST='127.0.0.1')
    log = open(f'{OUT}/codes_ui_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError('서버가 시작하다 끝났습니다 — tests/out/codes_ui_server.log')
        try:
            if json.loads(urllib.request.urlopen(REST + '/api/config', timeout=2).read()).get('nonce'):
                break
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    if rest('/api/me').get('name') != A['name']:
        raise RuntimeError('이 시험의 서버가 아닙니다')
    return srv, log


def cw(pg, expr, arg=None):
    return pg.evaluate(f'async (arg) => {{ const cw = {FRAME_JS}.contentWindow.rhwpCowork; return ({expr}); }}', arg)


def settle(pg):
    pg.evaluate(f'async () => {{ const c = {FRAME_JS}?.contentWindow?.rhwpCowork; if (c) await c.debug.settled(); }}')


def store(pg, expr):
    return pg.evaluate(f'() => {{ const d = window.__doc; const s = d.s; const v = ({expr}); return v === undefined ? null : JSON.parse(JSON.stringify(v)); }}')


def raw_caret(pg):
    return (cw(pg, 'cw.debug.stats()').get('editor') or {}).get('caret') or {}


def click_at(pg, ref, off):
    """편집기를 눌러 키 입력이 가게 하고 기준 (ref, off) 에 캐럿을 둔다"""
    wait_until(lambda: store(pg, '!!(s.editor && s.editor.ready && !s.editor.locked && !s.editor.loading)'), timeout=20, msg='편집기 준비')
    settle(pg)
    p = wait_until(lambda: cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', [ref, 0]), timeout=10, msg=f'pointFor({ref})')
    o = pg.evaluate(f"() => {{ const r = {FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")
    pg.mouse.click(p['x'] + o['x'] + 2, p['y'] + o['y'] + 2)
    cw(pg, 'cw.debug.select(arg[0], arg[1], arg[1])', [ref, off])
    settle(pg)


def solid_png(w, h, rgb):
    """단색 PNG 바이트(시험용 새 그림)"""
    import struct, zlib
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def export_caption_numbers(did):
    """한글로 저장(kind=export) → 표 캡션마다 자동 번호가 있는가(문서 차례)"""
    b = rest(f'/api/docs/{did}/file?kind=export')
    xml = zipfile.ZipFile(io.BytesIO(b)).read('Contents/section0.xml').decode('utf-8')
    out = []
    for m in re.finditer(r'<hp:tbl\b', xml):
        cap = xml[xml.find('<hp:caption', m.start()):xml.find('</hp:caption>', m.start())]
        out.append(bool(re.search(r'<hp:autoNum\b[^>]*numType="TABLE"', cap)))
    return out, xml


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx_codes_ui_')
    srv = log = None
    errors = []
    try:
        srv, log = start_server(tmp)
        with open(FIX, 'rb') as f:
            did = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('조판부호.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)['id']
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME, headless=True)
            ctx = br.new_context(viewport={'width': 1440, 'height': 960}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(A['token'])}); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
            http_fail = []
            pg.on('response', lambda r: http_fail.append(f'{r.status} {r.url.split("?")[0]}') if r.status >= 400 else None)
            pg.goto(f'{BASE}/#/doc/{did}')
            pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did, timeout=120000)
            ok(not pg.evaluate('window.__doc.editor.error'), '편집기 준비')
            pg.wait_for_function(f'() => !!{FRAME_JS}?.contentWindow?.rhwpCowork', timeout=30000)
            cw(pg, 'cw.ready'); settle(pg)
            ok(store(pg, 's.editor.mode') == 'live', '실시간 문서')

            print('\n── [1] 표 캡션 번호 뒤 Backspace')
            cap = 's0/p5/n0'
            ok(cw(pg, 'cw.debug.text(arg)', cap) == '[표  ] 표', f'편집기 캡션 글(번호 자리표 포함): {cw(pg, "cw.debug.text(arg)", cap)!r}')
            click_at(pg, cap, 0)
            for _ in range(4):
                pg.keyboard.press('ArrowRight')
            settle(pg)
            ok(raw_caret(pg).get('charOffset') == 4, f'캐럿 = 번호 뒤(편집기 글자 4): {raw_caret(pg)}')
            pg.keyboard.press('Backspace')
            studio = next(f for f in pg.frames if '/studio/' in f.url)
            ask = studio.locator('[role="alertdialog"]').filter(has_text='지울까요')
            ask.wait_for(state='visible', timeout=5000)
            ok(ask.inner_text().find('[번호 넣기] 를 지울까요?') >= 0 and '지움(Y)' in ask.inner_text() and '취소(N)' in ask.inner_text(),
               f'한/글 같은 지우기 창: {ask.inner_text()!r}')
            pg.screenshot(path=f'{OUT}/codes_ui_1_confirm.png')
            pg.keyboard.press('y')
            settle(pg)
            ok(ask.count() == 0 or not ask.first.is_visible(), 'Y 로 지움 — 창이 닫힘')
            ok(cw(pg, 'cw.debug.text(arg)', cap) == '[표 ] 표', f"번호만 지워짐: {cw(pg, 'cw.debug.text(arg)', cap)!r}")
            pg.screenshot(path=f'{OUT}/codes_ui_1_backspace.png')
            wait_until(lambda: not store(pg, 's.draft.dirty') and not store(pg, 's.draft.saving'), timeout=20, msg='실시간 저장')
            nums = wait_until(lambda: (lambda n: n if n[0] is False else None)(export_caption_numbers(did)[0]), timeout=15, msg='한글로 저장에 반영')
            ok(nums == [False, True, True, True], f'한글로 저장: 첫 표 번호 없음, 나머지 번호 그대로 {nums}')
            ok(store(pg, 's.live.reopens') == 0, f"번호를 지운 내 편집기는 다시 열리지 않음(reopens {store(pg, 's.live.reopens')})")

            print('\n── [2] Ctrl+Z')
            pg.keyboard.press('Control+z')
            settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', cap) == '[표  ] 표', f"되돌리기 한 번에 번호가 돌아옴: {cw(pg, 'cw.debug.text(arg)', cap)!r}")
            wait_until(lambda: export_caption_numbers(did)[0] == [True, True, True, True], timeout=20, msg='되돌린 번호가 공유 문서에')
            ok(True, '되돌린 번호가 한글로 저장에도 돌아옴')

            print('\n── [3] 새 번호로 시작(표 5) → Delete → 묻고 지움')
            body = 's0/p3'
            click_at(pg, body, 0)
            frame = next(f for f in pg.frames if '/studio/' in f.url)
            # 쪽 메뉴 열기(메뉴를 열 때 항목의 쓸 수 있음이 정해진다) → 새 번호로 시작
            frame.locator('.menu-item:has([data-cmd="page:new-page-num"]) > .menu-title').click()
            item = frame.locator('[data-cmd="page:new-page-num"]')
            item.wait_for(state='visible', timeout=5000)
            ok('disabled' not in (item.get_attribute('class') or ''), '[쪽 → 새 번호로 시작] 메뉴 항목을 쓸 수 있다')
            item.click()
            dlg = frame.locator('.dialog-wrap').filter(has_text='새 번호로 시작').first
            dlg.wait_for(state='visible', timeout=5000)
            dlg.locator('select').select_option('TABLE')
            dlg.locator('input[type="number"]').fill('5')
            pg.screenshot(path=f'{OUT}/codes_ui_3_dialog.png')
            dlg.locator('.dialog-btn-primary').click()
            settle(pg)
            wait_until(lambda: re.search(r'<hp:newNum num="5" numType="TABLE"/>', export_caption_numbers(did)[1]), timeout=20, msg='새 번호가 공유 문서에')
            ok(True, '새 번호(표 5)가 한글로 저장에 실림')
            ask = frame.locator('[role="alertdialog"]').filter(has_text='지울까요')
            codes_btn = frame.locator('button.tb-btn[data-cmd="view:ctrl-mark"]')   # 도구 막대 [조판 부호]
            # 보기 끔: 새 번호는 숨은 부호 — 캐럿은 부호 뒤에만 서고 Delete 는 묻지 않고 글자를 지운다(한/글 실측)
            ok(codes_btn.get_attribute('aria-checked') != 'true', '조판 부호 보기 끔')
            click_at(pg, body, 0)
            pg.keyboard.press('Delete')
            settle(pg)
            ok(ask.count() == 0 or not ask.first.is_visible(), '보기 끔: 숨은 부호는 묻지 않는다')
            ok(cw(pg, 'cw.debug.text(arg)', body).startswith('한'), f"부호 뒤 글자를 지움: {cw(pg, 'cw.debug.text(arg)', body)[:6]!r}")
            pg.keyboard.press('Control+z'); settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', body).startswith('또한'), '되돌리기로 글자가 돌아옴')
            # 보기 켬: ← 로 부호 앞에 서서 Delete → 묻는다, [취소] 뒤에도 같은 부호를 다시 묻는다
            codes_btn.click(); settle(pg)
            ok(codes_btn.get_attribute('aria-checked') == 'true', '조판 부호 보기 켬')
            click_at(pg, body, 0)
            pg.keyboard.press('ArrowLeft'); settle(pg)
            c = raw_caret(pg)
            ok(c.get('paragraphIndex') == 3 and c.get('charOffset') == 0 and c.get('codeGap') == 0, f'캐럿 = 부호 앞(틈 0): {c}')
            pg.keyboard.press('Delete')
            ask.wait_for(state='visible', timeout=5000)
            ok('[새 번호] 를 지울까요?' in ask.inner_text(), f'묻는 창: {ask.inner_text()!r}')
            pg.screenshot(path=f'{OUT}/codes_ui_3_confirm.png')
            ask.locator('button:has-text("취소")').first.click()
            settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', body).startswith('또한'), '[취소] → 글도 부호도 그대로')
            ok(raw_caret(pg).get('codeGap') == 0, f'[취소] → 캐럿 그대로: {raw_caret(pg)}')
            pg.keyboard.press('Delete')
            ask.wait_for(state='visible', timeout=5000)
            ok('[새 번호] 를 지울까요?' in ask.inner_text(), '[취소] 뒤 다음 Delete 도 같은 부호를 묻는다(건너뛰지 않음 — 한/글 실측)')
            pg.keyboard.press('Enter')   # 기본 단추 = 지움(Y)
            settle(pg)
            wait_until(lambda: not re.search(r'<hp:newNum\b', export_caption_numbers(did)[1]), timeout=20, msg='지운 새 번호가 공유 문서에서 빠짐')
            ok(cw(pg, 'cw.debug.text(arg)', body).startswith('또한'), '[지움] → 부호만 지움(글은 그대로)')
            ok(True, '지운 새 번호가 한글로 저장에서도 빠짐')
            codes_btn.click(); settle(pg)
            print('\n── [4] 그림 크기 줄이기(그림 고르기 → Shift+←) → 한글로 저장에 새 크기')
            def first_pic_width():
                xml = export_caption_numbers(did)[1]
                m = re.search(r'<hp:pic\b[\s\S]*?<hp:sz width="(\d+)"', xml)
                return int(m.group(1)) if m else None
            w0 = first_pic_width()
            settle(pg)
            cap_pt = wait_until(lambda: cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', ['s0/p7/n0', 0]), timeout=10, msg='그림 캡션 자리')
            o = pg.evaluate(f"() => {{ const r = {FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")
            pg.mouse.click(cap_pt['x'] + o['x'] + 150, cap_pt['y'] + o['y'] - 120)   # 캡션 위 = 그림(글자처럼, 아래 캡션)
            settle(pg)
            for _ in range(6):
                pg.keyboard.press('Shift+ArrowLeft')
            settle(pg)
            pg.screenshot(path=f'{OUT}/codes_ui_4_resized.png')
            w1 = wait_until(lambda: (lambda w: w if w and w < w0 else None)(first_pic_width()), timeout=20, msg='줄인 그림 크기가 공유 문서에')
            ok(w1 < w0, f'한글로 저장의 그림 폭 {w0} → {w1}')

            print('\n── [5] 그림 지우기(그림 고르기 → Delete) → 경고 없이 한글로 저장에서 빠짐')
            def pic_count():
                return len(re.findall(r'<hp:pic\b', export_caption_numbers(did)[1]))
            n0 = pic_count()
            toasts0 = pg.locator('text=공유 문서에 들어가지').count()
            settle(pg)
            cap_pt = wait_until(lambda: cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', ['s0/p7/n0', 0]), timeout=10, msg='그림 캡션 자리')
            o = pg.evaluate(f"() => {{ const r = {FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")
            pg.mouse.click(cap_pt['x'] + o['x'] + 120, cap_pt['y'] + o['y'] - 120)
            settle(pg)
            ok((cw(pg, 'cw.debug.stats()').get('editor') or {}).get('pictureObject'), '그림을 골랐다')
            pg.keyboard.press('Delete')
            settle(pg)
            ask = studio.locator('[role="alertdialog"]')
            if ask.count() and ask.first.is_visible():   # 편집기가 개체 지우기를 묻는 경우
                ask.first.locator('.dialog-btn-primary').click(); settle(pg)
            n1 = wait_until(lambda: (lambda n: n if n < n0 else None)(pic_count()), timeout=20, msg='지운 그림이 공유 문서에서 빠짐')
            ok(n1 == n0 - 1, f'한글로 저장의 그림 {n0} → {n1}')
            ok(pg.locator('text=공유 문서에 들어가지').count() == toasts0, "'지원하지 않는 … 변경' 경고가 뜨지 않음")
            pg.screenshot(path=f'{OUT}/codes_ui_5_deleted.png')

            print('\n── [6] 그림 넣기(도구 막대 [그림] → 파일 → 쪽에 놓기) → 한글로 저장에 새 그림·그림 파일')
            png = os.path.join(tmp, 'new.png')
            with open(png, 'wb') as f:
                f.write(solid_png(120, 60, (220, 40, 40)))
            n2 = pic_count()
            click_at(pg, 's0/p3', 0)
            with pg.expect_file_chooser() as fc:
                studio.locator('button.tb-btn[data-cmd="insert:image"]').click()   # 도구 막대 [그림]
            fc.value.set_files(png)
            settle(pg)
            p3 = cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', ['s0/p3', 0])
            pg.mouse.click(p3['x'] + o['x'] + 200, p3['y'] + o['y'] + 10)   # 놓을 자리
            settle(pg)
            n3 = wait_until(lambda: (lambda n: n if n > n2 else None)(pic_count()), timeout=20, msg='새 그림이 공유 문서에')
            xml = export_caption_numbers(did)[1]
            b = rest(f'/api/docs/{did}/file?kind=export')
            names = zipfile.ZipFile(io.BytesIO(b)).namelist()
            refs = re.findall(r'binaryItemIDRef="([^"]+)"', xml)
            ok(n3 == n2 + 1 and all(any(n.startswith(f'BinData/{r}.') for n in names) for r in refs), f'한글로 저장의 그림 {n2} → {n3}, 그림 파일 모두 있음({refs})')
            ok(pg.locator('text=공유 문서에 들어가지').count() == toasts0, "그림 넣기도 경고 없음")
            pg.screenshot(path=f'{OUT}/codes_ui_6_inserted.png')

            print('\n── [7] 표 캡션: ] 앞을 눌러 Backspace → 번호만 지움(] 는 그대로) · 캡션에 글 치기 · 캡션 복사')
            cap2 = 's0/p11/n0'   # 둘째 표 캡션 '[표 n] 표'
            settle(pg)
            t0 = cw(pg, 'cw.debug.text(arg)', cap2)
            ok(re.match(r'^\[표 {2}\] 표', t0 or ''), f'캡션 글: {t0!r}')
            # 캐럿을 번호 바로 뒤(']' 앞)에 둔다 — 종전에는 그 자리가 화면에서 한 칸 밀려 ']' 뒤에 그려졌다(캐럿 자리는 엔진 시험이 본다)
            click_at(pg, cap2, 0)
            for _ in range(4):
                pg.keyboard.press('ArrowRight')
            settle(pg)
            ok(raw_caret(pg).get('charOffset') == 4, f'캐럿 = 번호 뒤·] 앞: {raw_caret(pg)}')
            pg.keyboard.press('Backspace')
            ask = studio.locator('[role="alertdialog"]').filter(has_text='지울까요')
            ask.wait_for(state='visible', timeout=5000)
            pg.keyboard.press('y')
            settle(pg)
            t1 = cw(pg, 'cw.debug.text(arg)', cap2)
            ok(t1.startswith('[표 ] 표'), f"Backspace → 번호만 지움, ']' 는 남음: {t1!r}")
            pg.keyboard.press('Control+z'); settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', cap2) == t0, '되돌리기로 번호가 돌아옴')
            # 캡션 끝에 글 치기
            click_at(pg, cap2, len(t0) - 1)
            pg.keyboard.press('End'); pg.keyboard.type('(단위: 명)'); settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', cap2).endswith('(단위: 명)'), '캡션에 글을 칠 수 있다')
            wait_until(lambda: any('(단위: 명)' in p['text'] for p in rest(f'/api/docs/{did}/paragraphs') if p['ref'] == cap2), timeout=20, msg='캡션 글이 공유 문서에')
            ok(True, '캡션에 친 글이 공유 문서에 들어감')
            # 캡션 전체 선택 복사 → 클립보드 글에 번호
            ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
            click_at(pg, cap2, 0)
            pg.keyboard.press('Home'); pg.keyboard.press('Shift+End'); settle(pg)
            pg.keyboard.press('Control+c'); settle(pg)
            clip = wait_until(lambda: pg.evaluate('navigator.clipboard.readText().catch(() => "")'), timeout=5, msg='클립보드')
            ok(re.match(r'^\[표 \d+\] 표', clip or ''), f'캡션 복사 글에 번호: {clip!r}')
            pg.screenshot(path=f'{OUT}/codes_ui_7_caption.png')

            print('\n── [8] 글자처럼 취급한 그림 뒤 Backspace · 앞 Delete → 한/글처럼 묻고 지움')
            def table_count():
                return len(re.findall(r'<hp:tbl\b', export_caption_numbers(did)[1]))
            ask = studio.locator('[role="alertdialog"]').filter(has_text='지울까요')
            n0 = pic_count()
            click_at(pg, 's0/p13', 0)
            pg.keyboard.press('ArrowLeft'); settle(pg)
            c = raw_caret(pg)
            ok(c.get('paragraphIndex') == 12 and c.get('charOffset') == 1, f'캐럿 = 그림 뒤(s0/p12 1): {c}')
            pg.keyboard.press('Backspace')
            ask.wait_for(state='visible', timeout=5000)
            ok('[그림] 을 지울까요?' in ask.inner_text(), f'묻는 창: {ask.inner_text()!r}')
            pg.screenshot(path=f'{OUT}/codes_ui_8_picture_confirm.png')
            pg.keyboard.press('n'); settle(pg)
            ok(not ask.count() or not ask.first.is_visible(), 'N 으로 취소')
            ok(pic_count() == n0, '취소하면 그림 그대로')
            pg.keyboard.press('Backspace')
            ask.wait_for(state='visible', timeout=5000)
            ok(True, '보이는 개체는 취소한 뒤에도 다시 묻는다')
            pg.keyboard.press('y'); settle(pg)
            n1 = wait_until(lambda: (lambda n: n if n < n0 else None)(pic_count()), timeout=20, msg='지운 그림이 공유 문서에서 빠짐')
            ok(n1 == n0 - 1, f'Backspace 로 지운 그림이 한글로 저장에서 빠짐 {n0} → {n1}')
            click_at(pg, 's0/p26', 0)
            pg.keyboard.press('ArrowLeft'); pg.keyboard.press('ArrowLeft'); settle(pg)
            c = raw_caret(pg)
            ok(c.get('paragraphIndex') == 25 and c.get('charOffset') == 0, f'캐럿 = 그림 앞(s0/p25 0): {c}')
            pg.keyboard.press('Delete')
            ask.wait_for(state='visible', timeout=5000)
            ok('[그림] 을 지울까요?' in ask.inner_text(), f'그림 앞 Delete 도 묻는다: {ask.inner_text()!r}')
            pg.keyboard.press('Escape'); settle(pg)
            ok(pic_count() == n1, 'Esc 로 취소 — 그림 그대로')
            ok(pg.locator('text=공유 문서에 들어가지').count() == toasts0, "그림 지우기에 '공유 문서에 들어가지 않음' 경고 없음")

            print('\n── [9] 표 아래 빈 줄(표를 품은 문단)에서 Backspace → [표] 를 지울까요? → 표 지움')
            t0n = table_count()
            click_at(pg, 's0/p20', 0)
            pg.keyboard.press('ArrowLeft'); settle(pg)
            c = raw_caret(pg)
            ok(c.get('paragraphIndex') == 19 and c.get('charOffset') == 0 and c.get('parentParaIndex') is None,
               f'표 아래 빈 줄에 캐럿(s0/p19 0 — 종전에는 건너뛰어 앞 문단 끝으로 갔다): {c}')
            pg.screenshot(path=f'{OUT}/codes_ui_9_table_line.png')
            pg.keyboard.press('Backspace')
            ask.wait_for(state='visible', timeout=5000)
            ok('[표] 를 지울까요?' in ask.inner_text(), f'묻는 창: {ask.inner_text()!r}')
            pg.keyboard.press('Enter'); settle(pg)
            print('    (편집기 s0/p19 글', repr(cw(pg, 'cw.debug.text(arg)', 's0/p19')), '· 반영 불가', store(pg, 's.draft.unsupported'),
                  '· 알림', [t for t in pg.locator('.toast').all_inner_texts() if t][:3], ')')
            t1n = wait_until(lambda: (lambda n: n if n < t0n else None)(table_count()), timeout=20, msg='지운 표가 공유 문서에서 빠짐')
            ok(t1n == t0n - 1, f'표 아래 빈 줄 Backspace 로 지운 표가 한글로 저장에서 빠짐 {t0n} → {t1n}')
            ok(pg.locator('text=공유 문서에 들어가지').count() == toasts0, "표 지우기에도 경고 없음")
            pg.screenshot(path=f'{OUT}/codes_ui_9_table_deleted.png')

            print('\n── [10] 조판 부호 보기를 켜도 부호 하나를 지울 때는 묻는다 · 끌어 고른 범위 지우기는 묻지 않는다')
            codes_btn = studio.locator('button.tb-btn[data-cmd="view:ctrl-mark"]')   # 도구 막대 [조판 부호]
            codes_btn.click(); settle(pg)
            ok(codes_btn.get_attribute('aria-checked') == 'true', '조판 부호 보기 켬')
            cap4 = 's0/p24/n0'
            t4 = cw(pg, 'cw.debug.text(arg)', cap4)
            ok(re.match(r'^\[표 {2}\] 표', t4 or ''), f'넷째 표 캡션 글: {t4!r}')
            click_at(pg, cap4, 0)
            for _ in range(4):
                pg.keyboard.press('ArrowRight')
            settle(pg)
            ok(raw_caret(pg).get('charOffset') == 4, f'캐럿 = 번호 뒤: {raw_caret(pg)}')
            pg.keyboard.press('Backspace')
            ask.wait_for(state='visible', timeout=5000)
            ok('[번호 넣기] 를 지울까요?' in ask.inner_text(), f'조판 부호 보기 중에도 묻는다: {ask.inner_text()!r}')
            pg.screenshot(path=f'{OUT}/codes_ui_10_codes_shown_confirm.png')
            pg.keyboard.press('n'); settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', cap4) == t4, 'N → 그대로')
            # 끌어 고른 범위(번호 포함 '[표 1]')를 Delete — 여러 글자·부호를 한꺼번에 지우므로 묻지 않는다
            click_at(pg, cap4, 0)
            pg.keyboard.press('Home')
            for _ in range(5):
                pg.keyboard.press('Shift+ArrowRight')
            settle(pg)
            pg.keyboard.press('Delete'); settle(pg)
            ok(not ask.count() or not ask.first.is_visible(), '범위 지우기는 묻지 않는다')
            t5 = cw(pg, 'cw.debug.text(arg)', cap4)
            ok(t5 == ' 표', f"범위의 글자·번호가 한꺼번에 지워짐: {t5!r}")
            pg.keyboard.press('Control+z'); settle(pg)
            ok(cw(pg, 'cw.debug.text(arg)', cap4) == t4, '되돌리기 한 번에 원상')
            codes_btn.click(); settle(pg)
            print('\n── [10b] 글머리표 문단 머리 Backspace — 한/글처럼 먼저 글머리표를 뗀다(묻지 않음), 다음 Backspace 가 합친다')
            ask_b = studio.locator('[role="alertdialog"]').filter(has_text='지울까요')
            def export_heading(idx):
                b = rest(f'/api/docs/{did}/file?kind=export')
                z = zipfile.ZipFile(io.BytesIO(b))
                import xml.etree.ElementTree as ET
                HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'; HH = '{http://www.hancom.co.kr/hwpml/2011/head}'
                head = ET.fromstring(z.read('Contents/header.xml'))
                prs = {pp.get('id'): pp for pp in head.iter(HH + 'paraPr')}
                ps = ET.fromstring(z.read('Contents/section0.xml')).findall(HP + 'p')
                pr = prs.get(ps[idx].get('paraPrIDRef'))
                h = pr.find(HH + 'heading') if pr is not None else None
                return h.get('type') if h is not None else None
            ok(export_heading(2) == 'BULLET', f'처음: s0/p2 글머리표 {export_heading(2)}')
            n0b = len(cw(pg, 'cw.debug.paragraphs(0)'))
            click_at(pg, 's0/p2', 0)
            Pb = raw_caret(pg).get('paragraphIndex')
            tb = cw(pg, 'cw.debug.paragraphs(0)')[Pb]
            pg.keyboard.press('Backspace'); settle(pg)
            ok(not ask_b.count() or not ask_b.first.is_visible(), '묻지 않는다')
            ok(len(cw(pg, 'cw.debug.paragraphs(0)')) == n0b and cw(pg, 'cw.debug.paragraphs(0)')[Pb] == tb, '첫 Backspace 는 합치지 않는다(글 그대로)')
            wait_until(lambda: export_heading(2) == 'NONE', timeout=20, msg='글머리표를 뗀 문단이 공유 문서에')
            ok(True, '첫 Backspace = 글머리표 떼기 → 공유 문서(한글로 저장)에서도 머리 없음')
            ok(pg.locator('text=공유 문서에 들어가지').count() == toasts0, "글머리표 떼기에 '들어가지 않음' 경고 없음")
            pg.keyboard.press('Backspace'); settle(pg)
            ok(len(cw(pg, 'cw.debug.paragraphs(0)')) == n0b - 1, '다음 Backspace 가 앞 문단과 합친다')
            pg.keyboard.press('Control+z'); settle(pg)
            ok(len(cw(pg, 'cw.debug.paragraphs(0)')) == n0b, 'Ctrl+Z → 합치기 되돌림')
            pg.keyboard.press('Control+z'); settle(pg)
            wait_until(lambda: export_heading(2) == 'BULLET', timeout=20, msg='되돌린 글머리표가 공유 문서에')
            ok(True, 'Ctrl+Z → 글머리표가 돌아옴(공유 문서에도)')

            print('\n── [11] 한/글 실측 차례: 가나[감추기][선]다라 — 보기 켬/끔 Backspace·Delete')
            with open(FIX_CODES, 'rb') as f:
                did2 = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('조판부호_차례.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)['id']
            pg.goto(f'{BASE}/#/doc/{did2}')
            pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did2, timeout=120000)
            pg.wait_for_function(f'() => !!{FRAME_JS}?.contentWindow?.rhwpCowork', timeout=30000)
            cw(pg, 'cw.ready'); settle(pg)
            studio = next(f for f in pg.frames if '/studio/' in f.url)
            ask = studio.locator('[role="alertdialog"]').filter(has_text='지울까요')
            codes_btn = studio.locator('button.tb-btn[data-cmd="view:ctrl-mark"]')
            # 편집기 문단 번호(P)와 공유 문서 기준 자리(ref)는 다를 수 있다 — 글과 부호로 편집기 문단을 찾고, 그 문단에 캐럿이 서는 ref 를 고른다
            def gap_marks(para, off):
                g = cw(pg, 'cw.debug.codeGap(arg[0], arg[1])', [para, off]) or {}
                return [c['mark'] for c in g.get('codes', [])]
            texts = cw(pg, 'cw.debug.paragraphs(0)')
            P = next(i for i, tx in enumerate(texts) if tx == '가나다라' and gap_marks(i, 2) == ['[감추기]', '[선]'])
            ref = None
            for k in (P, P - 1, P + 1, P - 2, P + 2):
                click_at(pg, f's0/p{k}', 2)
                if raw_caret(pg).get('paragraphIndex') == P:
                    ref = f's0/p{k}'
                    break
            ok(ref is not None, f'편집기 문단 {P} = 공유 문서 {ref}')

            def marks(off, para=P):
                g = cw(pg, 'cw.debug.codeGap(arg[0], arg[1])', [para, off]) or {}
                return [c['mark'] for c in g.get('codes', [])]

            def para_text(i=P):
                return cw(pg, 'cw.debug.paragraphs(0)')[i]

            def press_ask(key, expect, answer):
                pg.keyboard.press(key)
                ask.wait_for(state='visible', timeout=5000)
                txt = ask.inner_text()
                ok(expect in txt, f'{key} → {expect!r} 묻는 창: {txt!r}')
                pg.keyboard.press(answer); settle(pg)

            def press_plain(key):
                pg.keyboard.press(key); settle(pg)
                ok(ask.count() == 0 or not ask.first.is_visible(), f'{key} → 묻지 않음')

            ok(para_text() == '가나다라' and marks(2) == ['[감추기]', '[선]'], f'처음: {para_text()!r} {marks(2)}')
            # 보기 켬 — Backspace: [선](취소 뒤 다시 [선]) → [감추기] → 나 → 가
            if codes_btn.get_attribute('aria-checked') != 'true':
                codes_btn.click(); settle(pg)
            click_at(pg, ref, 2)
            pg.screenshot(path=f'{OUT}/codes_ui_11_codes_on.png')
            press_ask('Backspace', '[선] 을 지울까요?', 'n')
            ok(marks(2) == ['[감추기]', '[선]'], '[취소] → 그대로')
            press_ask('Backspace', '[선] 을 지울까요?', 'y')
            ok(marks(2) == ['[감추기]'] and raw_caret(pg).get('codeGap') == 1, f'[선] 지움 → 캐럿은 [선] 자리: {marks(2)} {raw_caret(pg)}')
            press_ask('Backspace', '[감추기] 를 지울까요?', 'y')
            ok(marks(2) == [] and para_text() == '가나다라', f'[감추기] 지움: {marks(2)} {para_text()!r}')
            press_plain('Backspace')
            ok(para_text() == '가다라', f'그다음 Backspace 는 나: {para_text()!r}')
            press_plain('Backspace')
            ok(para_text() == '다라', f'그다음 가: {para_text()!r}')
            for want_text, want_marks in [('가다라', []), ('가나다라', []), ('가나다라', ['[감추기]']), ('가나다라', ['[감추기]', '[선]'])]:
                pg.keyboard.press('Control+z'); settle(pg)
                ok(para_text() == want_text and marks(2) == want_marks, f'Ctrl+Z 한 번에 하나씩: {para_text()!r} {marks(2)}')
            # 보기 켬 — Delete: 부호 앞(← 두 번)에서 [감추기] → [선] → 다
            click_at(pg, ref, 2)
            pg.keyboard.press('ArrowLeft'); pg.keyboard.press('ArrowLeft'); settle(pg)
            ok(raw_caret(pg).get('charOffset') == 2 and raw_caret(pg).get('codeGap') == 0, f'← 한 번에 부호 하나 — 나 바로 뒤: {raw_caret(pg)}')
            pg.screenshot(path=f'{OUT}/codes_ui_11_caret_before_codes.png')
            press_ask('Delete', '[감추기] 를 지울까요?', 'y')
            press_ask('Delete', '[선] 을 지울까요?', 'y')
            press_plain('Delete')
            ok(para_text() == '가나라' and marks(2) == [], f'Delete 차례 [감추기] → [선] → 다: {para_text()!r} {marks(2)}')
            for _ in range(3):
                pg.keyboard.press('Control+z'); settle(pg)
            ok(para_text() == '가나다라' and marks(2) == ['[감추기]', '[선]'], '되돌리기 세 번에 원상')
            # 보기 끔 — Backspace: 나 → 가 → 앞 문단과 합침(부호는 따라감, 묻지 않음)
            codes_btn.click(); settle(pg)
            ok(codes_btn.get_attribute('aria-checked') != 'true', '조판 부호 보기 끔')
            n0 = len(cw(pg, 'cw.debug.paragraphs(0)'))
            prev = para_text(P - 1)
            click_at(pg, ref, 2)
            press_plain('Backspace')
            ok(para_text() == '가다라' and marks(1) == ['[감추기]', '[선]'], f'보기 끔 Backspace → 나(부호는 가 뒤에): {para_text()!r} {marks(1)}')
            press_plain('Backspace')
            ok(para_text() == '다라' and marks(0) == ['[감추기]', '[선]'], f'→ 가(부호는 문단 머리): {para_text()!r} {marks(0)}')
            press_plain('Backspace')
            paras = cw(pg, 'cw.debug.paragraphs(0)')
            ok(len(paras) == n0 - 1 and paras[P - 1] == prev + '다라', f'→ 앞 문단과 합침: {len(paras)} {paras[P - 1]!r}')
            pg.screenshot(path=f'{OUT}/codes_ui_11_codes_off_merged.png')
            for _ in range(3):
                pg.keyboard.press('Control+z'); settle(pg)
            ok(para_text() == '가나다라' and marks(2) == ['[감추기]', '[선]'], f'되돌리기로 원상: {para_text()!r} {marks(2)}')

            print('\n── [12] 틈 가운데 글 넣기 — 한/글처럼 캐럿 자리 그대로([감추기]와 [선] 사이) · IME 조합 · 되돌리기')
            codes_btn.click(); settle(pg)
            ok(codes_btn.get_attribute('aria-checked') == 'true', '조판 부호 보기 켬')
            click_at(pg, ref, 2)
            pg.keyboard.press('ArrowLeft'); settle(pg)
            ok(raw_caret(pg).get('codeGap') == 1, f'캐럿 = [감추기]와 [선] 사이: {raw_caret(pg)}')
            pg.keyboard.type('X'); settle(pg)
            ok(para_text() == '가나X다라' and marks(2) == ['[감추기]'] and marks(3) == ['[선]'], f'X 는 두 부호 사이: {para_text()!r} {marks(2)} {marks(3)}')
            ok(raw_caret(pg).get('charOffset') == 3 and raw_caret(pg).get('codeGap') == 0, f'캐럿은 X 뒤·[선] 앞: {raw_caret(pg)}')
            pg.screenshot(path=f'{OUT}/codes_ui_12_typed_between.png')
            pg.keyboard.press('Control+z'); settle(pg)
            ok(para_text() == '가나다라' and marks(2) == ['[감추기]', '[선]'], 'Ctrl+Z → 원상')
            # IME 조합(ㅎ → 하 → 한)도 같은 틈 자리에 — 조합 내내 자리를 지킨다
            click_at(pg, ref, 2)
            pg.keyboard.press('ArrowLeft'); settle(pg)
            cdp = ctx.new_cdp_session(pg)
            for comp in ['ㅎ', '하', '한']:
                cdp.send('Input.imeSetComposition', {'text': comp, 'selectionStart': len(comp), 'selectionEnd': len(comp)})
            cdp.send('Input.insertText', {'text': '한'})
            settle(pg)
            ok(para_text() == '가나한다라' and marks(2) == ['[감추기]'] and marks(3) == ['[선]'], f'IME 조합 글도 두 부호 사이: {para_text()!r} {marks(2)} {marks(3)}')
            pg.keyboard.press('Control+z'); settle(pg)
            ok(para_text() == '가나다라' and marks(2) == ['[감추기]', '[선]'], 'Ctrl+Z → 원상(조합 한 번)')
            # 지운 글자를 되돌리면 원래 차례(부호 앞): 보기 켬 · 틈 0(나 바로 뒤)에서 Backspace → 나 → Ctrl+Z
            click_at(pg, ref, 2)
            pg.keyboard.press('ArrowLeft'); pg.keyboard.press('ArrowLeft'); settle(pg)
            pg.keyboard.press('Backspace'); settle(pg)
            ok(para_text() == '가다라' and marks(1) == ['[감추기]', '[선]'], f'나 지움: {para_text()!r} {marks(1)}')
            pg.keyboard.press('Control+z'); settle(pg)
            ok(para_text() == '가나다라' and marks(2) == ['[감추기]', '[선]'], f'되돌리기 — 나는 부호 앞 제자리: {para_text()!r} {marks(2)}')
            codes_btn.click(); settle(pg)

            print('\n── [13] 표 칸·캡션 안 부호 — 본문과 같은 캐럿·지우기')
            with open(FIX_CELLS, 'rb') as f:
                did3 = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('조판부호_칸.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)['id']
            pg.goto(f'{BASE}/#/doc/{did3}')
            pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did3, timeout=120000)
            pg.wait_for_function(f'() => !!{FRAME_JS}?.contentWindow?.rhwpCowork', timeout=30000)
            cw(pg, 'cw.ready'); settle(pg)
            studio = next(f for f in pg.frames if '/studio/' in f.url)
            ask = studio.locator('[role="alertdialog"]').filter(has_text='지울까요')
            codes_btn = studio.locator('button.tb-btn[data-cmd="view:ctrl-mark"]')
            cell_ref = next(r for r in ('s0/p1/n0', 's0/p1/n1', 's0/p1/n2') if cw(pg, 'cw.debug.text(arg)', r) == '가나다라')
            def cell_text():
                return cw(pg, 'cw.debug.text(arg)', cell_ref)
            if codes_btn.get_attribute('aria-checked') != 'true':
                codes_btn.click(); settle(pg)
            click_at(pg, cell_ref, 2)
            c0 = raw_caret(pg)
            ok(c0.get('parentParaIndex') is not None and c0.get('charOffset') == 2, f'캐럿 = 칸 안 자리 2: {c0}')
            pg.keyboard.press('ArrowLeft'); settle(pg)
            ok(raw_caret(pg).get('codeGap') == 0 and raw_caret(pg).get('charOffset') == 2, f'← 한 번 = [책갈피] 앞(칸 안 틈 0): {raw_caret(pg)}')
            pg.keyboard.press('ArrowRight'); settle(pg)
            ok(raw_caret(pg).get('charOffset') == 2 and raw_caret(pg).get('codeGap') in (None, 1), f'→ 한 번 = [책갈피] 뒤: {raw_caret(pg)}')
            pg.keyboard.press('Backspace')
            ask.wait_for(state='visible', timeout=5000)
            ok('[책갈피] 를 지울까요?' in ask.inner_text(), f'칸 안 부호 뒤 Backspace 는 묻는다: {ask.inner_text()!r}')
            pg.keyboard.press('n'); settle(pg)
            pg.keyboard.press('Backspace')
            ask.wait_for(state='visible', timeout=5000)
            ok(True, '[취소] 뒤 다시 Backspace 도 같은 부호를 묻는다')
            pg.keyboard.press('y'); settle(pg)
            ok(cell_text() == '가나다라', f'칸 안 [책갈피] 만 지움: {cell_text()!r}')
            pg.keyboard.press('Control+z'); settle(pg)
            # 칸 안 틈 가운데 글 넣기: [책갈피] 앞(틈 0)에서 X
            click_at(pg, cell_ref, 2)
            pg.keyboard.press('ArrowLeft'); settle(pg)
            pg.keyboard.type('X'); settle(pg)
            ok(cell_text() == '가나X다라', f'칸 안 글 넣기: {cell_text()!r}')
            pg.keyboard.press('Control+z'); settle(pg)
            # 보기 끔: 숨은 부호 뒤에만 서고 Backspace 는 나(묻지 않음)
            codes_btn.click(); settle(pg)
            click_at(pg, cell_ref, 2)
            pg.keyboard.press('Backspace'); settle(pg)
            ok((not ask.count() or not ask.first.is_visible()) and cell_text() == '가다라', f'보기 끔: 칸 안 Backspace 는 나 — {cell_text()!r}')
            pg.keyboard.press('Control+z'); settle(pg)
            ok(cell_text() == '가나다라', '되돌리기')
            pg.screenshot(path=f'{OUT}/codes_ui_13_cells.png')

            # 복사(Ctrl+C)는 같은 PC 한/글 클립보드 쓰기(/api/clipboard/native)도 해 보는데, 시험 환경(한/글·클립보드 없음)에서는
            # 409 로 거절된다 — 편집기는 그 실패를 넘기고 브라우저 클립보드를 쓴다. 그 409 하나는 이 시험의 오류가 아니다.
            native_409 = any(f.startswith('409 ') and f.endswith('/api/clipboard/native') for f in http_fail)
            bad = [e for e in errors if 'favicon' not in e and not (native_409 and 'status of 409' in e)]
            ok(not bad, f'브라우저 오류 없음 {bad[:3]}')
            br.close()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        RESULTS.append((False, '예외'))
    finally:
        if srv:
            srv.terminate()
            try: srv.wait(10)
            except Exception: srv.kill()
        if log:
            log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    fails = [m for c, m in RESULTS if not c]
    print(f'\n{len(RESULTS) - len(fails)}/{len(RESULTS)} 통과' + (f' — 실패: {fails}' if fails else ''))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
