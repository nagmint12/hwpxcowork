import unittest,pathlib,runpy,zipfile,io,xml.etree.ElementTree as E,tempfile
from types import SimpleNamespace
ROOT=pathlib.Path(__file__).resolve().parents[1];api=runpy.run_path(str(ROOT/'scripts/clipboard-resources.py'));HP=api['HP'];HC=api['HC'];BASE=(ROOT/'testdata/매크로테스트용_저장.hwpx').read_bytes()

def package(mode):
 with zipfile.ZipFile(io.BytesIO(BASE)) as z:
  content={n:z.read(n) for n in z.namelist()};root=E.fromstring(content['Contents/section0.xml']);image=next(root.iter(HC+'img'));ref=image.get('binaryItemIDRef');manifest=E.fromstring(content['Contents/content.hpf']);item=next(e for e in manifest.iter() if e.get('id')==ref);href=item.get('href')
  if mode=='empty-reference':image.set('binaryItemIDRef','')
  elif mode=='missing-item':image.set('binaryItemIDRef','does-not-exist')
  elif mode=='missing-file':content.pop(href)
  elif mode=='empty-data':content[href]=b''
  elif mode=='corrupt-data':content[href]=b'not an image'
  elif mode=='empty-path':item.set('href','')
  elif mode=='external-path':item.set('href','C:/clipboard-test-do-not-open/outside.png')
  elif mode=='white-image':
   from PIL import Image
   out=io.BytesIO();Image.new('RGB',(16,16),'white').save(out,format='PNG');content[href]=out.getvalue()
  else:raise ValueError(mode)
  content['Contents/section0.xml']=E.tostring(root,encoding='utf-8');content['Contents/content.hpf']=E.tostring(manifest,encoding='utf-8');out=io.BytesIO()
  with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as target:
   for name,data in content.items():target.writestr(name,data)
  return out.getvalue()

class ClipboardResources(unittest.TestCase):
 def test_valid_copy_is_byte_identical_and_white_picture_is_retained(self):
  for data in [BASE,package('white-image')]:
   copy,warnings=api['repair_images'](data);self.assertEqual(copy,data);self.assertEqual(warnings,[])
 def test_missing_and_corrupt_images_keep_shape_and_have_no_empty_paths(self):
  for mode in ['empty-reference','missing-item','missing-file','empty-data','corrupt-data','empty-path','external-path']:
   with self.subTest(mode=mode):
    data=package(mode);copy,warnings=api['repair_images'](data);self.assertGreater(len(warnings),0)
    with zipfile.ZipFile(io.BytesIO(data)) as a,zipfile.ZipFile(io.BytesIO(copy)) as b:
     source=E.fromstring(a.read('Contents/section0.xml'));target=E.fromstring(b.read('Contents/section0.xml'));self.assertEqual(len(list(source.iter(HP+'pic'))),len(list(target.iter(HP+'pic'))))
     for x,y in zip(source.iter(HP+'pic'),target.iter(HP+'pic')):
      for name in ['sz','orgSz','curSz','pos','rotationInfo','imgClip']:
       xnode=x.find(HP+name);ynode=y.find(HP+name);self.assertEqual(dict(xnode.attrib) if xnode is not None else None,dict(ynode.attrib) if ynode is not None else None)
     manifest=E.fromstring(b.read('Contents/content.hpf'));items={n.get('id'):n.get('href') for n in manifest.iter() if n.tag.endswith('}item')}
     self.assertTrue(all(not href.startswith(('C:', 'file:', 'http:', 'https:', '\\\\')) for href in items.values()))
     for image in target.iter(HC+'img'):
      self.assertTrue(image.get('binaryItemIDRef'));href=items[image.get('binaryItemIDRef')];self.assertIn(href,b.namelist());self.assertTrue(b.read(href))
    self.assertEqual(api['repair_images'](copy),(copy,[]),'repair is idempotent')
 def test_expansion_limits_accept_large_bitmaps_and_reject_unbounded_archives(self):
  def archive(sizes,count=None,mime=b'application/hwp+zip'):
   return SimpleNamespace(infolist=lambda:[SimpleNamespace(file_size=s) for s in sizes] if count is None else [SimpleNamespace(file_size=0)]*count,read=lambda name:mime)
  api['validate_archive'](archive([107749749]))
  for value in [archive([api['MAX_ENTRY_BYTES']+1]),archive([100*1024**2]*3),archive([],count=4097),archive([],mime=b'not hwpx')]:
   with self.assertRaises(ValueError):api['validate_archive'](value)

if __name__=='__main__':unittest.main()
