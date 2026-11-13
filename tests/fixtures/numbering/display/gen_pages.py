# 번호 모양 범위 시험지 — 구역마다 쪽 시작 번호를 주고 본문 쪽 번호(autoNum PAGE)를 여러 모양으로 찍는다.
# 범위를 넘는 번호(가나다 15·85, 원 문자 21 …)를 한/글이 어떻게 그리는지 본다.
import os, re, sys, zipfile

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'vendor', 'rhwp', 'samples', 'hwpx', 'ref', 'ref_empty.hwpx')
OUT = sys.argv[1]
z = zipfile.ZipFile(BASE)
files = {n: z.read(n) for n in z.namelist()}
header = files['Contents/header.xml'].decode('utf-8')
sec0 = files['Contents/section0.xml'].decode('utf-8')
SEC_OPEN = sec0[:sec0.index('<hp:p ')]
secpr = re.search(r'<hp:secPr .*?</hp:secPr>', sec0, re.S).group(0)
colpr = '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>'

FORMATS = ['DIGIT', 'CIRCLED_DIGIT', 'ROMAN_CAPITAL', 'ROMAN_SMALL', 'LATIN_CAPITAL', 'LATIN_SMALL', 'CIRCLED_LATIN_CAPITAL',
           'CIRCLED_LATIN_SMALL', 'HANGUL_SYLLABLE', 'CIRCLED_HANGUL_SYLLABLE', 'HANGUL_JAMO', 'CIRCLED_HANGUL_JAMO',
           'HANGUL_PHONETIC', 'IDEOGRAPH', 'CIRCLED_IDEOGRAPH']
STARTS = [1, 11, 15, 21, 27, 30, 85, 99, 1234]

def t(s): return f'<hp:t>{s}</hp:t>'
def p(inner): return f'<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">{inner}</hp:run></hp:p>'
def autonum(fmt):
    return (f'<hp:ctrl><hp:autoNum num="1" numType="PAGE"><hp:autoNumFormat type="{fmt}" userChar="" prefixChar="" '
            f'suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>')

secs = []
for si, start in enumerate(STARTS):
    sp = secpr.replace('page="0"', f'page="{start}"', 1)
    first = p(sp + colpr + t(f'〔S〕{start}〔.〕'))
    body = ''.join(p(t(f'〔Q{si}_{fi:02}〕') + autonum(f) + t(f'〔q〕〔.〕')) for fi, f in enumerate(FORMATS))
    secs.append(SEC_OPEN + first + body + '</hs:sec>')

header = header.replace('secCnt="1"', f'secCnt="{len(secs)}"')
hpf = files['Contents/content.hpf'].decode('utf-8')
items = ''.join(f'<opf:item id="section{i}" href="Contents/section{i}.xml" media-type="application/xml"/>' for i in range(1, len(secs)))
refs = ''.join(f'<opf:itemref idref="section{i}"/>' for i in range(1, len(secs)))
hpf = hpf.replace('<opf:item id="settings"', items + '<opf:item id="settings"').replace('</opf:spine>', refs + '</opf:spine>')
files['Contents/header.xml'] = header.encode('utf-8')
files['Contents/content.hpf'] = hpf.encode('utf-8')
for i, s in enumerate(secs):
    files[f'Contents/section{i}.xml'] = s.encode('utf-8')
with zipfile.ZipFile(OUT, 'w') as o:
    for n in ['mimetype'] + [n for n in files if n != 'mimetype']:
        o.writestr(n, files[n], zipfile.ZIP_STORED if n == 'mimetype' else zipfile.ZIP_DEFLATED)
print('wrote', OUT)
