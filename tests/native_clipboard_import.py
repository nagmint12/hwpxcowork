"""A completed conversion survives a Hancom RPC error during owned-job cleanup."""
import base64,io,pathlib,runpy,sys,types,unittest,zipfile
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]

class NativeImportCleanup(unittest.TestCase):
 def run_import(self,opened):
  namespace=runpy.run_path(str(ROOT/'scripts/native-clipboard.py'));fn=namespace['import_native'];fn.__globals__['register_file_security']=lambda hwp:True
  closed=[];quit_called=[]
  class Hwp:
   XHwpWindows=types.SimpleNamespace(Item=lambda i:types.SimpleNamespace(WindowHandle=7,Visible=False))
   def SetMessageBoxMode(self,mode):pass
   def Open(self,*args):return opened
   def SaveAs(self,path,*args):
    with zipfile.ZipFile(path,'w') as z:z.writestr('mimetype','application/hwp+zip')
    return True
   def Clear(self,*args):raise RuntimeError('Hancom RPC cleanup failure')
   def Quit(self):quit_called.append(True);raise RuntimeError('Hancom already exited')
  com=types.ModuleType('win32com');client=types.ModuleType('win32com.client');client.DispatchEx=lambda name:Hwp();com.client=client
  process=types.SimpleNamespace(EnumProcesses=lambda:[0,1],GetWindowThreadProcessId=lambda hwnd:(1,1234))
  api=types.SimpleNamespace(OpenProcess=lambda *args:types.SimpleNamespace(Close=lambda:None))
  constants=types.SimpleNamespace(PROCESS_SET_QUOTA=1,PROCESS_TERMINATE=2)
  job=types.SimpleNamespace(JobObjectExtendedLimitInformation=1,JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=1,CreateJobObject=lambda *args:types.SimpleNamespace(Close=lambda:closed.append(True)),QueryInformationJobObject=lambda *args:{'BasicLimitInformation':{}},SetInformationJobObject=lambda *args:None,AssignProcessToJobObject=lambda *args:None)
  with patch.dict(sys.modules,{'win32com':com,'win32com.client':client,'win32process':process,'win32api':api,'win32con':constants,'win32job':job}):
   result=fn({'native':base64.b64encode(bytes.fromhex('d0cf11e0a1b11ae1')+b'copied block').decode()})
  self.assertEqual(closed,[True]);self.assertEqual(quit_called,[True]);return result
 def test_successful_conversion_is_returned_after_cleanup_rpc_fault(self):
  result=self.run_import(True);self.assertTrue(result['ok'])
  with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['hwpx']))) as z:self.assertEqual(z.read('mimetype'),b'application/hwp+zip')
 def test_open_failure_remains_a_failure_and_still_closes_own_job(self):
  self.assertEqual(self.run_import(False),{'ok':False,'reason':'OPEN_FAILED'})

if __name__=='__main__':unittest.main()
