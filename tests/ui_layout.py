"""두 칸 화면(docs/V4_SPEC.md §5, 2026-10-29): 문서 | AI 작업 창, 문서 옆 메모(쪽 옆·끌어 옮기기·제자리·기억),
AI 작업 창 꼭지(접기·마우스를 올리거나 화면 오른쪽 끝에 대면 잠깐 펼침·고정·다른 곳이 부르면 펼쳐 둠·경계선을 끝까지 밀면 접기), 긴 메모 고치기(넓게·글 길이만큼),
터치 화면(휴대전화 '데스크톱 사이트')에서 본문을 누를 때 숨은 입력 칸이 캐럿 자리로(왼쪽 위로 확대되지 않게 — web/editor.js fixTouchInput).
격리 서버(임시 config·data, 빈 포트, AI 끔) — 진짜 config.json·data/ 는 건드리지 않는다."""
import atexit, json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
SAMPLE = ROOT / 'tests' / 'samples' / '2025년_전체종합보고서.hwpx'
LONG = ('그림 3개의 폭을 줄이는 제안을 남김(130mm·110mm·110mm, 비율 유지). 서버에서는 실제 쪽 나눔을 확인할 수 없으므로, 반영 후 한글에서 쪽 넘김 여부를 확인해야 함. '
        '또한 표 2의 제목 문단은 자동 번호 캡션이 없어 다른 표와 양식이 다르므로 같은 내용으로 [표 N] 자동 번호 캡션이 붙은 새 표를 제안함(반영 시 보고서 첫 표가 되어 뒤 표 번호가 하나씩 밀림). '
        '새 표 반영 후 기존 표는 편집기에서 지워 주시기 바람. 마지막으로 요약 문단의 문장이 길어 두 문장으로 나누는 것을 권장함. 근거 자료와 수치를 한 번 더 대조할 것.')

fails = []; count = 0
def ok(c, m):
    global count
    count += 1
    print(('  ✓ ' if c else '  ✗ ') + m, flush=True)
    if not c: fails.append(m)


def main():
    OUT.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_ui_layout_'))
    def cleanup():
        assert tmp.resolve().parent == Path(tempfile.gettempdir()).resolve() and tmp.name.startswith('hwpx_ui_layout_')
        shutil.rmtree(tmp, ignore_errors=True)
    atexit.register(cleanup)
    token = secrets.token_hex(20)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    cfg = {'host': '127.0.0.1', 'port': port, 'dataDir': './data', 'tutorial': {'enabled': False}, 'users': [{'name': '배치시험', 'role': 'admin', 'token': token}], 'ai': {'enabled': False, 'keyFile': str(tmp / 'no-key')}}
    config = tmp / 'config.json'; config.write_text(json.dumps(cfg), encoding='utf-8')
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=str(config), HWPX_COWORK_DATA_DIR=str(tmp / 'data'), HWPX_COWORK_HOST='127.0.0.1', HWPX_COWORK_PORT=str(port), HWPX_COWORK_AI='off')
    base = f'http://127.0.0.1:{port}'

    def rest(path, method='GET', body=None):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as r: return json.load(r)

    with (OUT / 'ui_layout_server.log').open('w', encoding='utf-8') as log:
        srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(150):
                if srv.poll() is not None: raise RuntimeError('격리 시험 서버 시작 실패')
                try:
                    urllib.request.urlopen(base + '/api/config', timeout=1).close(); break
                except Exception: time.sleep(.1)
            else: raise RuntimeError('서버 준비 시간 초과')
            req = urllib.request.Request(base + '/api/docs', data=SAMPLE.read_bytes(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'layout-test.hwpx'}, method='POST')
            with urllib.request.urlopen(req) as response: doc = json.load(response)
            did = doc['id']
            paras = rest(f'/api/docs/{did}/paragraphs')
            paras = paras if isinstance(paras, list) else paras.get('paragraphs', [])
            picked = [p for p in paras if len((p.get('text') or '').strip()) > 8][:3]
            mids = []
            for i, p in enumerate(picked):
                m = rest(f'/api/docs/{did}/memos', 'POST', {'ref': p['ref'], 'find': p['text'].strip()[:6], 'text': LONG if i == 1 else f'배치 시험 메모 {i + 1}: 표현을 간결하게.'})
                mids.append(m['id'])
            with sync_playwright() as pw:
                br = pw.chromium.launch(executable_path=CHROME)
                ctx = br.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
                p = ctx.new_page(); errs = []
                p.on('pageerror', lambda e: errs.append(str(e)))
                run(p, base, token, did, mids)
                ok(not errs, f'페이지 오류 없음 {errs[:3]}')
                ctx.close()
                # 휴대전화 '데스크톱 사이트'(980px 폭 + 터치)
                ctx = br.new_context(viewport={'width': 980, 'height': 1600}, has_touch=True, device_scale_factor=1)
                p = ctx.new_page(); errs = []
                p.on('pageerror', lambda e: errs.append(str(e)))
                run_touch(p, base, token, did)
                ok(not errs, f'터치 화면 페이지 오류 없음 {errs[:3]}')
                br.close()
        finally:
            srv.terminate()
            try: srv.wait(timeout=10)
            except subprocess.TimeoutExpired: srv.kill(); srv.wait(timeout=5)
    cleanup()
    print(f'결과: 통과 {count - len(fails)} · 실패 {len(fails)}', flush=True)
    for f in fails: print(' -', f)
    sys.exit(1 if fails else 0)


def run(p, base, token, did, mids):
    def box(sel): return p.locator(sel).first.bounding_box()
    def cls(c): return p.evaluate(f"document.querySelector('.docview').classList.contains('{c}')")
    def cards(): return p.evaluate('window.__rail.cards()')
    def slot(key): return p.locator(f'.rail-slot[data-key="{key}"]').bounding_box()
    def panel_saved(): return json.loads(p.evaluate("localStorage.getItem('hwpx.panel')") or '{}')
    def scroll_by(dy): p.evaluate(f"(() => {{ const c = window.__doc.editor.frame().contentDocument.getElementById('scroll-container'); c.scrollTop += {dy}; }})()")
    def page_right():
        return p.evaluate("""(() => { const f = window.__doc.editor.frame(); const fr = f.getBoundingClientRect(); let r = -1;
          for (const c of f.contentDocument.querySelectorAll('#scroll-content .document-page-canvas')) { const b = c.getBoundingClientRect(); if (b.width && b.bottom > 0 && b.top < f.clientHeight) r = Math.max(r, b.right); }
          return fr.left + r; })()""")
    def shot(name): p.screenshot(path=str(OUT / f'layout_{name}.png'))
    def hover_tab():
        et = box('[data-testid=edge-ai]')
        p.mouse.move(400, 450); p.mouse.move(et['x'] + 12, et['y'] + et['height'] / 2, steps=4); time.sleep(0.6)

    p.goto(f'{base}/#/t/{token}/doc/{did}')
    p.wait_for_function('window.__doc?.editor?.ready', timeout=120000)
    p.wait_for_function("document.querySelectorAll('[data-testid=rail] .rail-slot.placed').length > 0", timeout=30000); time.sleep(1.0)

    print('[1] 두 칸: 문서 | AI 작업 창, 메모는 문서 옆', flush=True)
    ok(p.locator('.railcol').count() == 0 and p.locator('[data-testid=rail]').count() == 1, '오른쪽 칸 없음 · 문서 옆 메모 층')
    ok(abs(box('.panel')['width'] - 360) < 2 and not cls('panel-folded'), 'AI 작업 창 고정(360px)')
    ok(p.locator('[data-testid=edge-ai]').is_visible() and p.locator('[data-testid=edge-memo]').is_visible(), '꼭지 [AI 작업]·[메모]')
    et = box('[data-testid=edge-ai]')
    ok(all(c['left'] + c['width'] <= et['x'] - box('[data-testid=rail]')['x'] + 1 for c in cards() if c['top'] is not None), '칸 메모는 꼭지 앞까지(꼭지에 가리지 않음)')
    shot('1_pinned')

    print('[2] 꼭지 누름 → 접힘(문서가 창 폭), 메모는 쪽 바로 옆', flush=True)
    ed0 = box('.editorarea')['width']
    p.locator('[data-testid=edge-ai]').click(); time.sleep(0.6); p.mouse.move(400, 450); time.sleep(1.2)
    ok(cls('panel-folded') and not cls('panel-peek') and box('.editorarea')['width'] > ed0 + 350, '접힘 → 편집기가 창 폭')
    ok(box('.panel')['x'] >= 1439 and p.locator('[data-testid=edge-ai]').is_visible(), '패널은 오른쪽 밖, 꼭지는 남음')
    ok(panel_saved().get('pin') is False, '접힘 기억')
    pr = page_right(); ov = box('[data-testid=rail]')
    c0 = next(c for c in cards() if c['top'] is not None)
    ok(abs(ov['x'] + c0['left'] - (pr + 8)) <= 2 and c0['width'] >= 250, f"메모는 쪽 오른쪽 끝 + 8px({ov['x'] + c0['left']:.0f} · 쪽 {pr:.0f} · 폭 {c0['width']})")
    shot('2_folded')

    print('[3] 꼭지에 마우스 → 잠깐 펼침 → 나가면 접힘 → 펼친 채 누르면 고정', flush=True)
    hover_tab()
    ok(cls('panel-peek') and box('.panel')['x'] < 1440 - 300 and p.locator('.panel .tabs').is_visible(), '올리면 문서 위로 펼침')
    pb = box('.panel'); p.mouse.move(pb['x'] + 150, pb['y'] + 200, steps=4); time.sleep(0.7)
    ok(cls('panel-peek'), '창 안으로 옮겨도 펼친 채')
    p.mouse.move(400, 450, steps=6); time.sleep(0.9)
    ok(not cls('panel-peek'), '밖으로 나가면 접힘')
    hover_tab()
    et = box('[data-testid=edge-ai]'); p.mouse.click(et['x'] + 12, et['y'] + et['height'] / 2); time.sleep(0.4)
    p.mouse.move(400, 450, steps=6); time.sleep(0.8)
    ok(not cls('panel-folded') and panel_saved().get('pin') is True, '펼친 채 누르면 고정(나가도 그대로)')

    print('[3b] 접힌 동안 화면 오른쪽 끝(높이 전체)에 마우스 → 펼침 · 스크롤바 가운데·위 막대·누른 채·Esc 뒤에는 아님', flush=True)
    p.locator('[data-testid=edge-ai]').click(); time.sleep(0.5); p.mouse.move(400, 450, steps=4); time.sleep(0.8)
    ok(cls('panel-folded') and not cls('panel-peek'), '접힘')
    lay = box('.v3layout'); W = 1440; mid = lay['y'] + lay['height'] / 2 + 150
    def edge_to(x, y, wait=0.6): p.mouse.move(W - 200, y, steps=2); p.mouse.move(x, y, steps=5); time.sleep(wait)
    def leave(): p.mouse.move(400, 450, steps=6); time.sleep(0.9)
    for y in (lay['y'] + 20, mid, lay['y'] + lay['height'] - 12):
        edge_to(W - 1, y)
        ok(cls('panel-peek'), f'오른쪽 끝(y {y:.0f}) → 펼침')
        leave(); ok(not cls('panel-peek'), '  왼쪽으로 나가면 접힘')
    sb = p.evaluate("getComputedStyle(document.querySelector('.docview')).getPropertyValue('--sb-w')")
    edge_to(W - 4, mid); ok(cls('panel-peek'), f'끝에서 4px 안쪽(편집기 스크롤바 {sb} 위)도 펼침'); leave()
    edge_to(W - 9, mid, 0.8); ok(not cls('panel-peek'), '스크롤바 가운데(끝에서 9px)는 펼치지 않음')
    edge_to(W - 1, lay['y'] - 10, 0.8); ok(not cls('panel-peek'), '위 막대 높이는 펼치지 않음')
    p.mouse.move(W - 9, mid); p.mouse.down(); p.mouse.move(W - 1, mid + 30, steps=5); time.sleep(0.6)
    ok(not cls('panel-peek'), '단추를 누른 채(스크롤바 끌기) 끝에 닿아도 펼치지 않음')
    p.mouse.up(); time.sleep(0.4); p.mouse.move(W - 2, mid + 34, steps=2); time.sleep(0.6)
    ok(not cls('panel-peek'), '  놓은 뒤 끝에서 움직여도 그대로(한 번 벗어나야)')
    edge_to(W - 1, mid); ok(cls('panel-peek'), '  벗어났다 다시 끝 → 펼침')
    p.keyboard.press('Escape'); time.sleep(0.4); p.mouse.move(W - 2, mid + 40, steps=3); time.sleep(0.6)
    ok(not cls('panel-peek'), 'Esc 로 접은 뒤 끝에 머물러도 다시 열지 않음')
    leave()
    p.locator('[data-testid=edge-ai]').click(); time.sleep(0.4); p.mouse.move(400, 450, steps=4); time.sleep(0.6)
    ok(not cls('panel-folded'), '다시 고정')

    print('[4] 접은 채 다른 곳이 부름 → 펼쳐 둠 → 편집기 누름·Esc 로 접힘', flush=True)
    p.locator('[data-testid=edge-ai]').click(); time.sleep(0.5); p.mouse.move(400, 450); time.sleep(0.4)
    p.locator('[data-testid=version-pill]').click(); time.sleep(0.5)
    ok(cls('panel-peek') and p.evaluate('window.__doc.s.tab') == 'history', '버전 알약 → 이력 탭으로 펼침')
    time.sleep(0.8); ok(cls('panel-peek'), '마우스를 올리지 않아도 펼친 채')
    fb = box('.editorhost iframe'); p.mouse.click(fb['x'] + 300, fb['y'] + 400); time.sleep(0.5)
    ok(not cls('panel-peek'), '편집기를 누르면 접힘')
    p.evaluate("window.__doc.s.tab = 'review'"); time.sleep(0.4)
    ok(cls('panel-peek'), '탭을 바꾸면 다시 펼침')
    p.keyboard.press('Escape'); time.sleep(0.4)
    ok(not cls('panel-peek'), 'Esc 로 접힘')

    print('[5] 고정 → 경계선을 끝까지 밀면 접힘(폭은 그대로)', flush=True)
    p.locator('[data-testid=edge-ai]').click(); time.sleep(0.5); p.mouse.move(400, 450); time.sleep(0.4)
    sp = box('[data-testid=panel-splitter]'); x = sp['x'] + sp['width'] / 2; y = sp['y'] + 600
    p.mouse.move(x, y); p.mouse.down(); p.mouse.move(x + 260, y, steps=8); time.sleep(0.1)
    ok(cls('fold-hint'), '끝까지 밀면 옅게(놓으면 접힘)')
    p.mouse.up(); time.sleep(0.6)
    sv = panel_saved(); ok(cls('panel-folded') and sv.get('pin') is False and sv.get('w') == 360, f'놓으면 접힘 {sv}')
    time.sleep(0.8)

    print('[6] 메모 끌어 옮기기 → 점선 · 문서와 같이 스크롤 · 새로 열어도 그 자리 · 두 번 누르면 제자리', flush=True)
    k = next(c['key'] for c in cards() if c['top'] is not None and c['key'] == f'memo:{mids[0]}')
    s0 = slot(k); head = p.locator(f'.rail-slot[data-key="{k}"] .rc-head').bounding_box()
    hx, hy = head['x'] + 60, head['y'] + head['height'] / 2
    p.mouse.move(hx, hy); p.mouse.down(); p.mouse.move(hx - 200, hy + 20, steps=5); p.mouse.move(hx - 420, hy + 40, steps=8)
    ok(p.locator(f'.rail-slot[data-key="{k}"].dragging').count() == 1, '끄는 중')
    p.mouse.up(); time.sleep(0.5)
    s1 = slot(k)
    ok(abs((s1['x'] - s0['x']) + 420) <= 3 and abs((s1['y'] - s0['y']) - 40) <= 3, f"놓은 자리 dx {s1['x'] - s0['x']:.0f} · dy {s1['y'] - s0['y']:.0f}")
    ok(p.evaluate('window.__doc.s.active') is None, '끌기를 놓은 누름은 메모 고르기로 가지 않음')
    mp = json.loads(p.evaluate(f"localStorage.getItem('hwpx.memopos.{did}')") or '{}')
    ok(k in mp, f'이 브라우저·문서에 기억 {mp}')
    ok(any(l['key'] == k and l['cls'] == 'free' for l in p.evaluate('window.__rail.links()')), '강조 자리 → 메모 점선')
    shot('3_dragged')
    y0 = slot(k)['y']; scroll_by(120); time.sleep(0.8)
    ok(abs((slot(k)['y'] - y0) + 120) <= 3, f"스크롤하면 문서와 같이 {slot(k)['y'] - y0:.0f}")
    scroll_by(-120); time.sleep(0.4)
    p.reload(); p.wait_for_function('window.__doc?.editor?.ready', timeout=120000)
    p.wait_for_function(f"document.querySelector('.rail-slot.placed[data-key=\"{k}\"]')", timeout=30000); time.sleep(1.2)
    ok(p.locator(f'.rail-slot[data-key="{k}"].free').count() == 1, '새로 열어도 옮긴 자리')
    det = p.locator('[data-testid=document-view-options]')
    if not det.evaluate('e => e.open'): det.locator('summary').click()
    ok(p.locator('[data-testid=memo-pos-reset]').is_enabled(), "보기 메뉴 '메모 제자리로' 켜짐")
    p.keyboard.press('Escape'); time.sleep(0.2)
    head = p.locator(f'.rail-slot[data-key="{k}"] .rc-head').bounding_box()
    p.mouse.dblclick(head['x'] + 60, head['y'] + head['height'] / 2); time.sleep(0.5)
    ok(p.locator(f'.rail-slot[data-key="{k}"].free').count() == 0 and p.evaluate(f"localStorage.getItem('hwpx.memopos.{did}')") is None, '두 번 누르면 제자리(기억도 지움)')

    print('[7] 긴 메모 고치기: 넓게, 글이 다 보이게(문서 옆·검토 탭)', flush=True)
    lk = f'memo:{mids[1]}'
    p.wait_for_function(f"document.querySelector('.rail-slot.placed[data-key=\"{lk}\"]')", timeout=20000)
    p.locator(f'.rail-slot[data-key="{lk}"]').hover(); time.sleep(0.2)
    p.locator(f'.rail-slot[data-key="{lk}"] button[aria-label="메모 고치기"]').click(); time.sleep(0.8)
    ta = p.locator(f'.rail-slot[data-key="{lk}"] .memoedit textarea')
    m = ta.evaluate('t => ({ sh: t.scrollHeight, ch: t.clientHeight, h: t.offsetHeight })')
    ok(slot(lk)['width'] >= 500, f"고치는 메모 폭 {slot(lk)['width']:.0f}px")
    ok(m['sh'] <= m['ch'] + 2 and m['h'] > 100, f'글이 다 보이는 높이 {m}')
    shot('4_edit_long')
    ta.press('End'); ta.type(' 덧붙임'); time.sleep(0.2)
    m2 = ta.evaluate('t => ({ sh: t.scrollHeight, ch: t.clientHeight })'); ok(m2['sh'] <= m2['ch'] + 2, '치는 동안에도 다 보임')
    p.locator(f'.rail-slot[data-key="{lk}"] .memoedit button:has-text("취소")').click(); time.sleep(0.4)
    ok(slot(lk)['width'] < 500, '닫으면 원래 폭')
    p.locator('[data-testid=edge-ai]').click(); time.sleep(0.5); p.mouse.move(400, 450)
    p.locator('.panel .tabs button[data-tab=review]').click(); time.sleep(0.4)
    card = p.locator(f'.rt-list .rcard[data-key="{lk}"]')
    card.hover(); card.locator('button[aria-label="메모 고치기"]').click(); time.sleep(0.6)
    m3 = card.locator('.memoedit textarea').evaluate('t => ({ sh: t.scrollHeight, ch: t.clientHeight, h: t.offsetHeight })')
    ok(m3['sh'] <= m3['ch'] + 2 and m3['h'] > 120, f'검토 탭에서도 다 보임 {m3}')
    card.locator('.memoedit button:has-text("취소")').click()

    print('[8] [메모] 꼭지 끄고 켜기 · 좁은 창', flush=True)
    p.locator('[data-testid=edge-memo]').click(); time.sleep(0.5)
    ok(p.locator('[data-testid=rail]').count() == 0 and p.evaluate('window.__doc.s.railOpen') is False and panel_saved().get('rmode') == 'off', '메모 숨김(기억)')
    p.locator('[data-testid=edge-memo]').click(); time.sleep(0.8)
    ok(p.locator('[data-testid=rail]').count() == 1, '다시 보임')
    p.set_viewport_size({'width': 880, 'height': 900}); time.sleep(0.8)
    pb = box('.panel')
    ok(p.locator('[data-testid=edge-ai]').count() == 0 and p.locator('[data-testid=rail]').count() == 0 and pb['y'] > 400 and pb['width'] > 860, '좁은 창: 꼭지·문서 옆 메모 없음, 창은 아래')
    p.set_viewport_size({'width': 1440, 'height': 900}); time.sleep(0.8)
    ok(p.locator('[data-testid=edge-ai]').count() == 1 and p.locator('[data-testid=rail]').count() == 1, '넓히면 다시')



INPUT_JS = """(() => { const f = window.__doc.editor.frame(); const d = f.contentDocument; const t = d.querySelector('[aria-label="문서 편집 입력"]');
  const c = d.querySelector('#scroll-content .caret'); const cr = c && c.getBoundingClientRect(); const tr = t.getBoundingClientRect(); const cs = getComputedStyle(t);
  return { focused: d.activeElement === t, pos: cs.position, font: cs.fontSize, left: tr.left, top: tr.top, caret: cr ? { left: cr.left, top: cr.top, h: cr.height } : null }; })()"""


def run_touch(p, base, token, did):
    """터치 화면: 본문을 누르면 키보드용 숨은 입력 칸이 캐럿 자리(왼쪽 위 화면 밖이 아님)로 · 글자 72px(브라우저의 '읽기 좋은 배율' 확대를 막음) · 입력은 그대로"""
    print('[9] 터치(데스크톱 사이트) — 본문을 눌러도 왼쪽 위로 확대되지 않게', flush=True)
    p.goto(f'{base}/#/t/{token}/doc/{did}')
    p.wait_for_function('window.__doc?.editor?.ready', timeout=120000); time.sleep(1.5)
    def visible_caret():
        v = None
        for _ in range(20):
            v = p.evaluate(INPUT_JS)
            if v['caret'] and v['caret']['h'] > 0: return v
            time.sleep(0.1)
        return v
    z = p.evaluate(INPUT_JS)
    ok(z['font'] == '72px' and z['pos'] == 'fixed' and z['left'] >= 0, f"첫 누름 전에도 입력 칸은 화면 안·72px({z['left']:.0f},{z['top']:.0f} · {z['font']})")
    a0 = p.evaluate("(() => { const a = window.__doc.s.anchors.find((x) => x.visible); return window.__doc.editor.anchorToPage({ x: a.x, y: a.y }); })()")
    p.touchscreen.tap(a0['x'] + 30, a0['y'] + 10); time.sleep(0.6)
    i = visible_caret()
    ok(i['focused'] and i['pos'] == 'fixed' and i['font'] == '72px', f"누르면 숨은 입력 칸에 포커스 · 글자 72px({i['font']})")
    ok(abs(i['left'] - i['caret']['left']) <= 2 and abs(i['top'] - i['caret']['top']) <= 2, f"입력 칸 = 캐럿 자리({i['left']:.0f},{i['top']:.0f})")
    p.touchscreen.tap(a0['x'] + 90, a0['y'] + 12); time.sleep(0.6)
    j = visible_caret()
    ok(abs(j['left'] - j['caret']['left']) <= 2 and (j['left'], j['top']) != (i['left'], i['top']), '다시 누르면 새 캐럿 자리로')
    ref = p.evaluate('window.__doc.s.sel?.ref || null')
    T = '(ref) => window.__doc.editor.frame().contentWindow.rhwpCowork.debug.text(ref)'
    before = p.evaluate(T, ref)
    p.keyboard.type('XYZ'); time.sleep(0.6)
    ok(ref and 'XYZ' in p.evaluate(T, ref) and 'XYZ' not in before, '친 글이 문서에 들어감')


if __name__ == '__main__': main()
