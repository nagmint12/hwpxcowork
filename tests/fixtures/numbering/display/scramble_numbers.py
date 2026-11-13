# 한/글이 다시 저장한 시험지(줄 배치가 한/글과 같다)의 각주·미주 저장 번호를 흐트러뜨린다 — 엔진이 저장 번호가 아니라
# 쪽·문서 차례로 번호를 매기는지 본다. 홀수 번째 주석은 number 를 지우고(실문서A 문서의 <hp:footNote id="">),
# 짝수 번째는 9 로 바꾼다. 주석 안 autoNum num 도 같이.
# 쓰는 법: python -I scramble_numbers.py <한/글 저장.hwpx> <out.hwpx>
import re, sys, zipfile

src, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
files = {n: z.read(n) for n in z.namelist()}
count = [0]

def note(m):
    count[0] += 1
    tag = re.sub(r' number="\d+"', '' if count[0] % 2 else ' number="9"', m.group(0))
    return tag

for name in list(files):
    if re.fullmatch(r'Contents/section\d+\.xml', name):
        xml = files[name].decode('utf-8')
        xml = re.sub(r'<hp:(?:footNote|endNote) [^>]*>', note, xml)
        xml = re.sub(r'<hp:autoNum num="\d+" numType="(FOOTNOTE|ENDNOTE)"', r'<hp:autoNum num="9" numType="\1"', xml)
        files[name] = xml.encode('utf-8')
assert count[0] > 10, count[0]
order = ['mimetype'] + [n for n in files if n != 'mimetype']
with zipfile.ZipFile(out, 'w') as o:
    for n in order:
        o.writestr(n, files[n], zipfile.ZIP_STORED if n == 'mimetype' else zipfile.ZIP_DEFLATED)
print('wrote', out, count[0], 'notes')
