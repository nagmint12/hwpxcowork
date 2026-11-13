"""Capture real Hancom clipboard data and Hancom paste baselines, without a browser.

Only temporary source copies and newly created, job-isolated Hwp.exe instances
are used. An owned-window watcher acknowledges Hangul warnings for unattended QA.
python -I tests/clipboard_matrix.py --case hyperlinks
"""
import argparse,json,pathlib,re,shutil,subprocess,sys,tempfile,time

ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/clipboard-audit-20261031'
sys.stdout.reconfigure(encoding='utf8',errors='replace')
CASES=[
 ('hyperlinks','새 폴더/복사붙여넣기안됨.hwpx',None),
 ('tables','testdata/데이터 분석계획서_재수강분석.hwpx',None),
 ('macro','testdata/매크로테스트용_저장.hwpx',None),
 ('shapes','tests/fixtures/shapes_hangul.hwpx',None),
 ('controls','tests/fixtures/codes_hangul_all.hwpx',None),
 ('cells','tests/fixtures/codes_hangul_cells.hwpx',None),
 ('chart','tests/fixtures/chart_hangul.hwpx',None),
 ('chart-cell','tests/fixtures/chart_hangul_cell.hwpx',None),
 ('tracked','tests/fixtures/hangul_tracked.hwpx',None),
 ('toc','tests/fixtures/toc_source.hwpx',None),
 ('sections','tests/fixtures/sections/base.hwpx',None),
 ('section-partial','tests/fixtures/sections/base.hwpx',[1,1,3,2]),
 ('text-partial','새 폴더/복사붙여넣기안됨.hwpx',[1,1,2,3]),
]

def clipboard(fn):
 import win32clipboard as cb
 for attempt in range(120):
  try: cb.OpenClipboard();break
  except Exception:
   if attempt==119: raise
   time.sleep(.025)
 try: return fn(cb)
 finally: cb.CloseClipboard()

def worker(spec):
 import threading
 import win32com.client,win32api,win32con,win32gui,win32job,win32process
 dest=pathlib.Path(spec['out']);dest.mkdir(parents=True,exist_ok=True)
 events=[];stop=threading.Event();pid=None;job=None;hwp=None;tmp=None
 def watch():
  acknowledged={}
  while not stop.wait(.15):
   def inspect(hwnd,_):
    try:
     if win32process.GetWindowThreadProcessId(hwnd)[1]!=pid or win32gui.GetClassName(hwnd)!='#32770': return
     children=[]
     win32gui.EnumChildWindows(hwnd,lambda child,_: children.append((child,win32gui.GetClassName(child),win32gui.GetWindowText(child))),None)
     buttons=[(handle,label) for handle,cls,label in children if cls.lower()=='button' and win32gui.IsWindowEnabled(handle)]
     text=' | '.join(label for _,_,label in children if label)
     if time.monotonic()-acknowledged.get(hwnd,0)<2: return
     for handle,label in buttons:
      if any(word in label.replace('&','') for word in ['허용','확인','예','계속','동의','복구','무시']):
       events.append({'title':win32gui.GetWindowText(hwnd),'text':text[:1200],'action':label})
       (dest/'dialogs.json').write_text(json.dumps(events,ensure_ascii=False,indent=2),encoding='utf8')
       win32gui.PostMessage(handle,win32con.BM_CLICK,0,0);acknowledged[hwnd]=time.monotonic();break
    except Exception: pass
   win32gui.EnumWindows(inspect,None)
 try:
  before=set(win32process.EnumProcesses())
  hwp=win32com.client.DispatchEx('HWPFrame.HwpObject')
  _,pid=win32process.GetWindowThreadProcessId(hwp.XHwpWindows.Item(0).WindowHandle)
  assert pid not in before,'Hangul must be an isolated test process'
  job=win32job.CreateJobObject(None,'')
  info=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
  info['BasicLimitInformation']['LimitFlags']=win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  win32job.SetInformationJobObject(job,win32job.JobObjectExtendedLimitInformation,info)
  proc=win32api.OpenProcess(win32con.PROCESS_SET_QUOTA|win32con.PROCESS_TERMINATE,False,pid)
  try: win32job.AssignProcessToJobObject(job,proc)
  finally: proc.Close()
  threading.Thread(target=watch,daemon=True).start()
  hwp.SetMessageBoxMode(0x00011011);hwp.XHwpWindows.Item(0).Visible=False
  with tempfile.TemporaryDirectory(prefix='clipboard_matrix_',ignore_cleanup_errors=True) as tmp:
   if spec.get('mode')=='paste-only':
    hwp.HAction.Run('FileNew')
    assert hwp.HAction.Run('Paste'),'clipboard paste failed'
    pasted=pathlib.Path(tmp)/'pasted.hwpx'
    assert hwp.SaveAs(str(pasted),'HWPX',''),'clipboard paste save failed'
    shutil.copyfile(pasted,dest/'hangul-pasted.hwpx')
    pages=int(hwp.PageCount)
    if spec.get('pdf'):
     pdf=pathlib.Path(tmp)/'pasted.pdf'
     assert hwp.SaveAs(str(pdf),'PDF',''),'clipboard paste PDF save failed'
     shutil.copyfile(pdf,dest/'hangul-pasted.pdf')
    return {'case':spec['name'],'paste':True,'saved':True,'pages':pages,'pdf':bool(spec.get('pdf')),'dialogs':len(events)}
   source=pathlib.Path(tmp)/'source.hwpx';shutil.copyfile(spec['source'],source)
   assert hwp.Open(str(source),'HWPX','forceopen:true'),'open failed'
   if spec.get('mode')=='resave':
    pages=int(hwp.PageCount)
    saved=pathlib.Path(tmp)/'saved.hwpx';pdf=pathlib.Path(tmp)/'saved.pdf'
    assert hwp.SaveAs(str(saved),'HWPX',''),'save failed'
    assert hwp.SaveAs(str(pdf),'PDF',''),'PDF save failed'
    shutil.copyfile(saved,dest/'hangul-opened.hwpx');shutil.copyfile(pdf,dest/'hangul-opened.pdf')
    return {'case':spec['name'],'open':True,'saved':True,'pdf':True,'pages':pages,'dialogs':len(events)}
   # [hwpx-cowork] Open restores the saved caret, possibly inside a table.
   # Ctrl+A there selects only the cell. Select from the top-level body first.
   assert hwp.SetPos(0,0,0),'body positioning failed'
   if spec.get('selection'):
    assert hwp.SelectText(*spec['selection']),'partial selection failed'
   else: assert hwp.HAction.Run('SelectAll')
   assert hwp.HAction.Run('Copy'),'copy failed'
   def read(cb):
    result={}
    for key,name in [('html','HTML Format'),('native','Hwp Native')]:
     fmt=cb.RegisterClipboardFormat(name)
     if cb.IsClipboardFormatAvailable(fmt): result[key]=cb.GetClipboardData(fmt)
    result['text']=cb.GetClipboardData(cb.CF_UNICODETEXT) if cb.IsClipboardFormatAvailable(cb.CF_UNICODETEXT) else ''
    return result
   copied=clipboard(read)
   for key,value in copied.items():
    (dest/('clipboard.'+{'html':'html','native':'hwp','text':'txt'}[key])).write_bytes(value.encode('utf8') if isinstance(value,str) else value)
   html=copied.get('html',b'');html=html.encode('utf8') if isinstance(html,str) else html
   found=re.search(rb'<!--\[data-hwpjson\]([\s\S]*?)-->',html)
   json_error=None
   if found:
    try:
     model=json.loads(found[1]);(dest/'clipboard.json').write_text(json.dumps(model,ensure_ascii=False),encoding='utf8')
    except json.JSONDecodeError as e:json_error=str(e)
   baselines={}
   for key,fmtname in [('native','Hwp Native'),('html','HTML Format')]:
    if key not in copied: continue
    def write(cb):
     cb.EmptyClipboard();cb.SetClipboardData(cb.RegisterClipboardFormat(fmtname),copied[key])
    clipboard(write)
    hwp.Clear(1);hwp.HAction.Run('FileNew')
    try:
     assert hwp.HAction.Run('Paste'),key+' paste failed'
     pasted=pathlib.Path(tmp)/('pasted-'+key+'.hwpx')
     assert hwp.SaveAs(str(pasted),'HWPX',''),key+' save failed'
     shutil.copyfile(pasted,dest/('hangul-'+key+'.hwpx'));baselines[key]=True
    except Exception as e:baselines[key]=str(e)
  return {'case':spec['name'],'capture':True,'hwpjson':bool(found),'jsonError':json_error,'baselines':baselines,'bytes':{k:len(v) for k,v in copied.items()},'dialogs':len(events)}
 finally:
  if hwp:
   try: hwp.Clear(1);hwp.Quit()
   except Exception: pass
  stop.set()
  if job:job.Close()
  if tmp:
   target=pathlib.Path(tmp).resolve();temp_root=pathlib.Path(tempfile.gettempdir()).resolve()
   assert target.is_relative_to(temp_root) and target.name.startswith('clipboard_matrix_')
   shutil.rmtree(target,ignore_errors=True)

def main():
 p=argparse.ArgumentParser();p.add_argument('--worker');p.add_argument('--case',action='append');p.add_argument('--verify',action='store_true');args=p.parse_args()
 if args.worker:
  spec=json.loads(args.worker)
  try:result=worker(spec)
  except Exception as e: result={'case':spec['name'],'capture':False,'error':str(e)}
  (pathlib.Path(spec['out'])/'capture-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
  print(json.dumps(result,ensure_ascii=False),flush=True);return
 OUT.mkdir(parents=True,exist_ok=True);results=[]
 result_file=OUT/('hancom-open-results.json' if args.verify else 'captures.json')
 previous={r['case']:r for r in json.loads(result_file.read_text(encoding='utf8'))} if result_file.exists() else {}
 cases=CASES
 if args.verify:
  cases=[]
  for name,_,_ in CASES:
   if args.case and name not in args.case:continue
   for variant in ['web-native-pasted','web-json-pasted']:
    source=OUT/name/(variant+'.hwpx')
    if source.exists():cases.append((name+'-'+variant,str(source),None))
 for name,source,selection in cases:
  if not args.verify and args.case and name not in args.case:continue
  dest=OUT/'hancom-open'/name if args.verify else OUT/name
  spec={'name':name,'source':str(ROOT/source),'selection':selection,'out':str(dest),'mode':'resave' if args.verify else 'copy'}
  try:
   proc=subprocess.run([sys.executable,'-I',__file__,'--worker',json.dumps(spec,ensure_ascii=False)],capture_output=True,timeout=75)
   print(proc.stdout.decode('utf8','replace'),end='',flush=True)
   if proc.stderr: print(proc.stderr.decode('utf8','replace')[-1500:],flush=True)
   result=json.loads((dest/'capture-result.json').read_text(encoding='utf8'))
  except subprocess.TimeoutExpired:result={'case':name,'capture':False,'error':'Hangul worker timed out after 75 seconds'};print(json.dumps(result),flush=True)
  except Exception as e:result={'case':name,'capture':False,'error':str(e)};print(json.dumps(result),flush=True)
  results.append(result)
 previous.update({r['case']:r for r in results})
 result_file.write_text(json.dumps(list(previous.values()),ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
