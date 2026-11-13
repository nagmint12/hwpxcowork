# 화면 시험(한컴 표 단축키 — 2026-10-29): 실제 Chromium 에서 한/글과 같은 표 키가 듣는가.
#   1) 표 칸 Ctrl+Enter → 현재 줄 아래 줄 추가, 캐럿은 새 줄의 같은 칸, 본문 문단·쪽 나누기 그대로, 한글로 저장에 줄 수 +1,
#      Ctrl+Z 한 번에 원상(한글로 저장에도)
#   2) F5 셀 블록 → P → '표/셀 속성' 창, 칸에 'p' 가 들어가지 않음. 한글 입력기 흉내(key 'Process', code 'KeyP', 229)도
#   3) 마우스로 끈 셀 블록 → P → '표/셀 속성' 창
#   4) 표 선택(칸에서 Esc) → P → '표/셀 속성'(표 모드 — 테두리 탭이 있음)
#   5) Ctrl+Backspace → 캐럿 줄 지우기(캐럿은 그 자리 줄 첫 칸), 한글로 저장에 줄 수 -1, Ctrl+Z 원상
#   6) Alt+Insert → '줄/칸 추가하기' 창 / 표 밖 Alt+Insert 는 삽입·수정 상태를 바꾸지 않음
#   7) 셀 블록 Enter → 블록만 풀림(문서 그대로)
#   8) Ctrl+Y → 캐럿 줄 지우기, Ctrl+Z 원상
#   9) 셀 블록 Ctrl+B → 블록 유지, 블록 두 칸이 함께 진하게
#   python -I tests/ui_table_keys.py   → 스크린숏 tests/out/table_keys_*.png
# 서버는 포트 8779(UI_TABLE_KEYS_PORT)에 임시 data 폴더 + 임시 config(ui_codes.py 받침). 진짜 config.json·data/ 는 건드리지 않는다.
# 편집기 빌드(studio/dist)가 있어야 한다: npm run build:studio
import io, json, os, re, shutil, sys, tempfile, time, traceback, urllib.parse, zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ['UI_CODES_PORT'] = os.environ.get('UI_TABLE_KEYS_PORT', '8779')
import ui_codes as U  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
OUT = U.OUT
RESULTS = []
TABLE = 's0/p5'   # 첫 표(캡션 n0, 칸 n1…)


def check(cond, msg):
    RESULTS.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg, flush=True)
    return bool(cond)


def studio(pg):
    return next(f for f in pg.frames if '/studio/' in f.url)


def stats(pg):
    return U.cw(pg, 'cw.debug.stats()')


def editor(pg):
    return stats(pg).get('editor') or {}


def section_xml(did):
    b = U.rest(f'/api/docs/{did}/file?kind=export')
    return zipfile.ZipFile(io.BytesIO(b)).read('Contents/section0.xml').decode('utf-8')


def first_table(xml):
    """첫 표의 줄 수와 칸 목록 [(row, col, text)] — 칸 차례 = 편집기 cellIndex 차례"""
    m = re.search(r'<hp:tbl\b[^>]*>', xml)
    rows = int(re.search(r'rowCnt="(\d+)"', m.group(0)).group(1))
    end = xml.find('</hp:tbl>', m.start())
    body = xml[m.start():end]
    cells = []
    for tc in re.finditer(r'<hp:tc\b[\s\S]*?</hp:tc>', body):
        t = tc.group(0)
        a = re.search(r'<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"', t)
        text = ''.join(re.findall(r'<hp:t>([^<]*)</hp:t>', t))
        cells.append((int(a.group(2)), int(a.group(1)), text))
    return rows, cells


def body_para_count(xml):
    root = ET.fromstring(xml.encode('utf-8'))
    return sum(1 for c in root if c.tag.endswith('}p'))


def page_breaks(xml):
    return len(re.findall(r'pageBreak="1"', xml))


def saved(pg):
    U.wait_until(lambda: not U.store(pg, 's.draft.dirty') and not U.store(pg, 's.draft.saving'), timeout=25, msg='실시간 저장')


def frame_offset(pg):
    return pg.evaluate(f"() => {{ const r = {U.FRAME_JS}.getBoundingClientRect(); return {{ x: r.left, y: r.top }}; }}")


def cell_point(pg, ref):
    p = U.wait_until(lambda: U.cw(pg, 'cw.debug.pointFor(arg[0], arg[1])', [ref, 0]), timeout=10, msg=f'pointFor({ref})')
    o = frame_offset(pg)
    return p['x'] + o['x'] + 4, p['y'] + o['y'] + 4


def dialog(pg, title):
    return studio(pg).locator('.dialog-wrap').filter(has=studio(pg).locator('.dialog-title', has_text=title))


def close_dialog(pg, title):
    d = dialog(pg, title)
    pg.keyboard.press('Escape')
    try:
        d.first.wait_for(state='hidden', timeout=2000)
    except Exception:  # noqa: BLE001
        btn = d.first.locator('button', has_text='취소')
        if btn.count():
            btn.first.click()
        d.first.wait_for(state='hidden', timeout=3000)
    U.settle(pg)


def cell_ref(cells, row, col):
    for i, (r, c, _t) in enumerate(cells):
        if r == row and c == col:
            return i
    return None


def run_case(name, fn):
    print(f'\n── {name}', flush=True)
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        check(False, f'{name}: 예외 {e}')


def main():
    tmp = tempfile.mkdtemp(prefix='hwpx_table_keys_')
    srv = log = None
    errors = []
    try:
        srv, log = U.start_server(tmp)
        with open(U.FIX, 'rb') as f:
            did = U.rest('/api/docs', 'POST', f.read(), {'x-file-name': urllib.parse.quote('표단축키.hwpx'), 'Content-Type': 'application/octet-stream'}, raw=True)['id']
        with sync_playwright() as p:
            br = p.chromium.launch(executable_path=U.CHROME, headless=True)
            ctx = br.new_context(viewport={'width': 1440, 'height': 960}, device_scale_factor=1)
            ctx.add_init_script(f"try {{ localStorage.setItem('hwpx.token', {json.dumps(U.A['token'])}); }} catch (e) {{}}")
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
            pg.goto(f'{U.BASE}/#/doc/{did}')
            pg.wait_for_function('(id) => !!(window.__doc && window.__doc.id === id && window.__doc.editor && (window.__doc.editor.ready || window.__doc.editor.error))', arg=did, timeout=120000)
            pg.wait_for_function(f'() => !!{U.FRAME_JS}?.contentWindow?.rhwpCowork', timeout=30000)
            U.cw(pg, 'cw.ready'); U.settle(pg)
            check(U.store(pg, 's.editor.mode') == 'live', '실시간 문서')
            cdp = ctx.new_cdp_session(pg)

            xml0 = section_xml(did)
            rows0, cells0 = first_table(xml0)
            body0, breaks0 = body_para_count(xml0), page_breaks(xml0)
            print(f'    첫 표 {rows0}줄 · 칸 {len(cells0)} · 본문 문단 {body0} · 쪽 나누기 {breaks0}')

            def case_ctrl_enter():
                U.click_at(pg, f'{TABLE}/n1', 0)
                e0 = editor(pg); st0 = stats(pg)
                c0 = e0.get('caret') or {}
                check(e0.get('inTable') and c0.get('cellIndex') == 0, f'캐럿 = 첫 표 첫 칸 {c0}')
                r0, col0 = cells0[c0['cellIndex']][0], cells0[c0['cellIndex']][1]
                pg.keyboard.press('Control+Enter'); U.settle(pg)
                e1 = editor(pg); st1 = stats(pg)
                c1 = e1.get('caret') or {}
                pg.screenshot(path=f'{OUT}/table_keys_1_ctrl_enter.png')
                check(e1.get('inTable') and c1.get('cellIndex') != c0.get('cellIndex'), f'캐럿이 새 칸으로 감 {c1}')
                check(st1['align']['curPara'] == st0['align']['curPara'], f"편집기 본문 문단 수 그대로 {st0['align']['curPara']} → {st1['align']['curPara']}")
                check(st1['pages'] == st0['pages'], f"쪽 수 그대로 {st0['pages']} → {st1['pages']}")
                saved(pg)
                xml1 = U.wait_until(lambda: (lambda x: x if first_table(x)[0] == rows0 + 1 else None)(section_xml(did)), timeout=20, msg='줄 추가가 한글로 저장에')
                rows1, cells1 = first_table(xml1)
                check(rows1 == rows0 + 1, f'한글로 저장의 줄 수 {rows0} → {rows1}')
                check(body_para_count(xml1) == body0 and page_breaks(xml1) == breaks0,
                      f'한글로 저장의 본문 문단 {body0}→{body_para_count(xml1)} · 쪽 나누기 {breaks0}→{page_breaks(xml1)} 그대로')
                nr, nc, ntext = cells1[c1['cellIndex']]
                check((nr, nc) == (r0 + 1, col0), f'캐럿 칸 = 새 줄({r0 + 1})의 같은 칸({col0}) — 실제 ({nr},{nc})')
                new_row = [t for (r, c, t) in cells1 if r == r0 + 1]
                check(new_row and all(t == '' for t in new_row), f'끼운 줄은 빈 칸 {new_row[:4]}')
                old_next = [t for (r, c, t) in cells0 if r == r0 + 1]
                moved = [t for (r, c, t) in cells1 if r == r0 + 2]
                check(old_next[:3] == moved[:3], f'원래 다음 줄이 한 줄 내려감 {old_next[:3]} == {moved[:3]}')
                pg.keyboard.press('Control+z'); U.settle(pg)
                saved(pg)
                U.wait_until(lambda: first_table(section_xml(did))[0] == rows0, timeout=20, msg='되돌린 줄 수가 한글로 저장에')
                check(stats(pg)['pages'] == st0['pages'], 'Ctrl+Z 한 번에 원상(한글로 저장 줄 수도 원래대로)')

            def case_f5_p():
                U.click_at(pg, f'{TABLE}/n2', 0)
                text0 = U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n2')
                pg.keyboard.press('F5'); U.settle(pg)
                check(editor(pg).get('cellSelection'), 'F5 → 셀 블록')
                pg.keyboard.press('p')
                d = dialog(pg, '표/셀 속성')
                d.first.wait_for(state='visible', timeout=5000)
                check(True, "F5 블록 P → '표/셀 속성' 창")
                pg.screenshot(path=f'{OUT}/table_keys_2_f5_p.png')
                close_dialog(pg, '표/셀 속성')
                check(U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n2') == text0, f"칸에 'p' 가 들어가지 않음 {text0!r}")
                # 한글 입력기 흉내 — Windows Chrome 은 한글 상태에서 key 'Process', keyCode 229 를 낸다
                if not editor(pg).get('cellSelection'):
                    U.click_at(pg, f'{TABLE}/n2', 0)
                    pg.keyboard.press('F5'); U.settle(pg)
                cdp.send('Input.dispatchKeyEvent', {'type': 'rawKeyDown', 'key': 'Process', 'code': 'KeyP', 'windowsVirtualKeyCode': 229, 'nativeVirtualKeyCode': 229})
                cdp.send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Process', 'code': 'KeyP', 'windowsVirtualKeyCode': 229, 'nativeVirtualKeyCode': 229})
                d.first.wait_for(state='visible', timeout=5000)
                check(True, "한글 입력기(Process/KeyP/229) P → '표/셀 속성' 창")
                close_dialog(pg, '표/셀 속성')
                check(U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n2') == text0, '입력기 흉내 뒤에도 칸 글 그대로')
                pg.keyboard.press('Escape'); U.settle(pg)

            def case_drag_p():
                U.click_at(pg, f'{TABLE}/n4', 0)
                texts = [U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n{i}') for i in (3, 4)]
                x0, y0 = cell_point(pg, f'{TABLE}/n3')
                x1, y1 = cell_point(pg, f'{TABLE}/n4')
                pg.mouse.move(x0, y0); pg.mouse.down()
                for k in range(1, 9):
                    pg.mouse.move(x0 + (x1 - x0) * k / 8, y0 + (y1 - y0) * k / 8)
                pg.mouse.up(); U.settle(pg)
                check(editor(pg).get('cellSelection'), '마우스 끌기 → 셀 블록(F5 와 같은 상태)')
                pg.keyboard.press('p')
                d = dialog(pg, '표/셀 속성')
                d.first.wait_for(state='visible', timeout=5000)
                check(True, "끌기 블록 P → '표/셀 속성' 창")
                pg.screenshot(path=f'{OUT}/table_keys_3_drag_p.png')
                close_dialog(pg, '표/셀 속성')
                check([U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n{i}') for i in (3, 4)] == texts, f'칸 글 그대로 {texts}')
                pg.keyboard.press('Escape'); U.settle(pg)

            def case_table_object_p():
                U.click_at(pg, f'{TABLE}/n1', 0)
                text0 = U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n1')
                pg.keyboard.press('Escape'); U.settle(pg)
                check(editor(pg).get('tableObject'), '칸에서 Esc → 표 선택')
                pg.keyboard.press('p')
                d = dialog(pg, '표/셀 속성')
                d.first.wait_for(state='visible', timeout=5000)
                tabs = d.first.locator('.dialog-tab').all_inner_texts()
                check(any('테두리' in t for t in tabs), f"표 선택 P → '표/셀 속성'(표 모드 탭 {tabs})")
                pg.screenshot(path=f'{OUT}/table_keys_4_object_p.png')
                close_dialog(pg, '표/셀 속성')
                check(U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n1') == text0, f"칸에 'p' 가 들어가지 않음 {text0!r}")
                pg.keyboard.press('Escape'); U.settle(pg)

            def case_ctrl_backspace():
                xml = section_xml(did)
                rows, cells = first_table(xml)
                idx = cell_ref(cells, 1, 0)
                check(idx is not None, f'둘째 줄 첫 칸 = 칸 {idx}')
                # 기준 ref(n…)는 칸 문단 차례라 칸 번호와 꼭 같지 않다 — 눌러 보고 캐럿 칸 번호로 고른다
                ref = None
                for k in range(1, len(cells) * 3):
                    cand = f'{TABLE}/n{k}'
                    try:
                        if U.cw(pg, 'cw.debug.text(arg)', cand) != cells[idx][2]:
                            continue
                    except Exception:  # noqa: BLE001
                        break
                    U.click_at(pg, cand, 0)
                    if (editor(pg).get('caret') or {}).get('cellIndex') == idx:
                        ref = cand
                        break
                check(ref is not None, f'둘째 줄 첫 칸에 캐럿({ref}, 글 {cells[idx][2]!r})')
                row0 = [t for (r, c, t) in cells if r == 0]
                row1 = [t for (r, c, t) in cells if r == 1]
                pg.keyboard.press('Control+Backspace'); U.settle(pg)
                c1 = editor(pg).get('caret') or {}
                pg.screenshot(path=f'{OUT}/table_keys_5_ctrl_backspace.png')
                saved(pg)
                xml1 = U.wait_until(lambda: (lambda x: x if first_table(x)[0] == rows - 1 else None)(section_xml(did)), timeout=20, msg='줄 지우기가 한글로 저장에')
                rows1, cells1 = first_table(xml1)
                check(rows1 == rows - 1, f'한글로 저장의 줄 수 {rows} → {rows1}')
                after = [t for (r, c, t) in cells1 if r == 1]
                old2 = [t for (r, c, t) in cells if r == 2]
                first = [t for (r, c, t) in cells1 if r == 0]
                check(first == row0 and after[:3] == old2[:3], f'첫 줄은 그대로, 둘째 줄이 지워지고 셋째 줄이 올라옴 {after[:3]}')
                check(c1.get('cellIndex') is not None and cells1[c1['cellIndex']][:2] == (1, 0), f'캐럿 = 그 자리 줄 첫 칸 {c1}')
                pg.keyboard.press('Control+z'); U.settle(pg)
                saved(pg)
                U.wait_until(lambda: first_table(section_xml(did))[0] == rows, timeout=20, msg='되돌린 줄이 한글로 저장에')
                check(True, 'Ctrl+Z 한 번에 줄이 돌아옴(한글로 저장도)')

            def case_alt_insert():
                U.click_at(pg, f'{TABLE}/n1', 0)
                pg.keyboard.press('Alt+Insert')
                d = dialog(pg, '줄/칸 추가하기')
                d.first.wait_for(state='visible', timeout=5000)
                check(True, "표 칸 Alt+Insert → '줄/칸 추가하기' 창")
                pg.screenshot(path=f'{OUT}/table_keys_6_alt_insert.png')
                close_dialog(pg, '줄/칸 추가하기')
                U.click_at(pg, 's0/p3', 0)
                mode0 = studio(pg).locator('#sb-mode').inner_text()
                pg.keyboard.press('Alt+Insert'); U.settle(pg)
                check(studio(pg).locator('#sb-mode').inner_text() == mode0, f'표 밖 Alt+Insert 는 삽입/수정 상태를 바꾸지 않음({mode0})')

            def case_block_enter():
                U.click_at(pg, f'{TABLE}/n2', 0)
                seq0 = stats(pg)['changeSeq']
                text0 = U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n2')
                pg.keyboard.press('F5'); U.settle(pg)
                check(editor(pg).get('cellSelection'), 'F5 → 셀 블록')
                pg.keyboard.press('Enter'); U.settle(pg)
                e = editor(pg)
                check(not e.get('cellSelection') and e.get('inTable'), f'Enter → 블록이 풀리고 그 칸에 캐럿 {e.get("caret")}')
                check(stats(pg)['changeSeq'] == seq0 and U.cw(pg, 'cw.debug.text(arg)', f'{TABLE}/n2') == text0,
                      '문서 그대로(칸 문단을 나누지 않음)')

            def case_ctrl_y():
                ref = 's0/p6'
                st0 = stats(pg)
                t0 = U.cw(pg, 'cw.debug.text(arg)', ref)
                t_next = U.cw(pg, 'cw.debug.text(arg)', 's0/p7')
                U.click_at(pg, ref, 0)
                pg.keyboard.press('Control+y'); U.settle(pg)
                st1 = stats(pg)
                t1 = U.cw(pg, 'cw.debug.text(arg)', ref)
                pg.screenshot(path=f'{OUT}/table_keys_8_ctrl_y.png')
                one_line = st1['align']['curPara'] == st0['align']['curPara'] - 1 and t1 == t_next
                first_line = st1['align']['curPara'] == st0['align']['curPara'] and len(t1) < len(t0) and t0.endswith(t1)
                check(one_line or first_line,
                      f"Ctrl+Y → 캐럿 줄이 지워짐(문단 {st0['align']['curPara']}→{st1['align']['curPara']}, 글 {len(t0)}→{len(t1)}자)")
                check(not st1.get('canRedo') or st1.get('canUndo'), 'Ctrl+Y 는 다시 실행이 아니다(편집으로 기록)')
                pg.keyboard.press('Control+z'); U.settle(pg)
                check(U.cw(pg, 'cw.debug.text(arg)', ref) == t0 and stats(pg)['align']['curPara'] == st0['align']['curPara'],
                      'Ctrl+Z 한 번에 원상')

            def case_block_bold():
                refs = [f'{TABLE}/n1', f'{TABLE}/n2']
                b0 = [bool((U.cw(pg, 'cw.debug.charProps(arg[0], arg[1])', [r, 0]) or {}).get('bold')) for r in refs]
                U.click_at(pg, refs[0], 0)
                pg.keyboard.press('F5'); pg.keyboard.press('F5'); pg.keyboard.press('ArrowRight'); U.settle(pg)
                check(editor(pg).get('cellSelection'), 'F5 F5 → 방향키로 두 칸 블록')
                pg.keyboard.press('Control+b'); U.settle(pg)
                b1 = [bool((U.cw(pg, 'cw.debug.charProps(arg[0], arg[1])', [r, 0]) or {}).get('bold')) for r in refs]
                check(editor(pg).get('cellSelection'), 'Ctrl+B 뒤에도 셀 블록 유지')
                check(b1[0] == b1[1] and b1 != b0, f'블록 두 칸이 함께 진하게 바뀜 {b0} → {b1}')
                pg.keyboard.press('Control+z'); U.settle(pg)
                pg.keyboard.press('Escape'); U.settle(pg)
                b2 = [bool((U.cw(pg, 'cw.debug.charProps(arg[0], arg[1])', [r, 0]) or {}).get('bold')) for r in refs]
                check(b2 == b0, f'Ctrl+Z 로 원상 {b2}')

            run_case('[1] 표 칸 Ctrl+Enter = 줄 추가하기', case_ctrl_enter)
            run_case('[2] F5 셀 블록 P', case_f5_p)
            run_case('[3] 마우스 끌기 셀 블록 P', case_drag_p)
            run_case('[4] 표 선택 P', case_table_object_p)
            run_case('[5] Ctrl+Backspace = 줄 지우기', case_ctrl_backspace)
            run_case('[6] Alt+Insert', case_alt_insert)
            run_case('[7] 셀 블록 Enter', case_block_enter)
            run_case('[8] Ctrl+Y = 한 줄 지우기', case_ctrl_y)
            run_case('[9] 셀 블록 Ctrl+B 는 블록을 놓지 않고 블록 칸 전부에', case_block_bold)

            bad = [e for e in errors if 'favicon' not in e and 'status of 409' not in e]
            check(not bad, f'브라우저 오류 없음 {bad[:3]}')
            br.close()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        RESULTS.append((False, '예외'))
    finally:
        if srv:
            srv.terminate()
            try:
                srv.wait(10)
            except Exception:  # noqa: BLE001
                srv.kill()
        if log:
            log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    fails = [m for c, m in RESULTS if not c]
    print(f'\n{len(RESULTS) - len(fails)}/{len(RESULTS)} 통과' + (f' — 실패: {fails}' if fails else ''))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
