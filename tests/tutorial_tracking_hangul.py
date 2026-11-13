"""실제 한/글에서 추적 켬·편집·저장·재열기를 검증한다(자동 skip 없음).

먼저 HWPX_TUTORIAL_AUDIT_OUT을 지정해 tutorial_tracking_integration.test.mjs 실행.
python -I tests/tutorial_tracking_hangul.py <그 출력 폴더> <한글 결과 폴더>
새로 만든 숨은 한/글만 쓰며 사용자의 열린 문서는 건드리지 않는다.
"""
import json
import pathlib
import re
import runpy
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
MARKER = '한글실제추적검증'


def inspect(file):
    with zipfile.ZipFile(file) as z:
        header = z.read('Contents/header.xml').decode('utf-8')
        sections = ''.join(z.read(n).decode('utf-8') for n in z.namelist()
                           if re.fullmatch(r'Contents/section\d+\.xml', n))
    flags = re.search(r'trackchageConfig\b[^>]*\bflags="(\d+)"', header)
    return {'flags': int(flags[1]) if flags else None,
            'insert_marks': len(re.findall(r'<hp:insertBegin\b', sections)),
            'delete_marks': len(re.findall(r'<hp:deleteBegin\b', sections)),
            'native_marker': MARKER in sections}


def child(source, dest):
    result = {'source': str(source), 'cases': []}
    owned_hwp = runpy.run_path(str(ROOT / 'tests/helpers/hangul_com.py'))['owned_hwp']
    with owned_hwp(result) as hwp:
        for file in sorted(source.glob('*.hwpx')):
            # 시작본·전체 반영본만 왕복(실시간 중간 사본은 Node 시험이 검사).
            if not file.stem.endswith(('-start', '-applied')):
                continue
            row = {'file': file.name, 'input': inspect(file)}
            result['cases'].append(row)
            assert row['input']['flags'] & 1, row
            assert hwp.Open(str(file), 'HWPX', 'forceopen:true'), row
            row['open_tracking'] = bool(hwp.IsTrackChange)
            assert row['open_tracking'], row
            row['pages'] = int(hwp.PageCount)
            assert row['pages'] > 0, row
            saved = dest / f'{file.stem}-roundtrip.hwpx'
            assert hwp.SaveAs(str(saved), 'HWPX', ''), row
            row['roundtrip'] = inspect(saved)
            # 추적을 따로 켜는 동작 없이 그대로 삽입한다.
            hwp.HAction.Run('MoveDocEnd')
            params = hwp.HParameterSet.HInsertText
            hwp.HAction.GetDefault('InsertText', params.HSet)
            params.Text = MARKER
            row['native_insert'] = bool(hwp.HAction.Execute('InsertText', params.HSet))
            assert row['native_insert'], row
            edited = dest / f'{file.stem}-native-edit.hwpx'
            assert hwp.SaveAs(str(edited), 'HWPX', ''), row
            row['edited'] = inspect(edited)
            assert row['edited']['native_marker'] and row['edited']['insert_marks'] > row['roundtrip']['insert_marks'], row
            hwp.Clear(1)
            assert hwp.Open(str(edited), 'HWPX', 'forceopen:true'), row
            row['reopen_tracking'] = bool(hwp.IsTrackChange)
            assert row['reopen_tracking'], row
            hwp.Clear(1)
            print(f'PASS {file.name}: IsTrackChange=1 / native insert / save / reopen', flush=True)
            (dest / 'hangul-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    assert len(result['cases']) == 12, f"시작본/반영본 12개 필요: {len(result['cases'])}"
    result['passed'] = True
    (dest / 'hangul-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    source, dest = (pathlib.Path(arg).resolve() for arg in sys.argv[1:3])
    dest.mkdir(parents=True, exist_ok=True)
    if '--child' in sys.argv:
        child(source, dest)
    else:
        completed = subprocess.run([sys.executable, '-I', str(pathlib.Path(__file__).resolve()), str(source), str(dest), '--child'], timeout=180)
        sys.exit(completed.returncode)
