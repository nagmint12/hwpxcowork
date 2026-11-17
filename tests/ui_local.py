"""PC 폴더 연결·함께 검토 화면(web/local.js · app.js DocList — docs/LOCAL_FOLDER_APP_2026-11-10.md).
격리 서버 둘(개인용 = PC 폴더 연결 켬, 중앙 = 보통 서버)과 임시 PC 폴더로 문서함 단추·창·꼬리표를 실제 화면에서 누른다.
화면 틀(Vue 템플릿)은 브라우저에서만 해석되므로 브라우저로 확인한다.   python -I tests/ui_local.py
"""
import atexit, json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
BASE_DOC = ROOT / 'tests' / 'fixtures' / 'hangul_trk_brk_base.hwpx'


def free_port():
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    return port


def main():
    OUT.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_local_ui_'))

    def cleanup():
        assert tmp.resolve().parent == Path(tempfile.gettempdir()).resolve() and tmp.name.startswith('hwpx_local_ui_')
        shutil.rmtree(tmp, ignore_errors=True)

    atexit.register(cleanup)
    pc = tmp / '내 문서'; (pc / '하위').mkdir(parents=True)
    shutil.copy(BASE_DOC, pc / '보고서.hwpx'); shutil.copy(BASE_DOC, pc / '하위' / '둘째.hwpx')
    me_token, central_token = secrets.token_hex(20), secrets.token_hex(20)
    servers = []; count = 0; errors = []

    def ok(value, message):
        nonlocal count
        assert value, message
        count += 1; print('  ✓ ' + message, flush=True)

    def start(name, cfg, more_env=None):
        port = free_port()
        home = tmp / name; home.mkdir()
        cfg = {'host': '127.0.0.1', 'port': port, 'dataDir': './data', 'tutorial': {'enabled': False}, 'ai': {'enabled': False, 'keyFile': str(home / 'no-key')}, **cfg}
        (home / 'config.json').write_text(json.dumps(cfg), encoding='utf-8')
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
        env.update(HWPX_COWORK_CONFIG=str(home / 'config.json'), HWPX_COWORK_DATA_DIR=str(home / 'data'), HWPX_COWORK_AI='off', **(more_env or {}))
        log = (OUT / f'local_ui_{name}.log').open('w', encoding='utf-8')
        proc = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        servers.append((proc, log))
        base = f'http://127.0.0.1:{port}'
        for _ in range(200):
            if proc.poll() is not None: raise RuntimeError(f'{name} 서버 시작 실패')
            try:
                urllib.request.urlopen(base + '/api/config', timeout=1).close(); return base
            except Exception: time.sleep(.1)
        raise RuntimeError(f'{name} 서버 준비 시간 초과')

    def request(base, path, token, method='GET', body=None, raw=False):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method=method)
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.read() if raw else json.load(response)

    try:
        mine = start('personal', {'users': [{'name': '나', 'role': 'admin', 'token': me_token}], 'local': {'enabled': True, 'writeDelayMs': 50},
                                  'changeRequests': {'requireApprovals': 0, 'allowDirectApply': True}}, {'HWPX_COWORK_LOCAL_TRASH': str(tmp / 'trash')})
        central = start('central', {'users': [{'name': '관리자', 'role': 'admin', 'token': secrets.token_hex(20)}, {'name': '홍길동', 'role': 'editor', 'token': central_token}]})
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=CHROME)
            ctx = br.new_context(viewport={'width': 1360, 'height': 900})
            page = ctx.new_page()
            page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            # 일부러 낸 오류 응답(없는 폴더 404·틀린 토큰 400)은 브라우저가 'Failed to load resource' 로 적는다 — 화면 오류(pageerror)·Vue 경고·그 밖의 console 오류만 모은다
            page.on('console', lambda m: errors.append('console: ' + m.text) if (m.type == 'error' or '[Vue warn]' in m.text) and 'Failed to load resource' not in m.text else None)
            page.on('dialog', lambda d: d.accept())
            # 개인용 앱의 첫 주소: 소개 영상 없이, 토큰으로 바로
            page.goto(f'{mine}/?teaser=0#/t/{me_token}')
            page.locator('.libpage').wait_for(timeout=15000)
            ok(page.locator('[data-testid="lib-local"]').is_visible() and page.locator('[data-testid="lib-remotes"]').is_visible(), '문서함에 [PC 폴더 연결]·[검토 서버] 단추(로그인 화면 없이 열림)')

            # ── PC 폴더 연결 ──
            page.locator('[data-testid="lib-local"]').click()
            dlg = page.locator('[data-testid="local-dialog"]'); dlg.wait_for()
            ok(dlg.get_by_text('연결한 폴더 없음').is_visible() and page.locator('[data-testid="local-pick"]').is_visible(), '연결 창: 빈 목록·[폴더 고르기]·경로 칸')
            page.locator('[data-testid="local-path"]').fill(str(tmp / '없는 폴더'))
            page.locator('[data-testid="local-link"]').click()
            page.locator('[data-testid="local-error"]').wait_for()
            ok('폴더가 없습니다' in page.locator('[data-testid="local-error"]').inner_text(), '없는 폴더는 창 안에 알림')
            page.locator('[data-testid="local-path"]').fill(str(pc))
            page.locator('[data-testid="local-link"]').click()
            dlg.wait_for(state='detached', timeout=10000)
            page.locator('.lib-crumbs a.cur', has_text='내 문서').wait_for()
            ok(True, '연결하면 창이 닫히고 그 폴더로 간다')
            ok(page.locator('.libtree .lt-pc').count() == 1 and page.locator('.libtree .lt-row', has_text='내 문서').is_visible(), '나무: 개인 문서함 아래 연결한 폴더에 PC 표시')
            row = page.locator('tr.doc', has_text='보고서')
            row.wait_for()
            ok(row.locator('[data-testid="doc-pc"]').inner_text().strip() == 'PC' and str(pc) in (row.locator('[data-testid="doc-pc"]').get_attribute('title') or ''), '문서 줄: PC 꼬리표(올리면 경로)')
            ok(page.locator('tr.folder', has_text='하위').is_visible(), '하위 폴더가 보인다')

            # ── 검토 서버 ──
            page.locator('[data-testid="lib-remotes"]').click()
            rdlg = page.locator('[data-testid="remotes-dialog"]'); rdlg.wait_for()
            page.locator('[data-testid="remote-url"]').fill(central)
            page.locator('[data-testid="remote-token"]').fill('틀린-토큰')
            page.locator('[data-testid="remote-add"]').click()
            page.locator('[data-testid="remote-error"]').wait_for()
            ok('토큰' in page.locator('[data-testid="remote-error"]').inner_text(), '틀린 토큰은 등록하지 않고 알림')
            page.locator('[data-testid="remote-token"]').fill(central_token)
            page.locator('[data-testid="remote-name"]').fill('중앙 서버')
            page.locator('[data-testid="remote-add"]').click()
            rdlg.locator('li[data-remote]', has_text='중앙 서버').wait_for(timeout=10000)
            ok('홍길동' in rdlg.locator('li[data-remote]').inner_text() and central_token not in page.content(), '등록한 서버가 목록에(그 서버의 내 이름과 함께) — 토큰은 화면에 싣지 않는다')
            page.locator('.floatwin.libdlg .fw-head button[aria-label="닫기"]').click()

            # ── 함께 검토: 보내기 → 서버에서 검토 → 검토본 가져오기 ──
            row.locator('[data-testid="doc-review-open"]').click()
            vdlg = page.locator('[data-testid="review-dialog"]'); vdlg.wait_for()
            page.locator('[data-testid="review-send"]').click()
            page.locator('[data-testid="review-sent"]').wait_for(timeout=15000)
            docs = request(central, '/api/docs', central_token)
            sent = next((d for d in docs if d['title'] == '보고서'), None)
            ok(sent is not None and sent['space'] == 'private', '보내기: 중앙 서버의 내 개인 문서함에 새 문서')
            page.locator('.floatwin.libdlg .fw-head button[aria-label="닫기"]').click()
            row.locator('[data-testid="doc-review"]').wait_for()
            ok('중앙 서버' in row.locator('[data-testid="doc-review"]').inner_text(), '문서 줄에 보낸 서버 꼬리표')
            request(central, f"/api/docs/{sent['id']}/memos", central_token, 'POST', {'ref': 's0/p1', 'find': '둘째', 'text': '화면 시험: 중앙 서버 검토 의견'})
            row.locator('[data-testid="doc-review-open"]').click()
            vdlg.wait_for()
            vdlg.locator('.rv-new').wait_for(timeout=10000)
            ok(True, '서버 문서가 바뀌면 새 내용 표시')
            page.locator('[data-testid="review-fetch"]').click()
            vdlg.get_by_text('가져옴').wait_for(timeout=15000)
            local_docs = request(mine, '/api/docs', me_token)
            mine_doc = next(d for d in local_docs if d['fileName'] == '보고서.hwpx')
            memos = request(mine, f"/api/docs/{mine_doc['id']}/memos", me_token)
            ok(any('화면 시험: 중앙 서버 검토 의견' in m['text'] for m in memos), '검토본 가져오기: 내 문서에 서버의 검토 의견')
            tracked = request(central, f"/api/docs/{sent['id']}/file?kind=tracked", central_token, raw=True)
            # 서버가 PC 파일을 바꿔 끼우는 순간에 읽으면 Windows 는 잠깐 PermissionError 를 낸다 — 그때는 다시 읽는다
            def pc_bytes():
                try: return (pc / '보고서.hwpx').read_bytes()
                except PermissionError: return None
            saved = None
            for _ in range(80):
                saved = pc_bytes()
                if saved == tracked: break
                time.sleep(.1)
            ok(saved == tracked, '가져온 검토본이 PC 파일에 저장됨')
            page.locator('.floatwin.libdlg .fw-head button[aria-label="닫기"]').click()

            # ── 문서 화면의 PC 표시 ──
            row.locator('[data-testid="doc-open-title"]').click()
            pill = page.locator('[data-testid="pc-pill"]'); pill.wait_for(timeout=20000)
            ok(pill.inner_text().strip().startswith('PC') and str(pc) in (pill.get_attribute('title') or ''), '문서 화면 위 PC 표시(올리면 경로·저장 상태)')
            page.goto(f'{mine}/?teaser=0#/')
            page.locator('.libpage').wait_for(timeout=15000)

            # ── 옮기기 창: PC 폴더 문서는 PC 폴더만 ──
            row = page.locator('tr.doc', has_text='보고서'); row.wait_for()
            row.locator('button[aria-label="옮기기"]').click()
            mv = page.locator('[data-testid="move-dialog"]'); mv.wait_for()
            labels = [t.strip() for t in mv.locator('li[role="option"]').all_inner_texts()]
            ok(len(labels) == 2 and any('내 문서' in t for t in labels) and any('하위' in t for t in labels) and not any('공용 문서함' in t for t in labels), f'옮기기 창에는 PC 폴더만: {labels}')
            mv.locator('li[role="option"]', has_text='하위').click()
            page.locator('[data-testid="move-ok"]').click()
            mv.wait_for(state='detached', timeout=10000)
            ok((pc / '하위' / '보고서.hwpx').exists() and not (pc / '보고서.hwpx').exists(), '옮기면 PC 파일도 옮겨진다')

            # ── 연결 끊기 ──
            page.locator('.lib-crumbs a', has_text='개인 문서함').click()
            folder = page.locator('tr.folder', has_text='내 문서'); folder.wait_for()
            ok(folder.locator('.lib-badge.pc').is_visible() and folder.locator('button[aria-label="폴더 삭제"]').count() == 0, '연결한 폴더 줄: PC 꼬리표, 지우기 대신 연결 끊기')
            folder.locator('[data-testid="local-unlink"]').click()
            folder.wait_for(state='detached', timeout=10000)
            ok((pc / '하위' / '보고서.hwpx').exists() and page.locator('.libtree .lt-pc').count() == 0, '연결을 끊어도 PC 파일은 그대로, 문서함에서만 빠진다')

            # ── 보통 서버(PC 폴더 연결 꺼짐)의 문서함은 예전 그대로: 새 단추·꼬리표가 없다 ──
            other = br.new_context(viewport={'width': 1360, 'height': 900}).new_page()
            other.on('pageerror', lambda e: errors.append('pageerror(중앙): ' + str(e)))
            other.on('console', lambda m: errors.append('console(중앙): ' + m.text) if (m.type == 'error' or '[Vue warn]' in m.text) and 'Failed to load resource' not in m.text else None)
            other.goto(f'{central}/?teaser=0#/t/{central_token}')
            other.locator('.libpage').wait_for(timeout=15000)
            other.locator('.libtree .lt-root', has_text='개인 문서함').click()
            crow = other.locator('tr.doc', has_text='보고서'); crow.wait_for(timeout=10000)
            ok(other.locator('[data-testid="lib-local"]').count() == 0 and other.locator('[data-testid="lib-remotes"]').count() == 0
               and crow.locator('[data-testid="doc-pc"]').count() == 0 and crow.locator('[data-testid="doc-review-open"]').count() == 0
               and crow.locator('button[aria-label="옮기기"]').count() == 1, '보통 서버의 문서함에는 PC 폴더 단추·꼬리표가 없고 문서 줄은 그대로')
            br.close()
        ok(not errors, '화면 오류·Vue 경고 없음: ' + ' | '.join(errors[:5]))
        print(f'PC 폴더 연결 화면: {count}개 확인 통과')
    finally:
        for proc, log in servers:
            proc.terminate()
            try: proc.wait(timeout=10)
            except Exception: proc.kill()
            log.close()


if __name__ == '__main__':
    main()
