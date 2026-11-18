"""튜토리얼·설명서 원본의 모든 쪽에 쪽배경(홀짝 바탕쪽)을 보이게 한다 (2026-11-18 사용자 요청).

    python -X utf8 -I scripts/tutorial_backgrounds.py [--check] [파일.hwpx …]
    (파일을 주지 않으면 튜토리얼 원본 8개: tutorial/*.hwpx 3개 + docs/manuals/*.hwpx 5개)

표준서식 생성기(standard_doc.py·build-tutorial-doc.py)는 앞부분 구역(표지·차례)에 바탕쪽을 떼고(masterPageCnt=0)
표지에 6가지 감추기를 넣는다. 튜토리얼 문서는 사용자 결정으로 1~3쪽도 4쪽처럼 쪽배경을 보인다.
  1) 바탕쪽이 연결되지 않은 구역에 본문 구역과 같은 홀짝 바탕쪽(<hp:masterPage>)을 잇는다.
  2) 모든 쪽 감추기(<hp:pageHiding>)의 바탕쪽 감추기를 끈다(hideMasterPage="0").
     머리말·꼬리말·쪽 번호·테두리·배경 감추기는 그대로 둔다(표지·차례에 쪽 번호를 찍지 않는다).
  3) 그래서 아무것도 감추지 않게 된 감추기 조판 부호(2026-11-17 '1~3쪽 바탕쪽만 감추기'가 넣은 것)는 지운다.
바뀐 구역 XML 만 다시 쓰고 나머지 파트는 바이트 그대로, 압축 방식도 원본 항목 그대로 둔다. 여러 번 돌려도 같다.
--check 는 쓰지 않고 바꿀 파일이 있으면 종료 코드 1. 생성기(build-manuals·build-tutorial-*)는 표준서식 검사 뒤 이것을 부른다
(표준서식 검사기는 앞부분 구역에 바탕쪽이 없어야 한다고 보므로 순서가 중요하다).
"""
import json
import os
import re
import sys
import tempfile
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCES = [os.path.join(ROOT, 'tutorial', n) for n in ('결과보고서.hwpx', 'AI 연결 — 사용자 가이드.hwpx', 'AI 활용 심화 — 연습 보고서.hwpx')]
MANUALS = os.path.join(ROOT, 'docs', 'manuals')
HIDE6 = ('hideHeader', 'hideFooter', 'hideMasterPage', 'hideBorder', 'hideFill', 'hidePageNum')
SEC_PR = re.compile(r'<hp:secPr\b[^>]*>.*?</hp:secPr>', re.S)
MASTER = re.compile(r'<hp:masterPage\b[^>]*/>')
HIDE_CTRL = re.compile(r'<hp:ctrl>(<hp:pageHiding\b[^>]*/>)</hp:ctrl>')
HIDE = re.compile(r'<hp:pageHiding\b[^>]*/>')


def default_files():
    files = [f for f in SOURCES if os.path.exists(f)]
    manifest = os.path.join(MANUALS, 'manifest.json')
    if os.path.exists(manifest):
        for d in json.load(open(manifest, encoding='utf-8'))['documents']:
            files.append(os.path.join(MANUALS, d['file']))
    return files


def section_names(names):
    secs = [n for n in names if re.fullmatch(r'Contents/section\d+\.xml', n)]
    return sorted(secs, key=lambda n: int(re.search(r'\d+', n).group(0)))


def unhide(tag):
    tag = re.sub(r'\bhideMasterPage="1"', 'hideMasterPage="0"', tag)
    return tag


def convert_sections(xmls):
    """xmls: [(이름, 글)] → ([(이름, 새 글)], 보고)"""
    refs = []
    for _, xml in xmls:
        m = SEC_PR.search(xml)
        for ref in MASTER.findall(m.group(0) if m else ''):
            rid = re.search(r'idRef="([^"]*)"', ref).group(1)
            if rid not in [r[0] for r in refs]:
                refs.append((rid, ref))
    report = {'masters': [r[0] for r in refs], 'linked': [], 'unhidden': 0, 'removed': 0}
    out = []
    for name, xml in xmls:
        new = xml
        m = SEC_PR.search(new)
        if refs and m and not MASTER.search(m.group(0)):
            sec = m.group(0)
            body = sec[:-len('</hp:secPr>')] + ''.join(r[1] for r in refs) + '</hp:secPr>'
            body = re.sub(r'(<hp:secPr\b[^>]*\bmasterPageCnt=")\d+"', r'\g<1>%d"' % len(refs), body, count=1)
            if not re.match(r'<hp:secPr\b[^>]*\bmasterPageCnt="', body):
                raise ValueError('%s: secPr 에 masterPageCnt 가 없습니다' % name)
            new = new[:m.start()] + body + new[m.end():]
            report['linked'].append(name)

        def ctrl(mm):
            tag = mm.group(1)
            fixed = unhide(tag)
            if fixed != tag:
                report['unhidden'] += 1
            if all(re.search(r'\b%s="0"' % k, fixed) for k in HIDE6):
                report['removed'] += 1
                return ''
            return '<hp:ctrl>' + fixed + '</hp:ctrl>'
        new = HIDE_CTRL.sub(ctrl, new)

        def lone(mm):   # 다른 개체와 한 ctrl 에 든 감추기(드묾)는 속성만 고친다
            fixed = unhide(mm.group(0))
            if fixed != mm.group(0):
                report['unhidden'] += 1
            return fixed
        new = HIDE.sub(lone, new)
        out.append((name, new))
    return out, report


def convert(path, check=False):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        data = {i.filename: z.read(i.filename) for i in infos}
    names = section_names(data)
    xmls = [(n, data[n].decode('utf-8')) for n in names]
    new, report = convert_sections(xmls)
    changed = {n: x.encode('utf-8') for (n, x), (_, old) in zip(new, xmls) if x != old}
    after = '\n'.join(x for _, x in new)
    left = [h for h in HIDE.findall(after) if 'hideMasterPage="1"' in h]
    unlinked = [n for n, x in new if not (SEC_PR.search(x) and MASTER.search(SEC_PR.search(x).group(0)))]
    try:
        shown = os.path.relpath(path, ROOT)
    except ValueError:   # 다른 드라이브(임시 폴더)
        shown = path
    report.update(file=shown, changedParts=sorted(changed), stillHidden=len(left), unlinkedSections=unlinked)
    if not report['masters']:
        raise ValueError('%s: 바탕쪽이 연결된 구역이 없습니다' % path)
    if left or unlinked:
        raise ValueError('%s: 변환 뒤에도 감춘 바탕쪽 %d개·바탕쪽 없는 구역 %s' % (path, len(left), unlinked))
    if changed and not check:
        fd, tmp = tempfile.mkstemp(prefix='.bg-', suffix='.hwpx', dir=os.path.dirname(path))
        os.close(fd)
        try:
            with zipfile.ZipFile(tmp, 'w') as out:
                for info in infos:
                    out.writestr(info, changed.get(info.filename, data[info.filename]))
            with zipfile.ZipFile(tmp) as test:
                bad = test.testzip()
                if bad:
                    raise ValueError('%s: 다시 묶은 파일이 깨졌습니다(%s)' % (path, bad))
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    return report


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    check = '--check' in argv
    files = [a for a in argv if not a.startswith('--')] or default_files()
    pending = 0
    for f in files:
        r = convert(os.path.abspath(f), check=check)
        pending += bool(r['changedParts'])
        print(json.dumps(r, ensure_ascii=False))
    if check and pending:
        print('바꿀 파일 %d개 — python -X utf8 -I scripts/tutorial_backgrounds.py 로 고칩니다' % pending, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
