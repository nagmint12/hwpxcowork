"""프로그램 안 설명서를 열고 닫아도 문서·보내지 않은 AI 요청이 그대로 유지되는지 확인한다."""
import atexit, json, os, secrets, shutil, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe'

def main():
    OUT.mkdir(exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='hwpx_help_dialog_'))
    def cleanup():
        assert tmp.resolve().parent == Path(tempfile.gettempdir()).resolve() and tmp.name.startswith('hwpx_help_dialog_')
        shutil.rmtree(tmp, ignore_errors=True)
    atexit.register(cleanup)
    token = secrets.token_hex(20)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    cfg = {'host':'127.0.0.1', 'port':port, 'dataDir':'./data', 'tutorial': {'enabled': False}, 'users':[{'name':'내장설명서시험','role':'admin','token':token}], 'ai':{'enabled':False,'keyFile':str(tmp/'no-key')}}
    config = tmp/'config.json'; config.write_text(json.dumps(cfg), encoding='utf-8')
    env = {k:v for k,v in os.environ.items() if not k.upper().startswith('HWPX_COWORK_')}
    env.update(HWPX_COWORK_CONFIG=str(config), HWPX_COWORK_DATA_DIR=str(tmp/'data'), HWPX_COWORK_HOST='127.0.0.1', HWPX_COWORK_PORT=str(port), HWPX_COWORK_AI='off')
    count = 0; errors = []
    def ok(value, message):
        nonlocal count
        assert value, message
        count += 1; print('  ✓ '+message, flush=True)
    with (OUT/'help_dialog_server.log').open('w', encoding='utf-8') as log:
        srv = subprocess.Popen(['node','server/index.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            base = f'http://127.0.0.1:{port}'
            for _ in range(150):
                if srv.poll() is not None: raise RuntimeError('격리 시험 서버 시작 실패')
                try:
                    urllib.request.urlopen(base+'/api/config', timeout=1).close(); break
                except Exception: time.sleep(.1)
            else: raise RuntimeError('서버 준비 시간 초과')
            req = urllib.request.Request(base+'/api/docs', data=(ROOT/'tests/fixtures/tool_memo_tracked.hwpx').read_bytes(), headers={'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream','X-File-Name':'manual-test.hwpx'}, method='POST')
            with urllib.request.urlopen(req) as response: doc = json.load(response)
            with sync_playwright() as p:
                br = p.chromium.launch(executable_path=CHROME)
                ctx = br.new_context(viewport={'width':1280,'height':900})
                page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base); page.locator('input[aria-label="접속 토큰"]').fill('아직 입력 중인 값')
                before = page.url
                page.locator('[data-testid="help-login"]').click()
                modal = page.locator('[data-testid="help-dialog"]')
                modal.wait_for(state='visible')
                inner = page.frame_locator('.help-dialog-frame')
                inner.locator('h1').first.wait_for()
                ok(page.url == before and len(ctx.pages) == 1, '로그인 화면 안에서 설명서를 열고 새 탭·주소 이동 없음')
                ok(inner.locator('.help-top').evaluate('(e)=>getComputedStyle(e).display') == 'none', '내장 화면에서 중복 머리글 숨김')
                ok(page.locator('[data-testid="help-full-manual"]').count() == 0 and inner.locator('#manual').is_hidden() and inner.locator('#host').is_hidden(), '로그인 전에는 상세 운영 매뉴얼 단추와 관리자 절 숨김')
                page.locator('[data-testid="help-close"]').click(); modal.wait_for(state='hidden')
                page.locator('[data-testid="help-login"]').click(); modal.wait_for(state='visible')
                inner.locator('h1').first.wait_for()
                ok(inner.locator('#join').count() == 1, '닫았다가 같은 설명서 버튼으로 다시 열기')
                inner.locator('body').press('Escape')
                modal.wait_for(state='hidden')
                ok(page.locator('input[aria-label="접속 토큰"]').input_value() == '아직 입력 중인 값', '설명서를 닫아도 로그인 입력 보존')
                page.locator('input[aria-label="접속 토큰"]').fill(token)
                page.get_by_role('button', name='들어가기', exact=True).click()
                page.locator('[data-testid="help-list"]').wait_for()
                page.goto(base+'/#/doc/'+doc['id'])
                page.wait_for_function('window.__doc?.editor?.ready', timeout=120000)
                page.evaluate('''() => {
                  const d=window.__doc; window.__helpEditor=d.editor.frame();
                  d.openComposer({ref:'s0/p0',refs:['s0/p0'],start:0,end:0,text:'',display:'시험 문단'},'instruct');
                }''')
                request = page.locator('.composer textarea').first
                request.wait_for(); request.fill('설명서를 보는 동안 보존할 AI 요청')
                document_url = page.url
                page.locator('[data-testid="help-doc"]').click()
                modal.wait_for(state='visible'); inner.locator('#review').wait_for()
                inner.locator('body').press('Escape'); modal.wait_for(state='hidden')
                ok(page.url == document_url and page.evaluate('window.__helpEditor === window.__doc.editor.frame()'), '설명서 전후 같은 문서·편집기 유지')
                ok(request.input_value() == '설명서를 보는 동안 보존할 AI 요청', '설명서 Escape로 닫아도 보내지 않은 요청 창·내용 보존')
                ok(page.locator('[data-testid="help-doc"]').evaluate('(e)=>e===document.activeElement'), '닫은 뒤 설명서 버튼으로 키보드 초점 복귀')
                page.locator('[data-testid="help-doc"]').click(); modal.wait_for(state='visible')
                page.locator('[data-testid="help-full-manual"]').click()
                inner.locator('#manual').wait_for()
                inner.get_by_text('어느 PC에 무엇을 설치하나요?', exact=False).first.wait_for()
                ok(inner.locator('#manual table').count() > 0 and inner.locator('#manual pre code').count() > 0, '관리자는 상세 매뉴얼 전문을 표·명령 예제로 프로그램 안에서 읽음')
                inner.locator('a[href="/manual-resources/Caddyfile.example"]').first.click()
                inner.get_by_text('reverse_proxy', exact=False).first.wait_for()
                page.locator('[data-testid="help-close"]').click(); modal.wait_for(state='hidden')
                page.locator('[data-testid="help-doc"]').click(); modal.wait_for(state='visible')
                inner.locator('#review').wait_for()
                ok(inner.locator('#review').count() == 1, '보조 자료를 읽고 같은 설명서 버튼으로 다시 열어도 설명서 복귀')
                page.locator('[data-testid="help-full-manual"]').click()
                inner.get_by_text('어느 PC에 무엇을 설치하나요?', exact=False).first.wait_for()
                page.screenshot(path=str(OUT/'help_in_app.png'))
                page.set_viewport_size({'width':390,'height':844})
                ok(modal.bounding_box()['width'] <= 390, '모바일 너비에서도 설명서 창이 화면 안에 표시')
                page.locator('[data-testid="help-close"]').click(); modal.wait_for(state='hidden')
                ok(request.input_value() == '설명서를 보는 동안 보존할 AI 요청', '닫기 버튼도 입력 중인 요청 보존')
                ok(not errors, '내장 설명서·문서 화면 JavaScript 오류 없음')
                br.close()
            print(f'결과: {count}/{count} 통과', flush=True)
        finally:
            srv.terminate()
            try: srv.wait(timeout=10)
            except subprocess.TimeoutExpired: srv.kill(); srv.wait(timeout=5)
    cleanup()

if __name__ == '__main__': main()
