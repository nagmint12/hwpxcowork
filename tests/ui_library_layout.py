"""문서함·드라이브 화면 배치(2026-11-18 사용자 요청) — 실제 브라우저로만 확인되는 것(DOM/CSS 배치·끌기)만 본다.
1) 왼쪽 나무 | 목록 경계선을 끌어 폭 바꾸기(문서함 나무 · 드라이브 폴더 칸) — 화살표 키·두 번 눌러 기본 폭·브라우저에 기억
2) 휴대전화 폭: 문서 줄 = 이름이 줄 전체(줄바꿈) → 버전·수정 시각·단추는 다음 줄, 폴더 줄 단추도 보임, 드라이브 파일 이름 줄바꿈
격리 서버(임시 config·data, 빈 포트) + 가짜 두레이(tests/helpers/fake-dooray.mjs — 실제 두레이를 부르지 않음).
    python -I tests/ui_library_layout.py
"""
import atexit, json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
BASE_DOC = ROOT / 'tests' / 'fixtures' / 'hangul_trk_brk_base.hwpx'
LONG_DOC = '2026년 하반기 대학혁신지원사업 성과관리 자체평가 보고서 최종 검토본(학과 의견 반영)'
LONG_FOLDER = '2026 대학혁신지원사업 성과관리 자체평가 자료 모음 폴더'
LONG_DRIVE_FILE = '2026년_대학혁신지원사업_성과관리_자체평가_보고서_최종검토본_v12.hwpx'
SITE = 'https://test.dooray.com'
# 가짜 두레이를 띄우고 긴 이름 파일을 더한 뒤 api 주소를 한 줄 알린다. 표준 입력이 닫히면(이 시험이 끝나면) 끈다
FAKE = r"""
import { startFakeDoorayHttp, FAKE_TOKEN, FAKE_DRIVE } from './tests/helpers/fake-dooray.mjs';
const fake = await startFakeDoorayHttp();
fake.files.set('LONG1', { id: 'LONG1', name: process.env.LONG_NAME, type: 'file', subType: 'doc', parent: 'R1', driveId: FAKE_DRIVE, revision: '99', version: 1, bytes: Buffer.from('PK-long'), mime: 'application/haansofthwpx' });
console.log(JSON.stringify({ api: fake.apiOrigin, token: FAKE_TOKEN }));
process.stdin.resume(); process.stdin.on('end', async () => { await fake.close(); process.exit(0); });
"""


def free_port():
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    return port


def main():
    OUT.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_lib_layout_'))
    procs = []

    def cleanup():
        for proc, log in procs:
            try:
                if proc.stdin: proc.stdin.close()
            except Exception: pass
            try: proc.terminate(); proc.wait(timeout=5)
            except Exception: proc.kill()
            if log: log.close()
        assert tmp.resolve().parent == Path(tempfile.gettempdir()).resolve() and tmp.name.startswith('hwpx_lib_layout_')
        shutil.rmtree(tmp, ignore_errors=True)

    atexit.register(cleanup)
    count = 0; errors = []

    def ok(value, message):
        nonlocal count
        assert value, message
        count += 1; print('  ✓ ' + message, flush=True)

    # ── 가짜 두레이 ──
    fenv = {**os.environ, 'LONG_NAME': LONG_DRIVE_FILE}
    fake = subprocess.Popen(['node', '--input-type=module', '-e', FAKE], cwd=ROOT, env=fenv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')
    procs.append((fake, None))
    info = json.loads(fake.stdout.readline())

    # ── 격리 서버 ──
    token = secrets.token_hex(20); port = free_port(); home = tmp / 'srv'; home.mkdir()
    cfg = {'host': '127.0.0.1', 'port': port, 'dataDir': './data', 'tutorial': {'enabled': False}, 'ai': {'enabled': False, 'keyFile': str(home / 'no-key')},
           'users': [{'name': '나', 'role': 'admin', 'token': token}]}
    (home / 'config.json').write_text(json.dumps(cfg), encoding='utf-8')
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=str(home / 'config.json'), HWPX_COWORK_DATA_DIR=str(home / 'data'), HWPX_COWORK_AI='off', HWPX_COWORK_DOORAY_API=info['api'])
    log = (OUT / 'library_layout_server.log').open('w', encoding='utf-8')
    srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    procs.append((srv, log))
    base = f'http://127.0.0.1:{port}'
    for _ in range(200):
        if srv.poll() is not None: raise RuntimeError('서버 시작 실패')
        try: urllib.request.urlopen(base + '/api/config', timeout=1).close(); break
        except Exception: time.sleep(.1)

    def request(path, method='GET', body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        h = {'Authorization': 'Bearer ' + token, **({'Content-Type': 'application/json'} if raw is None else {}), **(headers or {})}
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=h, method=method), timeout=20) as r:
            return json.load(r)

    request('/api/folders', 'POST', {'name': LONG_FOLDER, 'parentId': None, 'space': 'public'})
    for name in (LONG_DOC, '짧은 문서'):
        request('/api/docs', 'POST', raw=BASE_DOC.read_bytes(), headers={'x-file-name': urllib.parse.quote(name + '.hwpx'), 'x-space': 'public'})
    request('/api/drive/connection', 'PUT', {'site': SITE, 'token': info['token']})

    def width(page, sel):
        return page.evaluate(f'() => document.querySelector({json.dumps(sel)}).getBoundingClientRect().width')

    def drag(page, sel, dx):
        box = page.locator(sel).bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + min(box['height'] / 2, 200)
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + dx / 2, y, steps=4); page.mouse.move(x + dx, y, steps=4); page.mouse.up()
        page.wait_for_timeout(80)

    store = lambda page, key: page.evaluate(f'() => localStorage.getItem({json.dumps(key)})')

    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=CHROME)

        def watch(page):
            # 관리자 첫 진입 토큰 안내(web/admin-token-notice.js)는 이 시험 대상이 아니다 — 본 것으로 둔다
            page.add_init_script("try { localStorage.setItem('hwpx.adminTokenNotice', '2026-11-18T00:00:00Z'); } catch {}")
            page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            page.on('console', lambda m: errors.append('console: ' + m.text) if (m.type == 'error' or '[Vue warn]' in m.text) and 'Failed to load resource' not in m.text else None)

        # ── 넓은 창: 문서함 나무 폭 ──
        ctx = br.new_context(viewport={'width': 1360, 'height': 900})
        page = ctx.new_page(); watch(page)
        page.goto(f'{base}/?teaser=0#/t/{token}')
        page.locator('tr.doc', has_text='짧은 문서').wait_for(timeout=15000)
        w0 = width(page, '.libside')
        ok(abs(w0 - 240) < 1.5, f'문서함 나무 기본 폭 240px (실제 {w0:.1f})')
        lname = page.locator('.libtree .lt-row', has_text=LONG_FOLDER).locator('.lt-name')
        n0 = lname.evaluate('el => el.clientWidth')
        sp = page.locator('[data-testid="lib-splitter"]')
        ok(sp.get_attribute('role') == 'separator' and sp.get_attribute('aria-orientation') == 'vertical', '경계선 = role separator · 세로')
        drag(page, '[data-testid="lib-splitter"]', 120)
        w1 = width(page, '.libside')
        ok(abs(w1 - 360) < 2, f'경계선을 오른쪽으로 120px 끌면 나무가 넓어짐 ({w1:.1f})')
        ok(store(page, 'hwpx.lib.sideW') == str(round(w1)), '폭을 이 브라우저에 기억(hwpx.lib.sideW)')
        n1 = lname.evaluate('el => el.clientWidth')
        ok(n1 - n0 >= 115, f'넓힌 만큼 나무의 폴더 이름이 더 보임 ({n0} → {n1}px)')
        page.reload(); page.locator('tr.doc', has_text='짧은 문서').wait_for(timeout=15000)
        ok(abs(width(page, '.libside') - w1) < 2, '다시 열어도 넓힌 폭 그대로')
        sp.focus(); page.keyboard.press('ArrowLeft')
        ok(abs(width(page, '.libside') - (w1 - 16)) < 2, '← 키 = 16px 좁게')
        page.keyboard.press('Shift+ArrowRight')
        ok(abs(width(page, '.libside') - (w1 + 48)) < 2, 'Shift+→ = 64px 넓게')
        drag(page, '[data-testid="lib-splitter"]', 900)
        wmax = width(page, '.libside'); main = width(page, '.libpage > .doclist')
        ok(wmax <= 520.5 and main >= 419, f'끝까지 끌어도 최대 520px · 목록 420px 이상 (나무 {wmax:.1f}, 목록 {main:.1f})')
        drag(page, '[data-testid="lib-splitter"]', -900)
        ok(abs(width(page, '.libside') - 180) < 1.5, '왼쪽 끝까지 끌면 최소 180px')
        sp.dblclick(); page.wait_for_timeout(80)
        ok(abs(width(page, '.libside') - 240) < 1.5 and store(page, 'hwpx.lib.sideW') is None, '두 번 누르면 기본 폭 240px · 기억 지움')

        # ── 드라이브 폴더 칸 폭 ──
        page.locator('[data-testid="lib-drive"] button').click()
        page.locator('.dx-table tr', has_text='보고서.hwpx').wait_for(timeout=15000)
        d0 = width(page, '.dx-sidebar')
        ok(abs(d0 - 205) < 1.5, f'드라이브 폴더 칸 기본 폭 205px ({d0:.1f})')
        dsp = page.locator('[data-testid="drive-splitter"]')
        box, side = dsp.bounding_box(), page.locator('.dx-sidebar').bounding_box()
        ok(abs((box['x'] + box['width'] / 2) - (side['x'] + side['width'])) < 2, '드라이브 경계선은 폴더 칸 오른쪽 테두리 위')
        drag(page, '[data-testid="drive-splitter"]', 100)
        d1 = width(page, '.dx-sidebar')
        ok(abs(d1 - 305) < 2 and store(page, 'hwpx.drive.sideW') == str(round(d1)), f'끌면 폴더 칸이 넓어지고 기억(hwpx.drive.sideW, {d1:.1f})')
        drag(page, '[data-testid="lib-splitter"]', 60)
        ok(abs(width(page, '.libside') - 300) < 2 and abs(width(page, '.dx-sidebar') - d1) < 2, '드라이브를 연 채로 문서함 나무 폭도 따로 바뀜')
        page.screenshot(path=str(OUT / 'library_layout_wide.png'))
        dsp.dblclick(); page.wait_for_timeout(80)
        ok(abs(width(page, '.dx-sidebar') - 205) < 1.5 and store(page, 'hwpx.drive.sideW') is None, '드라이브 경계선 두 번 누르기 = 기본 폭')
        page.locator('.libtree [data-root="public"]').click()
        ctx.close()

        # ── 휴대전화 폭 ──
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page(); watch(page)
        page.goto(f'{base}/?teaser=0#/t/{token}')
        row = page.locator('tr.doc', has_text=LONG_DOC); row.wait_for(timeout=15000)
        ok(not page.locator('[data-testid="lib-splitter"]').is_visible(), '휴대전화: 경계선 숨김(나무가 위로)')
        rb, nb = row.bounding_box(), row.locator('td.lib-name').bounding_box()
        ok(nb['width'] >= rb['width'] - 12, f'문서 이름 칸이 줄 전체 폭 (이름 {nb["width"]:.0f} / 줄 {rb["width"]:.0f})')
        title = row.locator('.doc-link b')
        ok(page.evaluate('el => el.getClientRects().length >= 2 || el.getBoundingClientRect().height > 30', title.element_handle()), '긴 문서 이름은 잘리지 않고 여러 줄')
        ub = row.locator('td.doc-updated').bounding_box(); ab = row.locator('td.lib-acts').bounding_box()
        ok(ub['y'] >= nb['y'] + nb['height'] - 1 and ab['y'] >= nb['y'] + nb['height'] - 1, '수정 시각·단추는 이름 아래 줄')
        ok(row.locator('td.doc-updated').evaluate("el => getComputedStyle(el, '::before').content").strip('"\'') == '수정 ', '수정 시각 앞에 "수정"')
        ok(ab['x'] + ab['width'] <= rb['x'] + rb['width'] + 1 and row.locator('td.lib-acts button').first.is_visible(), '단추는 줄 안 오른쪽에 보임')
        ok(not row.locator('td.doc-props').is_visible() and not row.locator('td.doc-reqs').is_visible() and not page.locator('.libtable thead').is_visible(), '제안·AI 작업 대기·머리 줄은 숨김(정렬은 고르기 상자)')
        frow = page.locator('tr.folder', has_text=LONG_FOLDER)
        ok(frow.locator('td.lib-acts button').first.is_visible(), '폴더 줄 단추도 보임(예전 nth-child 숨김에 가려졌던 것)')
        fb = frow.locator('td.lib-name').bounding_box()
        ok(fb['width'] >= frow.bounding_box()['width'] - 12, '폴더 이름도 줄 전체 폭')
        ok(page.evaluate('() => document.documentElement.scrollWidth <= innerWidth'), '가로 넘침 없음')
        page.screenshot(path=str(OUT / 'library_layout_phone.png'), full_page=True)

        # 휴대전화 드라이브: 폴더 칸 숨김, 긴 파일 이름 줄바꿈
        page.locator('[data-testid="lib-drive"] button').click()
        frow = page.locator('.dx-table tr', has_text=LONG_DRIVE_FILE); frow.wait_for(timeout=15000)
        ok(not page.locator('.dx-sidebar').is_visible() and not page.locator('[data-testid="drive-splitter"]').is_visible(), '휴대전화 드라이브: 폴더 칸·경계선 숨김')
        span = frow.locator('.dx-name button > span:last-child')
        ok(page.evaluate('el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height > 24', span.element_handle()), '긴 드라이브 파일 이름은 말줄임 없이 여러 줄')
        page.locator('.dx-files').screenshot(path=str(OUT / 'library_layout_phone_drive.png'))
        ctx.close()
        br.close()

    ok(not errors, '화면 오류·Vue 경고 없음' + ('' if not errors else ': ' + ' | '.join(errors[:5])))
    print(f'통과 {count}개')


if __name__ == '__main__':
    main()
