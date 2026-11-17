"""도움말·중앙서버 주소 회귀: 임시서버/새토큰/모의AI. 실제 config/data 접근 없음."""
import atexit, json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.request, zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'
OUT.mkdir(exist_ok=True)

def main():
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_help_'))
    def cleanup():
        assert tmp.resolve().parent == Path(tempfile.gettempdir()).resolve() and tmp.name.startswith('hwpx_help_')
        shutil.rmtree(tmp, ignore_errors=True)
    atexit.register(cleanup)
    token = secrets.token_hex(20); member = secrets.token_hex(20)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    config = { 'host': '127.0.0.1', 'port': port, 'publicUrl': f'http://localhost:{port}', 'dataDir': './data', 'tutorial': {'enabled': False},
      'users': [{'name': '도움말시험', 'role': 'admin', 'token': token}, {'name': '참여자시험', 'role': 'editor', 'token': member}], 'studio': {'mode': 'local'},
      'ai': {'enabled': False, 'keyFile': str(tmp / 'no-api-key')} }
    cp = tmp / 'config.json'; cp.write_text(json.dumps(config), encoding='utf-8')
    env = { k:v for k,v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_') }
    env.update(HWPX_COWORK_CONFIG=str(cp), HWPX_COWORK_DATA_DIR=str(tmp / 'data'), HWPX_COWORK_AI_MOCK='1', HWPX_COWORK_HOST='127.0.0.1', HWPX_COWORK_PORT=str(port))
    count = 0; errors = []
    def ok(value, message):
        nonlocal count
        if not value: raise AssertionError(message)
        count += 1; print('  ✓ ' + message, flush=True)
    with (OUT / 'help_server.log').open('w', encoding='utf-8') as log:
        srv = subprocess.Popen(['node', 'server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(150):
                if srv.poll() is not None: raise RuntimeError('시험 서버 시작 실패')
                try:
                    with urllib.request.urlopen(base + '/api/config', timeout=1) as res:
                        if json.load(res).get('nonce'): break
                except Exception: time.sleep(.1)
            else: raise RuntimeError('시험 서버 시작 시간 초과')
            with sync_playwright() as p:
                br = p.chromium.launch(executable_path=CHROME, args=['--host-resolver-rules=MAP cowork.test 127.0.0.1', '--no-proxy-server'])
                ctx = br.new_context(viewport={'width':1280,'height':900})
                # 2026-11-04 낡은 흐름 고침: 11-01 부터 토큰 없는 첫 방문은 web/intro.js 가 소개 영상(teaser3)으로 보낸다.
                # 이 시험은 로그인 화면을 보므로 소개 영상을 이미 본 브라우저로 연다(영상 이동은 web/intro.js 가 맡는 별도 흐름).
                ctx.add_init_script("try { localStorage.setItem('hwpx-cowork.teaser3Seen', '2026-11-04'); } catch (e) {}")
                page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base)
                page.wait_for_selector('[data-testid="help-login"]')
                ok(page.locator('[data-testid="help-login"]').get_attribute('href') == '/help.html#join', '로그인 전 사용 설명서 접근')
                page.goto(base + '/help.html')
                page.wait_for_function("document.querySelector('#codex-command').textContent.includes('--provider codex')")
                ok(page.locator('h1').inner_text() == '한글 문서를 여럿이 함께 고치고, AI에게 도움을 받습니다.', '로그인 없이 참여자 설명서 읽기')
                order = page.evaluate("[...document.querySelectorAll('main > section:not([hidden])')].map(s => s.id)")
                # 2026-11-13: 내 PC 의 AI(Codex·Claude Code, 기본) → ChatGPT 웹(고급) → API 키(유료) 순서
                ok(order[:5] == ['start', 'join', 'library', 'review', 'ai'] and order.index('agents') < order.index('chatgpt-oauth') < order.index('personal-key'), '개요 → 문서함 → 연결(내 PC 의 AI → ChatGPT 웹 → API 키) 순서: ' + ','.join(order))
                ok(page.locator('.method-grid a').count() == 3 and 'API' in page.locator('.method-grid').inner_text(), '연결 3가지 방법을 한눈에 비교하는 카드')
                ok(all(page.locator('#' + a).count() == 1 for a in ['start', 'join', 'review', 'ai', 'automatic', 'worker', 'codex', 'chatgpt-oauth', 'personal-key']), '다른 화면이 거는 설명서 주소 유지')
                # 2026-11-17: MCP 기본 연결이 새 연결(v2 — server/mcp2.js mcpSurface)이라 ChatGPT 프롬프트는 인자 없는 task 를 되풀이한다(claim_next_request 는 예전 연결에만)
                prompt = page.locator('#queue-prompt').text_content()
                ok('대기열을 처리해 줘' in page.locator('#chatgpt-oauth').inner_text() and 'task를 인자 없이' in prompt and 'claim_next_request' not in prompt and '?v=1' in page.locator('#other-mcp').text_content(), 'Work 채팅용 대기열 처리 프롬프트(새 연결)·예전 연결 주소와 말 한마디 처리 안내')
                source = page.content(); visible = page.locator('main').inner_text()
                ok(not any(w in source for w in ['SSE', 'ai_request.created', '이벤트 구독', 'Scheduled', 'events-status']) and not any(w in visible for w in ['BAZE', 'Baze', 'OpenAI API 키', 'Anthropic']), '이벤트 구독·예약 실행·SSE 안내 없음, 참여자 글에 BAZE·제공업체 직접 연결 없음')
                ok(page.locator('#host').is_hidden() and page.locator('#manual').is_hidden() and page.locator('#worker-api').is_hidden() and page.locator('nav a[href="#manual"]').is_hidden(), '로그인 전에는 관리자 절과 목차 숨김')
                ok(page.locator('#manual-content').inner_html() == '', '관리자가 아니면 상세 매뉴얼을 불러오지 않음')
                for resource in ['/manual-resources/AGENT_SETUP.md', '/manual-resources/Caddyfile.example']:
                    with urllib.request.urlopen(base + resource, timeout=2) as response:
                        ok(response.status == 200 and bool(response.read()), '로그인 없이 보조 자료 읽기: ' + resource.rsplit('/', 1)[-1])
                page.click('#download-worker')
                ok('먼저 내 토큰으로 로그인' in page.locator('#worker-download-status').inner_text(), '실행기 다운로드는 로그인 안내')

                participant = br.new_context(viewport={'width':1280,'height':900})
                participant.add_init_script('localStorage.setItem("hwpx.token", ' + json.dumps(member) + ')')
                pp = participant.new_page(); pp.on('pageerror', lambda e: errors.append(str(e)))
                with pp.expect_response(lambda r: r.url.endswith('/api/me')):
                    pp.goto(base + '/help.html#host')
                pp.wait_for_timeout(300)
                ok(pp.locator('#host').is_hidden() and pp.locator('#connections').is_hidden() and pp.locator('nav a[href="#host"]').is_hidden(), '참여자(편집자) 로그인에도 관리자 절 숨김')
                participant.close()

                admin = br.new_context(viewport={'width':1280,'height':900})
                admin.add_init_script('localStorage.setItem("hwpx.token", ' + json.dumps(token) + ')')
                page = admin.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base + '/help.html')
                page.wait_for_selector('#manual', state='visible')
                ok(page.locator('#host').is_visible() and page.locator('nav a[href="#manual"]').is_visible(), '관리자 로그인에서만 관리자 절과 목차 표시')
                page.wait_for_function("document.querySelector('#manual-content').getAttribute('aria-busy') === 'false' && document.querySelector('#manual-content').textContent.includes('11. 검증 결과')")
                manual = page.locator('#manual-content')
                ok(manual.locator('h3').filter(has_text='1. 어느 PC에 무엇을 설치하나요?').count() == 1 and manual.locator('h3').filter(has_text='11. 검증 결과').count() == 1, '관리자는 상세 운영 매뉴얼을 처음부터 마지막 절까지 읽음')
                # 표 6개·AGENT_SETUP 링크 2개: 2026-11-14 매뉴얼에 'AI 수신 원문과 오류 판정 기록' 표와 Claude Code 실행기 절의 [Claude Code 안내] 링크가 더해졌다
                ok(manual.locator('table').count() == 6 and manual.locator('pre code').count() >= 10, '원본 매뉴얼의 표와 명령 예제를 본문에 표시')
                ok(manual.locator('a[href="/manual-resources/AGENT_SETUP.md"]').count() == 2 and manual.locator('a[href="/manual-resources/Caddyfile.example"]').count() == 1, '보조 설정 문서 링크를 서버 자료 경로로 연결')

                attempts = [0]
                def manual_failure_once(route):
                    attempts[0] += 1
                    if attempts[0] == 1: route.fulfill(status=503, body='temporary failure')
                    else: route.continue_()
                page.route('**/manual.md', manual_failure_once)
                page.goto(base + '/help.html?embedded=1#manual')
                page.wait_for_selector('#manual', state='visible')
                page.wait_for_selector('#manual-retry:visible')
                ok(page.locator('.help-top').is_hidden() and 'embedded-help' in page.locator('html').get_attribute('class'), '프로그램 안의 설명서는 중복 상단 헤더를 숨김')
                ok('불러오지 못했습니다' in page.locator('#manual-status').inner_text(), '매뉴얼 요청 실패 안내와 재시도 제공')
                page.click('#manual-retry')
                page.wait_for_function("document.querySelector('#manual-content').textContent.includes('11. 검증 결과')")
                ok(page.locator('#manual-retry').is_hidden() and '전체 매뉴얼' in page.locator('#manual-status').inner_text(), '재시도로 매뉴얼 전체를 다시 표시')
                page.unroute('**/manual.md', manual_failure_once)

                remote = f'http://cowork.test:{port}'
                auth = br.new_context(viewport={'width':1280,'height':900}, accept_downloads=True)
                auth.add_init_script('localStorage.setItem("hwpx.token", ' + json.dumps(token) + ')')
                pg = auth.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)))
                pg.goto(remote)
                pg.wait_for_selector('[data-testid="help-list"]')
                pg.click('.list-connections > summary')
                ok(remote + '/mcp' in pg.locator('.list-connections').inner_text(), '원격 목록에서 중앙 localhost 대신 실제 접속 주소 사용')
                uploaded = pg.evaluate("""async () => { const data = await fetch('/help.html').then(r=>r.text()); return data.includes('연결 창구') && data.includes('내 토큰의 권한으로만'); }""")
                ok(uploaded, 'MCP 서버를 연결 창구로 설명하고 개인 토큰 원칙 제공')
                pg.goto(remote + '/help.html')
                pg.wait_for_function('(url) => document.querySelector("#shared-mcp").textContent === url', arg=remote + '/mcp')
                ok(pg.locator('#current-web').inner_text() == remote, '현재 브라우저 접속 주소 표시')
                ok(pg.locator('#shared-mcp').inner_text() == remote + '/mcp', '원격 설명서 MCP 복사 주소 수정')
                ok(f'url = "{remote}/mcp?agent=Codex"' in pg.locator('#codex-mcp-config').text_content(), 'Codex MCP 설정 예제에 실제 접속 주소 사용')
                pg.wait_for_selector('#worker-api', state='visible')
                command = pg.locator('#worker-command').inner_text()
                ok('BAZE_API_KEY' in command and '--provider openai --gateway baze' in command, '관리자 API 실행기 예제는 API(--gateway baze)이 기본')
                pg.select_option('#gateway', 'direct'); pg.select_option('#provider', 'gemini'); pg.fill('#model-id', 'models/test-gemini')
                command = pg.locator('#worker-command').inner_text()
                ok('GEMINI_API_KEY' in command and "--provider gemini --model 'models/test-gemini'" in command, 'Gemini 개인 worker 예제 생성')
                ok(remote + '/mcp' in command and token not in command, 'worker 예제에 중앙 주소 사용·개인 토큰 노출 없음')
                with pg.expect_download(timeout=15000) as dl:
                    pg.click('#download-worker')
                download = dl.value
                archive_path = tmp / 'worker.zip'; download.save_as(str(archive_path))
                ok(download.suggested_filename == 'hwpx-cowork-worker.zip', '개인 AI 실행기 ZIP 다운로드')
                with zipfile.ZipFile(archive_path) as archive:
                    names = archive.namelist()
                    ok(any(n.endswith('ai-worker.mjs') for n in names) and any(n.endswith('package.json') for n in names), '실행기 ZIP에 CLI·최소 package 포함')
                    ok(all(token.encode() not in archive.read(n) for n in names if not n.endswith('/')), '실행기 ZIP에 개인 토큰 미포함')

                diagnostic = { 'binding': {'message':'공유 접속을 받을 수 있습니다.'}, 'recommended': {'webUrl': f'http://localhost:{port}', 'selectionRequired':True},
                  'lan': [{'label':'이더넷', 'webUrl':f'http://10.0.0.8:{port}', 'note':'접속 확인 필요'}, {'label':'VPN', 'webUrl':f'http://192.168.4.8:{port}', 'note':'접속 확인 필요'}],
                  'warnings':[{'code':'MULTIPLE_ADDRESSES', 'message':'여러 네트워크가 있습니다. 주소를 고르세요.'}], 'external':{'message':'외부 HTTPS 주소 미설정'} }
                pg.route('**/api/connections', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(diagnostic)))
                pg.click('#check-connections')
                pg.wait_for_selector('#connection-result .address')
                ok(pg.locator('#connection-result .address').count() == 2, '점검 결과에서 내부망 주소 후보를 모두 표시')
                ok(pg.locator('#shared-mcp').inner_text() == remote + '/mcp', '다중 NIC의 첫 후보로 주소를 자동 변경하지 않음')
                pg.locator('#connection-result .address button').nth(1).click()
                ok(pg.locator('#shared-mcp').inner_text() == f'http://192.168.4.8:{port}/mcp', '선택한 공유 주소를 MCP·명령 예제에 반영')
                pg.locator('#check-connections').scroll_into_view_if_needed(); pg.screenshot(path=str(OUT / 'help_desktop.png'))
                pg.set_viewport_size({'width':390,'height':844}); pg.goto(remote + '/help.html#worker')
                pg.wait_for_function("document.querySelector('#codex-command').textContent.includes('--provider codex')")
                pg.wait_for_selector('#manual', state='visible')
                ok(pg.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), '390px 화면에서 설명서 가로 넘침 없음')
                pg.screenshot(path=str(OUT / 'help_mobile.png'))
                pg.locator('nav a[href="#manual"]').click()
                pg.wait_for_function("document.querySelector('#manual-content').textContent.includes('11. 검증 결과')")
                ok(pg.locator('#manual').is_visible() and pg.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), '390px 화면에서 매뉴얼 표·코드는 본문 안에서 가로 스크롤')
                ok(not errors, '도움말·목록 페이지 오류 없음' + (': ' + ' | '.join(errors) if errors else ''))
                br.close()
            print(f'결과: {count}/{count} 통과', flush=True)
        finally:
            srv.terminate()
            try: srv.wait(timeout=10)
            except subprocess.TimeoutExpired: srv.kill(); srv.wait(timeout=5)
    cleanup()

if __name__ == '__main__': main()
