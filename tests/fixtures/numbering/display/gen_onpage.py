# '쪽마다 새로'(footNotePr/endNotePr numbering ON_PAGE) 시험지 — 쪽이 정해진 뒤에 매기는 번호.
# 쓰는 법: python -I gen_onpage.py <out.hwpx> [--begin77] [--break-at F11|W] [--split-newnum]
# 구역 0: ON_PAGE(newNum 5) — 쪽 나누기·새 번호(30)·표 칸 안 각주·자연스러운 쪽 넘김·쪽을 넘어 이어지는 긴 각주
# 구역 1: CONTINUOUS — ON_PAGE 구역 다음에 이어지는 번호
# 구역 2: 2단 + ON_PAGE — 단이 바뀌어도 쪽 안에서는 이어서인가
# 구역 3: 각주·미주 모두 ON_PAGE(로마 소문자·가나다) — 미주에도 쪽마다 새로가 먹는가
import os, re, sys, zipfile

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'vendor', 'rhwp', 'samples', 'hwpx', 'ref', 'ref_empty.hwpx')
OUT = sys.argv[1]
BEGIN77 = '--begin77' in sys.argv

z = zipfile.ZipFile(BASE)
files = {n: z.read(n) for n in z.namelist()}
header = files['Contents/header.xml'].decode('utf-8')
sec0 = files['Contents/section0.xml'].decode('utf-8')
if BEGIN77:
    header = header.replace('<hh:beginNum page="1" footnote="1" endnote="1"', '<hh:beginNum page="1" footnote="77" endnote="77"')
    assert 'footnote="77"' in header

SEC_OPEN = sec0[:sec0.index('<hp:p ')]
first_p = re.search(r'<hp:p .*?</hp:p>', sec0, re.S).group(0)
secpr = re.search(r'<hp:secPr .*?</hp:secPr>', first_p, re.S).group(0)

def t(s): return f'<hp:t>{s}</hp:t>'
def run(inner, cp=0): return f'<hp:run charPrIDRef="{cp}">{inner}</hp:run>'
def p(inner, pp=0, st=0, brk=0, cbrk=0):
    return f'<hp:p id="0" paraPrIDRef="{pp}" styleIDRef="{st}" pageBreak="{brk}" columnBreak="{cbrk}" merged="0">{inner}</hp:p>'
def autonum(kind, num=1, fmt='DIGIT', suffix=''):
    return (f'<hp:ctrl><hp:autoNum num="{num}" numType="{kind}"><hp:autoNumFormat type="{fmt}" userChar="" prefixChar="" '
            f'suffixChar="{suffix}" supscript="0"/></hp:autoNum></hp:ctrl>')
def sublist(paras, va='TOP'):
    return (f'<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="{va}" linkListIDRef="0" linkListNextIDRef="0" '
            f'textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">{paras}</hp:subList>')
LONG = '쪽을 넘어 이어지는 긴 각주 글입니다. ' * 40
def note(kind, tag, body=''):
    el = 'footNote' if kind == 'F' else 'endNote'
    nt = 'FOOTNOTE' if kind == 'F' else 'ENDNOTE'
    inner = p(run(autonum(nt, 1, suffix=')') + t(f' 〔G{tag}〕주석{body}〔.〕'), 3), 10, 14 if kind == 'F' else 15)
    return f'<hp:ctrl><hp:{el} number="1" suffixChar="41" instId="0">{sublist(inner)}</hp:{el}></hp:ctrl>'
def note_para(kind, tag, brk=0, cbrk=0, body=''):
    return p(run(t(f'〔{tag}〕앞') + note(kind, tag, body) + t(f'〔{tag.lower()}〕뒤〔.〕')), brk=brk, cbrk=cbrk)
def fill(n, label, brk=0):
    return [p(run(t(f'{label} 채움 {i + 1}〔.〕')), brk=brk if i == 0 else 0) for i in range(n)]
def newnum(kind, n):
    return p(run(t('〔W〕') + f'<hp:ctrl><hp:newNum num="{n}" numType="{kind}"/></hp:ctrl>' + t('〔w〕〔.〕')))

uid = [1000]
def table_with_notes(tags):
    cells = []
    for c, tag in enumerate(tags):
        uid[0] += 1
        body = p(run(t(f'칸 〔{tag}〕앞') + note('F', tag) + t(f'〔{tag.lower()}〕뒤〔.〕')))
        cells.append(f'<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1">{sublist(body, "CENTER")}'
                     f'<hp:cellAddr colAddr="{c}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="21000" height="2000"/>'
                     f'<hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>')
    uid[0] += 1
    tbl = (f'<hp:tbl id="{uid[0]}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" '
           f'pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="{len(tags)}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">'
           f'<hp:sz width="{21000 * len(tags)}" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/>'
           f'<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" '
           f'vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>'
           f'<hp:inMargin left="510" right="510" top="141" bottom="141"/><hp:tr>{"".join(cells)}</hp:tr></hp:tbl>')
    return p(run(tbl + t('')))

def note_pr(el, fmt, numbering, newnum, suffix=')', place='EACH_COLUMN'):
    line = '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>' if el == 'footNotePr' else \
        '<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>'
    return (f'<hp:{el}><hp:autoNumFormat type="{fmt}" userChar="" prefixChar="" suffixChar="{suffix}" supscript="0"/>'
            f'{line}<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="{numbering}" newNum="{newnum}"/>'
            f'<hp:placement place="{place}" beneathText="0"/></hp:{el}>')

def section(paras, fn, en, cols=1):
    sp = re.sub(r'<hp:footNotePr>.*?</hp:footNotePr>', fn, secpr, flags=re.S)
    sp = re.sub(r'<hp:endNotePr>.*?</hp:endNotePr>', en, sp, flags=re.S)
    ctrls = (f'<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="{cols}" sameSz="1" sameGap="1134"/></hp:ctrl>'
             '<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>')
    first = p(run(sp + ctrls) + run(t('〔S〕구역 시작〔.〕')))
    return SEC_OPEN + first + ''.join(paras) + '</hs:sec>'

EN_DOC = note_pr('endNotePr', 'DIGIT', 'CONTINUOUS', 1, place='END_OF_DOCUMENT')
# 구역 0 — 쪽 1: F01 F02 [새 번호 30] F03 F04 / 쪽 2: F05 표(F06 F07) F08 / 쪽 3~: 채움 뒤 F09~F14 가 자연히 쪽을 넘김
# / 새 쪽: 채움 33줄 뒤 긴 각주 F15(다음 쪽으로 이어짐) · F16
s0 = [note_para('F', 'F01'), note_para('F', 'F02'), newnum('FOOTNOTE', 30), note_para('F', 'F03'), note_para('F', 'F04'),
      note_para('F', 'F05', brk=1), table_with_notes(['F06', 'F07']), note_para('F', 'F08')]
s0 += fill(30, '가', brk=1)
for i in range(9, 15):
    s0 += [note_para('F', f'F{i:02}')] + fill(2, f'F{i:02}')
s0 += fill(33, '나', brk=1) + [note_para('F', 'F15', body=LONG), note_para('F', 'F16')] + fill(3, '다')
# --break-at F11 / --break-at W: 그 태그 문단을 새 쪽에서 시작(편집으로 각주·새 번호가 다음 쪽으로 밀린 상태)
if '--break-at' in sys.argv:
    mark = '〔' + sys.argv[sys.argv.index('--break-at') + 1] + '〕'
    hit = [i for i, x in enumerate(s0) if mark in x]
    assert hit, mark
    s0[hit[0]] = s0[hit[0]].replace('pageBreak="0"', 'pageBreak="1"', 1)
# --split-newnum: 쪽을 넘는 한 문단 안에서 새 번호(50)가 다음 쪽 줄에 놓일 때 — 문단 첫 줄 쪽이 아니라 그 줄의 쪽에서 먹는가
if '--split-newnum' in sys.argv:
    long = '쪽을 넘는 문단의 글입니다. ' * 30
    s0 = [note_para('F', 'F01')] + fill(34, '라') + [
        p(run(t('〔W〕' + long) + '<hp:ctrl><hp:newNum num="50" numType="FOOTNOTE"/></hp:ctrl>' + t('〔w〕〔F02〕앞') + note('F', 'F02')
              + t('〔f02〕뒤〔.〕'))), note_para('F', 'F03')]
s1 = [note_para('F', 'F17'), note_para('F', 'F18')]
s2 = [note_para('F', 'F19'), note_para('F', 'F20'), note_para('F', 'F21', cbrk=1), note_para('F', 'F22'),
      note_para('F', 'F23', brk=1), note_para('F', 'F24', cbrk=1)]
s3 = [note_para('F', 'F25'), note_para('E', 'E01'), note_para('E', 'E02'), note_para('F', 'F26', brk=1), note_para('E', 'E03'),
      note_para('E', 'E04', brk=1)]

secs = [
    section(s0, note_pr('footNotePr', 'DIGIT', 'ON_PAGE', 5), EN_DOC),
    section(s1, note_pr('footNotePr', 'DIGIT', 'CONTINUOUS', 1), EN_DOC),
    section(s2, note_pr('footNotePr', 'CIRCLED_DIGIT', 'ON_PAGE', 1, suffix=''), EN_DOC, cols=2),
    section(s3, note_pr('footNotePr', 'ROMAN_SMALL', 'ON_PAGE', 1),
            note_pr('endNotePr', 'HANGUL_SYLLABLE', 'ON_PAGE', 1, place='END_OF_DOCUMENT')),
]
# --chain: 쪽마다 새로 구역과 이어서·구역마다 새로 구역이 번갈아 올 때 — 뒤 구역이 어디서 이어지는가
if '--chain' in sys.argv:
    fp = lambda numbering, newnum=1: note_pr('footNotePr', 'DIGIT', numbering, newnum)
    chain = [
        ('ON_PAGE', [note_para('F', 'F01')]),
        ('CONTINUOUS', [note_para('F', 'F02'), note_para('F', 'F03'), note_para('F', 'F04', brk=1)]),
        ('ON_PAGE', [note_para('F', 'F05'), note_para('F', 'F06'), note_para('F', 'F07')]),
        ('CONTINUOUS', [note_para('F', 'F08')]),
        ('ON_PAGE', [newnum('FOOTNOTE', 40), note_para('F', 'F09'), note_para('F', 'F10')]),
        ('CONTINUOUS', [note_para('F', 'F11')]),
        ('CONTINUOUS', [note_para('F', 'F12')]),
        ('ON_SECTION', [note_para('F', 'F13')]),
        ('ON_PAGE', [p(run(t('〔N〕각주 없는 쪽마다 새로 구역〔.〕')))]),
        ('CONTINUOUS', [note_para('F', 'F14')]),
        ('ON_PAGE', [note_para('F', 'F15'), note_para('F', 'F16', brk=1), note_para('F', 'F17')]),
        ('CONTINUOUS', [note_para('F', 'F18')]),
    ]
    if '--chain2' in sys.argv:
        chain = [
            ('ON_PAGE', [note_para('F', 'F01'), p(run(t('〔N〕각주 없는 둘째 쪽〔.〕')), brk=1)]),
            ('CONTINUOUS', [note_para('F', 'F02')]),
            ('ON_PAGE', [newnum('FOOTNOTE', 40)]),
            ('CONTINUOUS', [note_para('F', 'F03')]),
            ('ON_PAGE', [note_para('F', f'F{i:02}') for i in range(4, 9)]),
            ('CONTINUOUS', [note_para('F', 'F09')]),
            ('ON_PAGE', [note_para('F', 'F10'), newnum('FOOTNOTE', 40), note_para('F', 'F11')]),
            ('CONTINUOUS', [note_para('F', 'F12')]),
            ('ON_PAGE', [newnum('FOOTNOTE', 40), note_para('F', 'F13')]),
            ('ON_SECTION', [note_para('F', 'F14')]),
            ('CONTINUOUS', [newnum('FOOTNOTE', 60), note_para('F', 'F15')]),
            ('ON_PAGE', [note_para('F', 'F16')]),
            ('CONTINUOUS', [newnum('FOOTNOTE', 60), note_para('F', 'F17')]),
        ]
    secs = [section(paras, fp(numbering, 7), EN_DOC) for numbering, paras in chain]
header = header.replace('secCnt="1"', f'secCnt="{len(secs)}"')
hpf = files['Contents/content.hpf'].decode('utf-8')
items = ''.join(f'<opf:item id="section{i}" href="Contents/section{i}.xml" media-type="application/xml"/>' for i in range(1, len(secs)))
refs = ''.join(f'<opf:itemref idref="section{i}"/>' for i in range(1, len(secs)))
hpf = hpf.replace('<opf:item id="settings"', items + '<opf:item id="settings"').replace('</opf:spine>', refs + '</opf:spine>')

files['Contents/header.xml'] = header.encode('utf-8')
files['Contents/content.hpf'] = hpf.encode('utf-8')
for i, s in enumerate(secs):
    files[f'Contents/section{i}.xml'] = s.encode('utf-8')
order = ['mimetype'] + [n for n in files if n != 'mimetype']
with zipfile.ZipFile(OUT, 'w') as o:
    for n in order:
        o.writestr(n, files[n], zipfile.ZIP_STORED if n == 'mimetype' else zipfile.ZIP_DEFLATED)
print('wrote', OUT)
