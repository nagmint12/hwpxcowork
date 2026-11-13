"""웹 → 한글, 설치 없는 원본 구조 붙여넣기(한글 문서모델 hwpjson) 실제 경로 시험.

실제 Chromium 에서 Ctrl+C → Windows 클립보드(HTML Format) → 숨은 한글 Ctrl+V → 저장한 HWPX 를
같은 범위를 한글이 직접 복사·붙여넣은 결과와 비교한다. 원격 접속자처럼 로컬 한글 변환기는 끈다
(/api/clipboard/status → available:false), 그래서 클립보드에 Hwp Native 가 없어야 한다.
시험 내용으로 시스템 클립보드를 바꾸며, 끝나면 원래 글을 되돌린다. 한글·pywin32 필요.
"""
import json
import pathlib
import re
import runpy
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from playwright.sync_api import sync_playwright
_pagebreak = runpy.run_path(str(pathlib.Path(__file__).with_name('clipboard_pagebreak_check.py')))
verify_pdf, inspect_pdf = _pagebreak['verify_pdf'], _pagebreak['inspect_pdf']

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = '%USERPROFILE%/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe'
FRAME = "document.querySelector('.editorhost iframe')"
SOURCE = ROOT / 'testdata' / '매크로테스트용_저장.hwpx'
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 하위 프로세스마다 숨은 한글 하나: 지금 클립보드를 그대로 붙여 저장(paste) 또는 범위를 복사(copy),
# 또는 한/글 자체로 본문 문단 a 처음 ~ b 끝을 복사해 같은 한/글의 새 문서에 붙여 저장(copy-paste-pdf — Native 범위의 정답)
HANGUL = r'''
import pathlib, sys, time
import win32com.client, win32api, win32con, win32job, win32process
mode, arg, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
before = set(win32process.EnumProcesses())
hwp = win32com.client.DispatchEx('HWPFrame.HwpObject')
_, pid = win32process.GetWindowThreadProcessId(hwp.XHwpWindows.Item(0).WindowHandle)
assert pid not in before, 'not an isolated Hangul instance'
job = win32job.CreateJobObject(None, '')
info = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
info['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, info)
proc = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, pid)
try: win32job.AssignProcessToJobObject(job, proc)
finally: proc.Close()
try:
    hwp.SetMessageBoxMode(0x00011011)
    hwp.XHwpWindows.Item(0).Visible = False
    if mode == 'copy':
        assert hwp.Open(str(pathlib.Path(sys.argv[4]).resolve()), 'HWPX', 'forceopen:true')
        a, b = [int(x) for x in arg.split(',')]
        assert hwp.SelectText(a, 0, b, 0) if b >= 0 else hwp.HAction.Run('SelectAll')
        assert hwp.HAction.Run('Copy')
        # 한글은 지연 렌더링이라 끝나면 클립보드가 사라진다 — 같은 조건(HTML 만)으로 붙여넣도록 HTML Format 만 고정
        import win32clipboard as cb
        for _ in range(80):
            try: cb.OpenClipboard(); break
            except Exception: time.sleep(0.025)
        try:
            fmt = cb.RegisterClipboardFormat('HTML Format')
            html = cb.GetClipboardData(fmt)
            cb.EmptyClipboard()
            cb.SetClipboardData(fmt, html if isinstance(html, bytes) else html.encode('utf-8'))
        finally:
            cb.CloseClipboard()
    elif mode == 'copy-paste-pdf':
        assert hwp.Open(str(pathlib.Path(sys.argv[4]).resolve()), 'HWPX', 'forceopen:true')
        a, b = [int(x) for x in arg.split(',')]
        hwp.SetPos(0, a, 0)
        hwp.HAction.Run('Select')
        hwp.SetPos(0, b, 0)
        hwp.HAction.Run('MoveParaEnd')
        assert hwp.HAction.Run('Copy')
        hwp.HAction.Run('FileNew')
        assert hwp.HAction.Run('Paste'), 'paste failed'
        assert hwp.SaveAs(str(out), 'HWPX', '')
        assert hwp.SaveAs(str(out.with_suffix('.pdf')), 'PDF', ''), 'PDF save failed'
    else:
        hwp.HAction.Run('FileNew')
        assert hwp.HAction.Run('Paste'), 'paste failed'
        assert hwp.SaveAs(str(out), 'HWPX', '')
        if mode == 'paste-pdf':
            assert hwp.SaveAs(str(out.with_suffix('.pdf')), 'PDF', ''), 'PDF save failed'
finally:
    try: hwp.Clear(1); hwp.Quit()
    finally: job.Close()
'''


def clipboard(fn):
    import win32clipboard as cb
    for _ in range(80):
        try:
            cb.OpenClipboard()
            break
        except Exception:
            time.sleep(0.025)
    else:
        raise RuntimeError('clipboard busy')
    try:
        return fn(cb)
    finally:
        cb.CloseClipboard()


def read_formats():
    def read(cb):
        html_fmt = cb.RegisterClipboardFormat('HTML Format')
        native = cb.IsClipboardFormatAvailable(cb.RegisterClipboardFormat('Hwp Native'))
        html = cb.GetClipboardData(html_fmt) if cb.IsClipboardFormatAvailable(html_fmt) else b''
        return (html.encode('utf-8') if isinstance(html, str) else html), bool(native)
    return clipboard(read)


def hangul(mode, arg, out, src=None):
    cmd = [sys.executable, '-I', '-c', HANGUL, mode, arg, str(out)] + ([str(src)] if src else [])
    subprocess.run(cmd, check=True, timeout=240)


def body_signature(path):
    """저장한 HWPX 본문: 요소 수와, 서식 참조를 내용으로 푼 run/문단 서식 목록(id 차이 무시).

    표본 원본의 메모 7개 중 6개는 끝 표시가 없거나 수십 문단 뒤에서 끝나는 깨진 메모라 한글은 1개만,
    편집기는 문단 안에서 닫힌 3개를 읽는다. 그래서 메모는 따로 세고(memos) 나머지 본문만 비교한다."""
    z = zipfile.ZipFile(path)
    sec = z.read('Contents/section0.xml').decode('utf-8')
    memo_ids = re.findall(r'<hp:fieldBegin id="(\d+)" type="MEMO"', sec)
    memos = len(memo_ids)
    sec = re.sub(r'<hp:ctrl><hp:fieldBegin [^>]*type="MEMO"[\s\S]*?</hp:fieldBegin></hp:ctrl>', '', sec)
    for mid in memo_ids:
        sec = re.sub(r'<hp:ctrl><hp:fieldEnd beginIDRef="%s"[^>]*/></hp:ctrl>' % mid, '', sec)
    tags = {t: len(re.findall(r'<hp:%s\b' % t, sec)) for t in
            ['p', 'run', 'tbl', 'tc', 'pic', 'caption', 'autoNum', 'newNum', 'fieldBegin', 'fieldEnd', 'tab', 'lineBreak', 'rect', 'line', 'equation']}
    runs, paras = resolved_formats(path)
    text = ''.join(re.findall(r'<hp:t>([^<]*)</hp:t>', sec))
    bins = sorted(len(z.read(n)) for n in z.namelist() if n.startswith('BinData/'))
    return {'tags': tags, 'runs': runs, 'paras': paras, 'text': text, 'bins': bins, 'memos': memos}


HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
LANGS = {'hangul': 'HANGUL', 'latin': 'LATIN', 'hanja': 'HANJA', 'japanese': 'JAPANESE', 'other': 'OTHER', 'symbol': 'SYMBOL', 'user': 'USER'}


def resolved_formats(path, top=None):
    """본문(top=(첫, 끝) 이면 그 최상위 문단 범위)의 run·문단 서식 목록 — 메모 안 글은 빼고, 문서 차례대로.

    2026-11-04 낡은 기대값: 예전에는 charPr·paraPr 를 id 만 지우고 견줘 그 안의 글꼴 참조(fontRef hangul="3")·테두리/배경
    참조(borderFillIDRef)가 번호로 남았다. 2026-11-03 부터 한/글로 보내는 조각이 스타일 정의를 바꿔 싣기 때문에(아래 main 주석)
    붙인 문서의 글꼴·테두리 표에 항목이 더 생겨 같은 글꼴 이름도 번호가 밀린다(실측: 'KoPubWorld바탕체 Light' 가 우리 4 · 한/글 3).
    그래서 글꼴은 언어별 이름으로, 테두리/배경은 그 내용으로 풀어 견준다. 구역 정의만 든 run(붙인 문서 첫 문단)은 원본 범위에
    없으므로 뺀다(우리·한/글 쪽은 같이 빠진다)."""
    z = zipfile.ZipFile(path)
    head = z.read('Contents/header.xml').decode('utf-8')
    fonts = {ff.group(1): dict(re.findall(r'<hh:font id="(\d+)" face="([^"]*)"', ff.group(2)))
             for ff in re.finditer(r'<hh:fontface lang="(\w+)" fontCnt="\d+">([\s\S]*?)</hh:fontface>', head)}
    fills = {m.group(1): re.sub(r'\s+id="\d+"', '', m.group(0)) for m in re.finditer(r'<hh:borderFill id="(\d+)"[\s\S]*?</hh:borderFill>', head)}

    def resolve(xml):
        xml = re.sub(r'\s+id="\d+"', '', xml)
        xml = re.sub(r'<hh:fontRef ([^/]*)/>', lambda m: '<hh:fontRef ' + ' '.join(
            f'{k}="{fonts.get(LANGS[k], {}).get(v, v)}"' for k, v in re.findall(r'(\w+)="(\d+)"', m.group(1))) + '/>', xml)
        return re.sub(r'borderFillIDRef="(\d+)"', lambda m: 'borderFill="' + fills.get(m.group(1), m.group(1)).replace('"', "'") + '"', xml)
    char = {m.group(1): resolve(m.group(0)) for m in re.finditer(r'<hh:charPr id="(\d+)"[\s\S]*?</hh:charPr>', head)}
    para = {m.group(1): resolve(m.group(0)) for m in re.finditer(r'<hh:paraPr id="(\d+)"[\s\S]*?</hh:paraPr>', head)}
    tops = [c for c in ET.fromstring(z.read('Contents/section0.xml')) if c.tag == HP + 'p']
    if top:
        tops = tops[top[0]:top[1] + 1]
    runs, paras = [], []

    def walk(el):
        if el.tag == HP + 'fieldBegin' and el.get('type') == 'MEMO':
            return
        if el.tag == HP + 'p':
            paras.append(para.get(el.get('paraPrIDRef'), el.get('paraPrIDRef')))
        if el.tag == HP + 'run' and not (el.find(HP + 'secPr') is not None and el.find(HP + 't') is None):
            runs.append(char.get(el.get('charPrIDRef'), el.get('charPrIDRef')))
        for c in el:
            walk(c)
    for p in tops:
        walk(p)
    return runs, paras


def run_look(x):
    """run 의 보이는 모양(글꼴 이름·크기·색·장평·자간·상대 크기·위치·굵게/기울임) — 원본을 지켰는지 볼 때.
    useFontSpace 는 뺀다: 한/글은 자기 복사·붙여넣기에서도 이 값을 0 으로 바꾼다(원본 6 run 이 우리·한/글 모두 0, 실측)."""
    keep = [re.sub(r'\s*(borderFill|useFontSpace)="[^"]*"', '', re.search(r'<hh:charPr [^>]*>', x).group(0)),
            re.search(r'<hh:fontRef [^>]*/>', x).group(0)]
    keep += re.findall(r'<hh:(?:ratio|spacing|relSz|offset) [^>]*/>', x) + re.findall(r'<hh:(?:bold|italic)/>', x)
    return ' '.join(keep)


def para_look(x):
    """문단의 보이는 모양(정렬·머리 종류·줄 간격·여백) — 원본을 지켰는지 볼 때"""
    return repr(re.findall(r'<hh:align [^>]*/>|<hh:heading [^>]*/>|<hh:lineSpacing [^>]*/>', x)
                + re.findall(r'<hc:(intent|left|right|prev|next) value="(-?\d+)"', x))


def main():
    Server = runpy.run_path(str(ROOT / 'tests' / 'export_hangul.py'))['Server']
    saved = clipboard(lambda cb: cb.GetClipboardData(cb.CF_UNICODETEXT) if cb.IsClipboardFormatAvailable(cb.CF_UNICODETEXT) else None)
    with tempfile.TemporaryDirectory(prefix='hwpx_board_ui_') as tmp:
        tmp = pathlib.Path(tmp)
        source = tmp / 'source.hwpx'
        source.write_bytes(SOURCE.read_bytes())
        srv = Server(tmp)
        try:
            token = srv.tokens['a']
            # 첫 로그인 안내(결과보고서 튜토리얼로 바로 이동)가 시험 문서 경로를 가로채지 않게 한다.
            # 2026-11-04 낡은 기대값: 예전에는 POST /api/tutorial/visit(메뉴 방문 기록)로 이 이동을 막았다. 2026-11-01 밤부터는
            # 토큰마다 결과보고서 '완료' 기록이 없으면 인증 직후 그 연습 문서로 간다(docs/TUTORIAL_SESSIONS.md — visit 는 '로그인 첫 화면에
            # 영향을 주지 않는다'). 그래서 #/doc/<id> 대신 결과보고서가 열려 부분 선택 s0/p4~p10 이 엉뚱한 문서의 표지 글을 복사했다
            # (표·그림 없음 → 한/글 자체 붙여넣기와 tags 가 다름). 이제 실제 사용자처럼 결과보고서를 마친 토큰으로 연다
            # (entry → complete — 이 기록도 시험용 서버의 임시 data 안에만 남는다).
            def post(path):
                req = urllib.request.Request(srv.base + path, data=b'{}', method='POST',
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(req) as response:
                    assert response.status == 200
                    return json.load(response)
            intro = post('/api/tutorial/entry')
            assert intro.get('docId'), f'완료 전 토큰인데 결과보고서 연습이 없다: {intro}'
            assert post(f"/api/tutorial/{intro['docId']}/complete").get('saved')
            me = urllib.request.Request(srv.base + '/api/me', headers={'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(me) as response:
                assert json.load(response).get('tutorialIntroRequired') is False, '결과보고서를 마친 토큰은 첫 화면을 가로채지 않아야 한다'
            req = urllib.request.Request(srv.base + '/api/docs', data=source.read_bytes(), method='POST', headers={
                'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'x-file-name': 'board.hwpx'})
            with urllib.request.urlopen(req) as r:
                doc_id = json.load(r)['id']
            with sync_playwright() as p:
                br = p.chromium.launch(executable_path=CHROME, headless=False,
                                       args=['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows'])
                ctx = br.new_context(viewport={'width': 1440, 'height': 960})
                ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=srv.base)
                ctx.add_init_script("localStorage.setItem('hwpx.token', " + json.dumps(token) + ");")
                # 원격 접속자: 로컬 한글 변환기 없음 → Hwp Native 없이 HTML 만으로 옮겨야 한다
                ctx.route('**/api/clipboard/status', lambda route: route.fulfill(json={'available': False}))
                errors = []
                pg = ctx.new_page()
                pg.on('pageerror', lambda e: errors.append(str(e)))
                pg.goto(srv.base + '/#/doc/' + doc_id)
                pg.wait_for_function('window.__doc?.editor?.ready === true', timeout=120000)
                # 다른 문서(튜토리얼 등)로 넘어가 엉뚱한 범위를 복사하지 않았는지 — 위 2026-11-04 주석
                opened = pg.evaluate('() => window.__doc?.id')
                assert opened == doc_id, f'시험 문서 {doc_id} 대신 {opened} 가 열렸다'
                pg.wait_for_function(FRAME + '?.contentWindow?.rhwpCowork', timeout=30000)
                pg.evaluate('async () => await ' + FRAME + '.contentWindow.rhwpCowork.debug.settled()')
                point = pg.evaluate('() => ' + FRAME + '.contentWindow.rhwpCowork.debug.pointFor("s0/p0", 0)')
                box = pg.evaluate('() => { const r=' + FRAME + '.getBoundingClientRect(); return {x:r.left,y:r.top}; }')
                pg.mouse.click(point['x'] + box['x'] + 2, point['y'] + box['y'] + 2)

                # 마지막 칸 = 원본 HWPX 에서 같은 범위(최상위 문단 첫·끝 — 한글 SelectText(4,0,10,0) 과 같은 문단들)
                cases = [('부분 선택 s0/p4~p10', 's0/p4', 's0/p10', '4,10', (4, 10)), ('문서 전체', None, None, '0,-1', None)]
                for name, ref, end_ref, hrange, top in cases:
                    if ref:
                        assert pg.evaluate('([a,b]) => ' + FRAME + '.contentWindow.rhwpCowork.debug.select(a, 0, 0, b)', [ref, end_ref])
                    else:
                        pg.keyboard.press('Control+a')
                    clipboard(lambda cb: cb.EmptyClipboard())
                    pg.keyboard.press('Control+c')
                    deadline = time.time() + 15
                    html, native = b'', False
                    while time.time() < deadline:
                        html, native = read_formats()
                        if b'hwpEditorBoardContent' in html:
                            break
                        time.sleep(0.2)
                    assert b'hwpEditorBoardContent' in html, f'{name}: 클립보드 HTML 에 한글 문서모델이 없다'
                    assert not native, f'{name}: 원격 조건인데 Hwp Native 가 있다'
                    m = re.search(rb"data-jsonlen='(\d+)'><!--\[data-hwpjson\]", html)
                    json_start = m.end()
                    json_end = html.index(b'-->', json_start)
                    assert int(m.group(1)) == json_end - json_start, f'{name}: data-jsonlen 불일치'
                    json.loads(html[json_start:json_end].decode('utf-8'))
                    ours = tmp / 'ours.hwpx'
                    hangul('paste', '', ours)
                    # 같은 범위를 한글이 직접 복사 → 붙여넣기 (정답)
                    theirs = tmp / 'theirs.hwpx'
                    hangul('copy', hrange, tmp / 'unused.hwpx', source)
                    hangul('paste', '', theirs)
                    a, b = body_signature(ours), body_signature(theirs)
                    for key in ['tags', 'text', 'bins']:
                        assert a[key] == b[key], f'{name}: {key} 가 한글 자체 붙여넣기와 다르다\n ours={str(a[key])[:400]}\n theirs={str(b[key])[:400]}'
                    # 2026-11-04 낡은 기대값: run·문단 서식도 한글 자체 붙여넣기와 '같음'을 요구했다. 2026-11-03 부터 웹 → 한글 조각은
                    # 일부러 원본 서식을 지킨다 — 한/글은 받는 문서에 같은 이름 스타일이 있으면 조각의 스타일 정의와 같은 속성을 받는 문서
                    # 스타일 값으로 바꾸는데(한/글끼리 복사도 같음), 우리 조각은 스타일 정의를 바꿔 싣어 '원본 서식 유지'와 같은 모양이 된다
                    # (docs/CLIPBOARD_AND_FORMAT_COPY.md '웹 → 한/글 글꼴', CHANGELOG 2026-11-03, hancom_paste_styles.rs).
                    # 실측: 바탕글 문단의 캡션 글(KoPub바탕체 Light 11pt·줄 간격 180%)이 한/글 자체 붙여넣기에서는 새 문서 바탕글
                    # (함초롬바탕 10pt·160%)로 바뀌고 우리 것은 원본 그대로. 그래서 서식은 내용으로 풀어 견주고, 한글 자체 결과와 다른
                    # 곳은 모두 원본 문서의 같은 자리 모양을 지킨 곳이어야 한다(그 밖의 차이는 실패).
                    src_runs, src_paras = resolved_formats(source, top)
                    kept = {}
                    for key, src_list, look in [('runs', src_runs, run_look), ('paras', src_paras, para_look)]:
                        assert len(a[key]) == len(b[key]) == len(src_list), f'{name}: {key} 수 우리 {len(a[key])} · 한글 {len(b[key])} · 원본 {len(src_list)}'
                        diff = [i for i in range(len(a[key])) if a[key][i] != b[key][i]]
                        bad = [i for i in diff if look(a[key][i]) != look(src_list[i])]
                        assert not bad, (f'{name}: {key} 가 한글 자체 붙여넣기와도 원본과도 다르다 {bad[:10]}\n ours={look(a[key][bad[0]])[:400]}\n'
                                         f' source={look(src_list[bad[0]])[:400]}\n theirs={look(b[key][bad[0]])[:400]}')
                        kept[key] = len(diff)
                    assert a['memos'] >= b['memos'] >= (1 if ref else 1), f'{name}: 메모를 잃었다 {a["memos"]} < {b["memos"]}'
                    print(f'{name}: OK {json.dumps(a["tags"], ensure_ascii=False)} 메모 {a["memos"]}(한글 {b["memos"]}) '
                          f'그림 {len(a["bins"])}개, HTML {len(html)//1024}KB · 원본 서식을 지켜 한글 자체 결과와 다른 run {kept["runs"]}·문단 {kept["paras"]}', flush=True)
                # 튜토리얼의 안내대로 범위만 골라도 원래 화면의 쪽 경계가 유지되어야 한다.
                # 전체 쪽수만 비교하면 제목이 같은 쪽으로 당겨지는 결함을 놓친다.
                request = urllib.request.Request(srv.base + '/api/tutorial/start',
                    data=json.dumps({'tutorialId': 'clipboard'}).encode('utf8'), method='POST',
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urllib.request.urlopen(request) as response:
                    session = json.load(response)['docId']
                # 2026-11-04 낡은 흐름: 튜토리얼 연습 문서를 그대로 열었다. 지금 그 문서는 열자마자 안내(어두운 덮개 + '3. 한글과
                # 복사·붙여넣기' 말풍선 [시작하기])가 편집기를 덮어 시험의 편집기 클릭이 덮개에 걸리고(document.elementFromPoint =
                # div.tour-shade) Ctrl+A·C 가 편집기로 가지 않아 '클립보드 준비 시간 초과'가 났다(web/tutorial-steps.js clipboard —
                # 직접 선택·복사하게 하는 안내는 의도된 화면). 이 시험이 보는 것은 그 문서 내용의 쪽 경계이므로, 같은 연습 문서의
                # 작업본(편집기가 여는 바이트)을 보통 문서로 올려 연다.
                fetch = urllib.request.Request(srv.base + f'/api/docs/{session}/file?kind=working', headers={'Authorization': 'Bearer ' + token})
                with urllib.request.urlopen(fetch) as response:
                    tutorial_bytes = response.read()
                tutorial_source = tmp / 'clipboard-tutorial.hwpx'  # Native 범위 정답(한/글 자체 복사·붙여넣기)의 원본
                tutorial_source.write_bytes(tutorial_bytes)
                upload = urllib.request.Request(srv.base + '/api/docs', data=tutorial_bytes, method='POST', headers={
                    'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream', 'x-file-name': 'clipboard-tutorial.hwpx'})
                with urllib.request.urlopen(upload) as response:
                    tutorial = json.load(response)['id']
                for remote in [True, False]:
                    if not remote:
                        ctx.unroute('**/api/clipboard/status')
                    pg.goto(srv.base + '/#/doc/' + tutorial)
                    pg.reload()  # capability 캐시는 문서마다 새로 만든다.
                    pg.wait_for_function('window.__doc?.editor?.ready === true', timeout=120000)
                    assert pg.evaluate('() => window.__doc?.id') == tutorial, '튜토리얼 내용 문서가 아닌 다른 문서가 열렸다'
                    pg.wait_for_function(FRAME + '?.contentWindow?.rhwpCowork', timeout=30000)
                    pg.evaluate('''async () => {
                      const w=document.querySelector('.editorhost iframe').contentWindow;
                      w.rhwpStudio.automation.registerCommand({id:'ext:clipboard-pages',label:'쪽 나눔 시험',
                        execute(s){w.__clipboardPages=s.wasm;}});
                      await w.rhwpStudio.automation.execute('ext:clipboard-pages');
                    }''')
                    ranges = pg.evaluate('''() => {
                      const w=document.querySelector('.editorhost iframe').contentWindow,d=w.__clipboardPages;
                      const ps=[];
                      for(let s=0;s<d.getSectionCount();s++)for(let p=0;p<d.getParagraphCount(s);p++){
                        const n=d.getParagraphLength(s,p);ps.push({ref:`s${s}/p${p}`,n,text:d.getTextRange(s,p,0,n)});
                      }
                      return {counts:Array.from({length:d.getSectionCount()},(_,s)=>d.getParagraphCount(s)),
                        start:ps.find(p=>p.text.startsWith('▼')),end:ps.find(p=>p.text.startsWith('▲')),
                        before:ps.find(p=>p.text.startsWith('쪽 아래 꼬리말에는')),
                        formats:ps.find(p=>p.text.startsWith('굵게 · 기울임'))};
                    }''')
                    point = pg.evaluate('() => {const f=document.querySelector(".editorhost iframe"),r=f.getBoundingClientRect(),p=f.contentWindow.rhwpCowork.debug.pointFor("s0/p0",0);return{x:p.x+r.left+2,y:p.y+r.top+2};}')
                    pg.mouse.click(point['x'], point['y'])
                    for label, first, last in [('full', None, None),
                            ('tutorial-range', ranges['start'], ranges['end']),
                            ('boundary-range', ranges['before'], ranges['formats'])]:
                        if first:
                            assert pg.evaluate('([a,b]) => document.querySelector(".editorhost iframe").contentWindow.rhwpCowork.debug.select(a.ref,0,b.n,b.ref)', [first, last])
                        else:
                            pg.keyboard.press('Control+a')
                        clipboard(lambda cb: cb.EmptyClipboard())
                        pg.keyboard.press('Control+c')
                        deadline = time.time() + 30
                        while True:
                            html, native = read_formats()
                            if b'hwpEditorBoardContent' in html and (remote or native):
                                break
                            assert time.time() < deadline, f'{label}: 클립보드 준비 시간 초과'
                            time.sleep(0.05)
                        assert b'hwpEditorBoardContent' in html
                        assert native is not remote, f'{label}: 네이티브 클립보드 경로가 다르다'
                        pasted = tmp / f'tutorial-{remote}-{label}.hwpx'
                        hangul('paste-pdf', '', pasted)
                        if remote or not first:
                            result = verify_pdf(pasted.with_suffix('.pdf'))
                        else:
                            # 2026-11-04 낡은 기대값: 11-02 결정(artifacts/format-match-resumed-20261102/PAGE-BREAK-DECISION.md, 사용자 요구
                            # '서식 보존')으로 화면의 자동 쪽 경계는 HTML 대체 경로의 표시 사본에만 강제 쪽 나눔으로 싣고, 같은 PC 의 Hwp Native
                            # 변환 조각(exportClipboardHwpxHancom)은 원본의 강제 나눔만 싣는다(clipboard.rs export_clipboard_hwpx_with_presentation,
                            # tests/clipboard_fidelity.test.mjs). 그래서 Native 범위 붙여넣기의 정답은 '다음 쪽'이 아니라 한/글이 같은 범위를 직접
                            # 복사·붙여넣은 결과다(2026-11-04 실측: 두 범위 모두 제목이 안내 문장과 같은 1쪽 — 우리 Native 와 같음).
                            # 쪽수·안내 쪽·제목 쪽·서식 예시 쪽을 모두 견주고, 내용이 실제로 붙었는지(안내·제목이 있음)도 본다.
                            result = inspect_pdf(pasted.with_suffix('.pdf'))
                            flat = lambda ref: sum(ranges['counts'][:int(ref.split('/')[0][1:])]) + int(ref.split('/')[1][1:])
                            oracle = tmp / f'hangul-{label}.hwpx'
                            hangul('copy-paste-pdf', f"{flat(first['ref'])},{flat(last['ref'])}", oracle, tutorial_source)
                            expected = inspect_pdf(oracle.with_suffix('.pdf'))
                            assert result['beforePage'] and result['headingPage'], f'{label}: 붙인 결과에 안내·제목이 없다 {result}'
                            assert result == expected, f'{label}: Native 쪽 배치가 한/글 자체 복사·붙여넣기와 다르다\n ours={result}\n hangul={expected}'
                        print(f'튜토리얼 {"HTML" if remote else "Native"} {label}: {result}', flush=True)
                assert not errors, errors
                br.close()
        finally:
            srv.stop()
            def restore(cb):
                cb.EmptyClipboard()
                if saved is not None:
                    cb.SetClipboardData(cb.CF_UNICODETEXT, saved)
            clipboard(restore)
    print('ok')


if __name__ == '__main__':
    main()
