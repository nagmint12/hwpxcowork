# 화면 시험(차례 만들기 — 2026-10-29): 편집기의 [도구 > 차례/색인] 으로 차례를 만들고 고치고 새로 고치면 공유 문서·한글로 저장에 실리는가.
#   1) [도구 > 차례/색인 > 차례 만들기] 대화상자(한/글과 같은 항목) → [만들기] → 첫 문단 뒤에 차례(필드·하이퍼링크) → 한글로 저장에 차례 필드
#   2) 차례 항목(하이퍼링크)을 누르면 그 제목 문단으로 캐럿이 간다
#   3) 차례 안 우클릭 → '차례 새로 고침'·'모든 차례 새로 고침'·'차례 고치기...' → 새로 고침
#   4) 차례 고치기 → 표 차례 끄기 → 차례에서 '<표 차례>' 가 빠진다(한글로 저장도)
#   5) [제목 차례 표시] → 한글로 저장에 <hp:titleMark ignore="1"/>
#   python -I tests/ui_toc.py   → 스크린숏 tests/out/toc_ui_*.png, 서버 기록 tests/out/toc_ui_server.log
# 서버는 포트 8777(UI_TOC_PORT)에 임시 data 폴더 + 임시 config + AI 끔(진짜 config.json·data/ 는 읽지도 쓰지도 않음).
# 편집기 빌드(studio/dist)가 있어야 한다: npm run build:engine && npm run build:studio
import io, json, os, re, secrets, shutil, socket, subprocess, sys, tempfile, time, traceback, urllib.parse, urllib.request, zipfile
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')).replace('\\', '/')
OUT = f'{ROOT}/tests/out'
os.makedirs(OUT, exist_ok=True)
PORT = int(os.environ.get('UI_TOC_PORT', '8777'))
BASE = f'http://localhost:{PORT}'
REST = f'http://127.0.0.1:{PORT}'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
FIX = f'{ROOT}/tests/fixtures/toc_source.hwpx'
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
    log = open(f'{OUT}/toc_ui_server.log', 'w', encoding='utf-8', newline='')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(160):
        if srv.poll() is not None:
            raise RuntimeError('서버가 시작하다 끝났습니다 — tests/out/toc_ui_server.log')
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


def frame_off(pg):
    return pg.evaluate(f"() => {{ const r = {FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")


def point(pg, ref, off):
    p = wait_until(lambda: cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', [ref, off]), timeout=10, msg=f'pointFor({ref})')
    o = frame_off(pg)
    return p['x'] + o['x'], p['y'] + o['y']


def click_at(pg, ref, off):
    """편집기를 눌러 키 입력이 가게 하고 기준 (ref, off) 에 캐럿을 둔다"""
    wait_until(lambda: store(pg, '!!(s.editor && s.editor.ready && !s.editor.locked && !s.editor.loading)'), timeout=20, msg='편집기 준비')
    settle(pg)
    x, y = point(pg, ref, 0)
    pg.mouse.click(x + 2, y + 2)
    cw(pg, 'cw.debug.select(arg[0], arg[1], arg[1])', [ref, off])
    settle(pg)


def texts(pg, n=None):
    """편집기 문서의 본문 문단 글(정렬과 무관한 지금 문서 그대로 — 차례 문단은 기준 문서에 짝이 없다)"""
    t = cw(pg, 'cw.debug.paragraphs(0)') or []
    return t if n is None else t[:n]


def point_text(pg, text):
    """지금 편집기 문서에서 글이 text 로 시작하는 문단의 글 시작 자리(화면 좌표)"""
    p = wait_until(lambda: cw(pg, 'cw.debug.pointForText(arg)', text), timeout=10, msg=f'pointForText({text})')
    o = frame_off(pg)
    return p['x'] + o['x'], p['y'] + o['y']


def export_xml(did):
    b = rest(f'/api/docs/{did}/file?kind=export')
    return zipfile.ZipFile(io.BytesIO(b)).read('Contents/section0.xml').decode('utf-8')


def menu(pg, frame, cmd):
    """[도구] 메뉴 → 차례/색인 하위 메뉴 → cmd"""
    frame.locator('.menu-item[data-menu="tool"] > .menu-title').click()
    sub = frame.locator('.menu-item[data-menu="tool"] .md-sub').filter(has_text='차례/색인')
    sub.hover()
    item = frame.locator(f'[data-cmd="{cmd}"]')
    item.wait_for(state='visible', timeout=5000)
    ok('disabled' not in (item.get_attribute('class') or ''), f'메뉴 [{cmd}] 를 쓸 수 있다')
    item.click()


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx_toc_ui_')
    srv = log = None
    errors = []
    try:
        srv, log = start_server(tmp)
        with open(FIX, 'rb') as f:
            did = rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('차례시험.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)['id']
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME, headless=True)
            ctx = br.new_context(viewport={'width': 1440, 'height': 960}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(A['token'])}); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
            pg.goto(f'{BASE}/#/doc/{did}')
            pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did, timeout=120000)
            ok(not pg.evaluate('window.__doc.editor.error'), '편집기 준비')
            pg.wait_for_function(f'() => !!{FRAME_JS}?.contentWindow?.rhwpCowork', timeout=30000)
            cw(pg, 'cw.ready'); settle(pg)
            frame = next(f for f in pg.frames if '/studio/' in f.url)

            print('\n── [1] 차례 만들기')
            click_at(pg, 's0/p0', 6)
            menu(pg, frame, 'tool:toc-make')
            dlg = frame.locator('.toc-dialog')
            dlg.wait_for(state='visible', timeout=5000)
            body = dlg.inner_text()
            for label in ['필드로 넣기', '문자열로 넣기', '제목 차례', '개요 문단으로 모으기', '스타일로 모으기', '차례 코드로 모으기', '표 차례', '그림 차례', '수식 차례', '오른쪽 탭', '하이퍼링크 만들기']:
                ok(label in body, f'대화상자 항목: {label}')
            pg.screenshot(path=f'{OUT}/toc_ui_1_dialog.png')
            dlg.locator('.dialog-btn-primary').click()
            settle(pg)
            t = texts(pg, 4)
            ok(t[1] == '<제목 차례>' and t[2].startswith('1. 서론\t'), f'첫 문단 뒤 차례: {t[1:3]}')
            pg.screenshot(path=f'{OUT}/toc_ui_1_made.png')
            wait_until(lambda: not store(pg, 's.draft.dirty') and not store(pg, 's.draft.saving'), timeout=20, msg='실시간 저장')
            xml = wait_until(lambda: (lambda x: x if 'TABLEOFCONTENTS' in x else None)(export_xml(did)), timeout=20, msg='한글로 저장에 차례 필드')
            ok(xml.count('type="HYPERLINK"') >= 9, f'하이퍼링크 {xml.count(chr(34) + "HYPERLINK" + chr(34))}')
            ok(re.search(r'<hp:tab width="\d+" leader="3" type="2"/>', xml) is not None, '오른쪽 점선 탭')

            print('\n── [2] 차례 항목 누르면 그 제목으로')
            all_t = texts(pg)
            target = next(i for i, s in enumerate(all_t) if s == '방법')
            x, y = point_text(pg, '2. 방법')   # 차례 항목
            pg.mouse.move(x + 12, y + 4)
            pg.mouse.click(x + 12, y + 4)
            settle(pg)
            c = raw_caret(pg)
            ok(c.get('paragraphIndex') == target, f"'2. 방법' 을 누르면 본문 '방법'(p{target})으로 캐럿: {c}")

            print('\n── [3] 차례 안 우클릭 → 차례 새로 고침')
            x, y = point_text(pg, '1. 서론')
            pg.mouse.click(x + 40, y + 4, button='right')
            cm = frame.locator('.context-menu')
            cm.wait_for(state='visible', timeout=5000)
            mtxt = cm.inner_text()
            ok('차례 새로 고침' in mtxt and '모든 차례 새로 고침' in mtxt and '차례 고치기' in mtxt, f'우클릭 메뉴: {mtxt.splitlines()[-3:]}')
            pg.screenshot(path=f'{OUT}/toc_ui_3_context.png')
            cm.locator('.md-item[data-cmd="tool:toc-update"]').click()
            settle(pg)
            ok(texts(pg, 3)[1] == '<제목 차례>', '새로 고친 뒤에도 차례 그대로')

            print('\n── [4] 차례 고치기 → 표 차례 끄기')
            x, y = point_text(pg, '1. 서론')
            pg.mouse.click(x + 40, y + 4, button='right')
            cm.wait_for(state='visible', timeout=5000)
            cm.locator('.md-item[data-cmd="tool:toc-edit"]').click()
            dlg.wait_for(state='visible', timeout=5000)
            box = dlg.locator('#toc-table')
            ok(box.is_checked(), '고치기 대화상자는 지금 차례의 선택 사항(표 차례 켬)')
            box.uncheck()
            dlg.locator('.dialog-btn-primary').click()
            settle(pg)
            tt = texts(pg)
            ok('<표 차례>' not in tt and '<그림 차례>' in tt, f'표 차례가 빠진다: {[s for s in tt if s.startswith("<")]}')
            wait_until(lambda: not store(pg, 's.draft.dirty') and not store(pg, 's.draft.saving'), timeout=20, msg='실시간 저장')
            wait_until(lambda: '&lt;표 차례&gt;' not in export_xml(did), timeout=20, msg='한글로 저장에서도 표 차례 빠짐')
            ok(True, '한글로 저장에서도 표 차례 빠짐')

            print('\n── [5] 제목 차례 표시')
            x, y = point_text(pg, '서론 본문입니다.')
            pg.mouse.click(x + 20, y + 4)
            settle(pg)
            menu(pg, frame, 'tool:toc-mark-title')
            settle(pg)
            wait_until(lambda: not store(pg, 's.draft.dirty') and not store(pg, 's.draft.saving'), timeout=20, msg='실시간 저장')
            wait_until(lambda: re.search(r'<hp:titleMark ignore="1"/>서론 본문입니다', export_xml(did)), timeout=20, msg='한글로 저장에 제목 차례 표시')
            ok(True, '한글로 저장에 <hp:titleMark ignore="1"/>')
            pg.screenshot(path=f'{OUT}/toc_ui_5_mark.png')

            print('\n── [6] 차례를 끌어 골라 지우기 → 차례 필드째 없어지고 공유 문서도 같다')
            tt = texts(pg)
            last = tt.index('서론') - 1          # 차례 마지막 빈 줄(필드 끝)
            click_at(pg, 's0/p1', 0)
            for _ in range(last - 1):
                pg.keyboard.press('Shift+ArrowDown')
            pg.keyboard.press('Shift+End')
            pg.keyboard.press('Delete')
            settle(pg)
            tt = texts(pg, 3)
            ok(tt[1] == '' and tt[2] == '서론', f'차례 자리에 빈 줄 하나: {tt}')
            wait_until(lambda: not store(pg, 's.draft.dirty') and not store(pg, 's.draft.saving'), timeout=20, msg='실시간 저장')
            xml = wait_until(lambda: (lambda x: x if 'TABLEOFCONTENTS' not in x else None)(export_xml(did)), timeout=20, msg='한글로 저장에서 차례 필드 없어짐')
            ok('fieldid="628387683"' not in xml, '차례 필드 끝 표지도 없음(짝 없는 끝 = 한글이 못 여는 꼴)')
            ok(not store(pg, 's.live.error'), f"'보내지 못함' 없음: {store(pg, 's.live.error')}")

            print('\n── [7] 만들 위치: 현재 문서의 새 구역')
            click_at(pg, 's0/p0', 6)
            menu(pg, frame, 'tool:toc-make')
            dlg.wait_for(state='visible', timeout=5000)
            pos = dlg.locator('select.toc-pos')
            ok(pos.is_enabled() and '현재 문서의 새 구역' in pos.inner_text(), f'만들 위치 고르기: {pos.inner_text()!r}')
            pos.select_option('section')
            dlg.locator('.dialog-btn-primary').click()
            settle(pg)
            tt = texts(pg, 3)
            ok(tt[1] == '<제목 차례>', f'캐럿 문단 뒤 새 구역에 차례: {tt}')
            wait_until(lambda: not store(pg, 's.draft.dirty') and not store(pg, 's.draft.saving'), timeout=20, msg='실시간 저장')
            xml = wait_until(lambda: (lambda x: x if x.count('<hp:secPr') == 3 else None)(export_xml(did)), timeout=20, msg='한글로 저장에 구역 나누기 셋')
            ok('TABLEOFCONTENTS' in xml, '새 구역 차례 필드')
            pg.screenshot(path=f'{OUT}/toc_ui_7_section.png')
            br.close()
        bad = [e for e in errors if 'favicon' not in e]
        ok(not bad, f'화면 오류 없음: {bad[:3]}')
    except Exception:
        traceback.print_exc()
        RESULTS.append((False, 'exception'))
    finally:
        if srv:
            srv.terminate()
            try: srv.wait(10)
            except Exception: srv.kill()
        if log: log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    passed = sum(1 for r in RESULTS if r[0]); failed = len(RESULTS) - passed
    print(f'\n결과: {passed} 통과, {failed} 실패')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
