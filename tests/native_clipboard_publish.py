"""Publication rollback/ownership tests; never touch the real clipboard."""
import pathlib,runpy,types,sys,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
class NativePublication(unittest.TestCase):
 def publish(self,markers,fail=False):
  api=runpy.run_path(str(ROOT/'scripts/native-clipboard.py'));fn=api['publish_native'];events=[];original=[(49343,'memory',b'HTML marker'),(16,'memory',b'\x12\x04\0\0'),(50060,'memory',b'old native')];calls=[];pending=iter(markers)
  fn.__globals__['current_marker']=lambda token:next(pending)
  fn.__globals__['open_clipboard']=lambda window:events.append(('open',window))
  def freeze(cb,items):items.extend(original)
  def write(cb,items,*args):
   calls.append(list(items))
   if fail and len(calls)==1:raise OSError('publish failed')
  fn.__globals__['runpy']=types.SimpleNamespace(run_path=lambda path:{'freeze_formats':freeze,'write_formats':write,'release_formats':lambda items:events.append(('release',len(items)))})
  cb=types.SimpleNamespace(RegisterClipboardFormat=lambda name:50060,CloseClipboard=lambda:events.append(('close',)))
  gui=types.SimpleNamespace(CreateWindowEx=lambda *args:7,DestroyWindow=lambda window:events.append(('destroy',window)))
  native=bytes.fromhex('d0cf11e0a1b11ae1')+b'\0'*504
  with patch.dict(sys.modules,{'win32clipboard':cb,'win32gui':gui,'win32api':types.SimpleNamespace(GetModuleHandle=lambda arg:1)}):
   try:result=fn(native,'copy-token')
   except OSError:result='failed'
  return result,calls,events,original,native
 def test_static_publication_keeps_formats_and_exact_native_block(self):
  result,calls,events,original,native=self.publish([True,True]);self.assertTrue(result);self.assertEqual(calls,[original[:2]+[(50060,'memory',native)]]);self.assertIn(('close',),events);self.assertIn(('destroy',7),events)
 def test_changed_clipboard_before_or_during_materialization_is_not_replaced(self):
  for markers in [[False],[True,False]]:
   result,calls,events,_,_=self.publish(markers);self.assertFalse(result);self.assertEqual(calls,[]);self.assertIn(('close',),events)
 def test_write_failure_restores_the_original_snapshot(self):
  result,calls,events,original,_=self.publish([True,True],fail=True);self.assertEqual(result,'failed');self.assertEqual(calls[-1],original);self.assertIn(('release',3),events)
if __name__=='__main__':unittest.main()
