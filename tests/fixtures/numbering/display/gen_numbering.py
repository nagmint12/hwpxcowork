# 번호 체계 시험지 — 개요·문단 번호·글머리표·각주·미주·쪽 번호(쪽 번호 위치·autoNum PAGE/TOTAL_PAGE)·새 번호.
# ref_empty.hwpx(한/글 빈 문서)를 바탕으로 구역 4개를 만든다. 문단마다 〔태그〕로 표시해 번호 글자를 찾는다.
import os, re, sys, zipfile

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'vendor', 'rhwp', 'samples', 'hwpx', 'ref', 'ref_empty.hwpx')
OUT = sys.argv[1]
BEGIN77 = '--begin77' in sys.argv  # 문서 시작 번호: 쪽 5, 각주 77, 미주 77

z = zipfile.ZipFile(BASE)
files = {n: z.read(n) for n in z.namelist()}
header = files['Contents/header.xml'].decode('utf-8')
sec0 = files['Contents/section0.xml'].decode('utf-8')

# ── header: 문단 번호(numbering 2)·글머리표(bullet 1)·그 문단 모양 ─────────────
def para_head(level, fmt, text, start=1):
    body = f'>{text}</hh:paraHead>' if text else '/>'
    return (f'<hh:paraHead start="{start}" level="{level}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" '
            f'textOffsetType="PERCENT" textOffset="50" numFormat="{fmt}" charPrIDRef="4294967295" checkable="0"{body}')

levels = [('ROMAN_CAPITAL', '^1.', 3), ('LATIN_CAPITAL', '^2)', 1), ('DIGIT', '^1.^2.^3', 1), ('CIRCLED_LATIN_SMALL', '^4', 1),
          ('HANGUL_JAMO', '^5.', 1), ('IDEOGRAPH', '^6.', 1), ('ROMAN_SMALL', '(^7)', 1)]
num2 = '<hh:numbering id="2" start="0">' + ''.join(para_head(i + 1, f, t, s) for i, (f, t, s) in enumerate(levels)) \
    + ''.join(para_head(i, 'DIGIT', '') for i in (8, 9, 10)) + '</hh:numbering>'
levels3 = [('CIRCLED_HANGUL_SYLLABLE', '^1'), ('CIRCLED_HANGUL_JAMO', '^2'), ('CIRCLED_IDEOGRAPH', '^3'), ('CIRCLED_LATIN_CAPITAL', '^4'),
           ('HANGUL_PHONETIC', '^5.'), ('CIRCLED_DIGIT', '^6'), ('HANGUL_SYLLABLE', '^7.')]
num2 += '<hh:numbering id="3" start="0">' + ''.join(para_head(i + 1, f, t) for i, (f, t) in enumerate(levels3)) \
    + ''.join(para_head(i, 'DIGIT', '') for i in (8, 9, 10)) + '</hh:numbering>'
header = header.replace('<hh:numberings itemCnt="1">', '<hh:numberings itemCnt="3">')
header = header.replace('</hh:numberings>', num2 + '</hh:numberings><hh:bullets itemCnt="1"><hh:bullet id="1" char="■" useImage="0">'
                        '<hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" '
                        'textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/></hh:bullet></hh:bullets>')
pp0 = re.search(r'<hh:paraPr id="0".*?</hh:paraPr>', header, re.S).group(0)
extra = []
for lv in range(7):  # 20..26 = 문단 번호 수준 1..7
    extra.append(pp0.replace('id="0"', f'id="{20 + lv}"', 1).replace('<hh:heading type="NONE" idRef="0" level="0"/>',
                                                                    f'<hh:heading type="NUMBER" idRef="2" level="{lv}"/>'))
for lv in range(7):  # 28..34 = 문단 번호(numbering 3) 수준 1..7
    extra.append(pp0.replace('id="0"', f'id="{28 + lv}"', 1).replace('<hh:heading type="NONE" idRef="0" level="0"/>',
                                                                    f'<hh:heading type="NUMBER" idRef="3" level="{lv}"/>'))
extra.append(pp0.replace('id="0"', 'id="27"', 1).replace('<hh:heading type="NONE" idRef="0" level="0"/>',
                                                       '<hh:heading type="BULLET" idRef="1" level="0"/>'))
header = re.sub(r'<hh:paraProperties itemCnt="20">', '<hh:paraProperties itemCnt="35">', header)
# 한/글은 paraPrIDRef 를 id 가 아니라 목록 자리로 찾는다 — id 차례대로 둔다
extra.sort(key=lambda x: int(re.search(r'id="(\d+)"', x).group(1)))
header = header.replace('</hh:paraProperties>', ''.join(extra) + '</hh:paraProperties>')
assert header.count('<hh:paraPr id=') == 35
if BEGIN77:
    header = header.replace('<hh:beginNum page="1" footnote="1" endnote="1"', '<hh:beginNum page="5" footnote="77" endnote="77"')
    assert 'footnote="77"' in header

# ── 구역 ────────────────────────────────────────────────────────────────────
SEC_OPEN = sec0[:sec0.index('<hp:p ')]
first_p = re.search(r'<hp:p .*?</hp:p>', sec0, re.S).group(0)
secpr = re.search(r'<hp:secPr .*?</hp:secPr>', first_p, re.S).group(0)
colpr = '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>'

def t(s): return f'<hp:t>{s}</hp:t>'
def run(inner, cp=0): return f'<hp:run charPrIDRef="{cp}">{inner}</hp:run>'
def p(inner, pp=0, st=0, brk=0): return f'<hp:p id="0" paraPrIDRef="{pp}" styleIDRef="{st}" pageBreak="{brk}" columnBreak="0" merged="0">{inner}</hp:p>'
def tagged(tag, pp=0, st=0, brk=0): return p(run(t(f'〔{tag}〕본문〔.〕')), pp, st, brk)
def autonum(kind, num=1, fmt='DIGIT', suffix=''):
    return (f'<hp:ctrl><hp:autoNum num="{num}" numType="{kind}"><hp:autoNumFormat type="{fmt}" userChar="" prefixChar="" '
            f'suffixChar="{suffix}" supscript="0"/></hp:autoNum></hp:ctrl>')
def sublist(paras, va='TOP', w=0, h=0):
    return (f'<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="{va}" linkListIDRef="0" linkListNextIDRef="0" '
            f'textWidth="{w}" textHeight="{h}" hasTextRef="0" hasNumRef="0">{paras}</hp:subList>')
def note(kind, tag, number_attr):
    el = 'footNote' if kind == 'F' else 'endNote'
    nt = 'FOOTNOTE' if kind == 'F' else 'ENDNOTE'
    attr = '' if number_attr is None else f' number="{number_attr}"'
    inner = p(run(autonum(nt, number_attr or 1, suffix=')') + t(f' 〔G{tag}〕주석〔.〕'), 3), 10, 14 if kind == 'F' else 15)
    return f'<hp:ctrl><hp:{el}{attr} suffixChar="41" instId="0">{sublist(inner)}</hp:{el}></hp:ctrl>'
def note_para(kind, tag, number_attr, brk=0):
    return p(run(t(f'〔{tag}〕앞') + note(kind, tag, number_attr) + t(f'〔{tag.lower()}〕뒤〔.〕')), brk=brk)
def header_ctrl():
    inner = p(run(t('〔H〕') + autonum('PAGE') + t('/') + autonum('TOTAL_PAGE') + t('〔h〕'), 2), 9, 13)
    return f'<hp:ctrl><hp:header id="1" applyPageType="BOTH">{sublist(inner, "TOP", 42520, 4252)}</hp:header></hp:ctrl>'
def note_pr(el, fmt, numbering, newnum, user='', prefix='', suffix=')', place='EACH_COLUMN'):
    line = '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>' if el == 'footNotePr' else \
        '<hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>'
    return (f'<hp:{el}><hp:autoNumFormat type="{fmt}" userChar="{user}" prefixChar="{prefix}" suffixChar="{suffix}" supscript="0"/>'
            f'{line}<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="{numbering}" newNum="{newnum}"/>'
            f'<hp:placement place="{place}" beneathText="0"/></hp:{el}>')

def section(paras, fn, en, page_start=0, pagenum=('BOTTOM_CENTER', 'DIGIT'), with_header=False):
    sp = re.sub(r'<hp:footNotePr>.*?</hp:footNotePr>', fn, secpr, flags=re.S)
    sp = re.sub(r'<hp:endNotePr>.*?</hp:endNotePr>', en, sp, flags=re.S)
    sp = sp.replace('page="0"', f'page="{page_start}"', 1)
    ctrls = colpr + (header_ctrl() if with_header else '') + \
        f'<hp:ctrl><hp:pageNum pos="{pagenum[0]}" formatType="{pagenum[1]}" sideChar="-"/></hp:ctrl>'
    first = p(run(sp + ctrls) + run(t('〔S〕구역 시작〔.〕')))
    return SEC_OPEN + first + ''.join(paras) + '</hs:sec>'

outline = lambda tag, lv, brk=0: tagged(tag, lv + 1, 1 + lv, brk)   # 개요 lv(1..7) = paraPr·style lv+1
number = lambda tag, lv: tagged(tag, 19 + lv, 0)                 # 문단 번호 수준 lv(1..7) = paraPr 19+lv
bullet = lambda tag: tagged(tag, 27, 0)
number3 = lambda tag, lv: tagged(tag, 27 + lv, 0)               # numbering 3 수준 lv = paraPr 27+lv
newnum = lambda kind, n: p(run(t('〔W〕') + f'<hp:ctrl><hp:newNum num="{n}" numType="{kind}"/></hp:ctrl>' + t('〔w〕〔.〕')))

s0 = [outline(f'O{i+1:02}', lv) for i, lv in enumerate([1, 2, 2, 3, 4, 5, 6, 7, 1, 2, 3])]
s0 += [number(f'N{i+1:02}', lv) for i, lv in enumerate([1, 2, 3, 3, 2, 1, 4, 5, 6, 7])]
s0 += [number3(f'M{i+1:02}', lv) for i, lv in enumerate([1, 1, 2, 2, 3, 4, 5, 6, 7])]
s0 += [bullet('B01'), bullet('B02')]
s0 += [note_para('F', 'F01', None), note_para('F', 'F02', '7'), note_para('F', 'F03', '1'),
       note_para('E', 'E01', '1'), newnum('ENDNOTE', 77), note_para('E', 'E02', '1'), newnum('FOOTNOTE', 77),
       p(run(t('〔P01〕') + autonum('PAGE') + t('〔p01〕〔.〕'))),
       note_para('F', 'F04', '1', brk=1), p(run(t('〔P02〕') + autonum('PAGE') + t('〔p02〕〔.〕')))]
s1 = [outline('O12', 1), number('N11', 1), note_para('F', 'F05', '1'), note_para('F', 'F06', '1'),
      p(run(t('〔W〕') + '<hp:ctrl><hp:newNum num="20" numType="FOOTNOTE"/></hp:ctrl>' + t('〔w〕〔.〕'))),
      note_para('F', 'F07', '1'), note_para('E', 'E03', '1'), p(run(t('〔P03〕') + autonum('PAGE') + t('〔p03〕〔.〕')))]
s2 = [outline('O13', 2), note_para('F', 'F08', '1'), note_para('F', 'F09', None), note_para('E', 'E04', '1'),
      p(run(t('〔P04〕') + autonum('PAGE', fmt='ROMAN_SMALL') + t('〔p04〕〔.〕')))]
s3 = [note_para('F', 'F10', '1'), note_para('F', 'F11', '1'), note_para('F', 'F12', '1'), note_para('E', 'E05', '1')]
s4 = ([] if '--no-last-footnotes' in sys.argv else [note_para('F', 'F13', '1'), note_para('F', 'F14', None)]) + [note_para('E', 'E06', '1'), note_para('E', 'E07', '1'),
      p(run(t('〔P05〕') + autonum('PAGE', fmt='HANGUL_SYLLABLE') + t('〔p05〕〔.〕')))]

secs = [
    section(s0, note_pr('footNotePr', 'DIGIT', 'CONTINUOUS', 1), note_pr('endNotePr', 'DIGIT', 'CONTINUOUS', 1, place='END_OF_DOCUMENT'),
            with_header=True),
    section(s1, note_pr('footNotePr', 'CIRCLED_DIGIT', 'ON_SECTION', 5, suffix=''),
            note_pr('endNotePr', 'ROMAN_SMALL', 'CONTINUOUS', 1, place='END_OF_DOCUMENT'), page_start=10, pagenum=('BOTTOM_CENTER', 'ROMAN_CAPITAL')),
    section(s2, note_pr('footNotePr', 'LATIN_CAPITAL', 'CONTINUOUS', 1, prefix='[', suffix=']'),
            note_pr('endNotePr', 'HANGUL_SYLLABLE', 'ON_SECTION', 3, place='END_OF_DOCUMENT'), pagenum=('BOTTOM_RIGHT', 'CIRCLED_DIGIT')),
    section(s3, note_pr('footNotePr', 'USER_CHAR', 'ON_SECTION', 1, user='*', suffix=''),
            note_pr('endNotePr', 'CIRCLED_HANGUL_SYLLABLE', 'CONTINUOUS', 1, place='END_OF_DOCUMENT'), pagenum=('TOP_CENTER', 'LATIN_SMALL')),
    section(s4, note_pr('footNotePr', 'DIGIT', 'ON_SECTION', 77),
            note_pr('endNotePr', 'SYMBOL', 'CONTINUOUS', 1, suffix='', place='END_OF_DOCUMENT'), page_start=77, pagenum=('BOTTOM_CENTER', 'HANGUL_SYLLABLE')),
]
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
