// executeScript의 격리된 world에서 실행한다. 함수 밖의 변수나 Chrome API를 참조하지 않는다.
export async function doorayAction(a) {
  // Chromium은 주입 함수의 예외를 호출자에게 온전히 돌려주지 않는다. 전송 경로에서만 명시적인 결과 봉투로 변환한다.
  if(a?.transport===true){try{return {ok:true,value:await doorayAction({...a,transport:false})};}catch(e){return {ok:false,error:String(e?.message||e).slice(0,700)};}}
  const stop=msg=>{throw Error(msg)};
  if(!/^https:\/\/([a-z0-9-]+\.)+(?:gov-dooray|dooray)\.com$/i.test(location.origin)||(a.origin&&location.origin!==a.origin))stop('선택한 두레이 사이트의 개인 프로젝트만 허용합니다.');
  const current=/^\/drive\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1];
  const PROJECT=a.action==='projects'?current:a.target?.projectId;
  if(!/^\d{1,30}$/.test(PROJECT||''))stop('개인 프로젝트만 허용합니다. 두레이에서 개인 프로젝트를 열어 주세요.');
  if(current!==PROJECT)stop('두레이 로그인을 완료하고 개인 프로젝트를 열어 주세요.');
  const good=s=>typeof s==='string'&&/^(root|\d{1,30})$/.test(s);
  if(!good(a.target.folderId||'root')||(a.fileId&&!good(a.fileId))||(a.replaceId&&!good(a.replaceId)))stop('폴더 또는 파일 ID가 올바르지 않습니다.');
  // 숫자로 반환되는 큰 ID도 원문 문자열로 보존한다.
  const parse=s=>JSON.parse(s.replace(/"(?:\\.|[^"\\])*"|(-?\d{16,})(?=\s*[,}\]])/g,(m,n)=>n?JSON.stringify(n):m));
  async function api(route,options={}) {
    const r=await fetch(route,{...options,credentials:'include',redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!r.ok)stop(r.status===401||r.status===403?'두레이 로그인 또는 파일 권한을 확인하세요.':`두레이 응답 오류 ${r.status}`);
    const text=await r.text();let j;try{j=parse(text)}catch{stop('두레이 로그인 또는 응답 형식을 확인하세요.')}
    if(j.header?.isSuccessful===false)stop(j.header.resultMessage||'두레이 작업이 실패했습니다.');return j.result;
  }
  const drive=(await api('/v2/wapi/drives/'+PROJECT))?.content;
  if(!drive||drive.projectId!==PROJECT||drive.type!=='private'||!good(drive.id))stop('개인 드라이브를 확인하지 못했습니다.');
  if(a.action==='projects')return {projects:[{id:PROJECT,name:'개인 프로젝트',type:'private',driveId:drive.id}]};
  const base='/v2/wapi/drives/'+drive.id+'/files';
  const folder=a.target.folderId||'root';
  async function meta(key) {
    const f=(await api(base+'/'+key))?.content;
    if(!f||f.driveId!==drive.id||f.projectId!==PROJECT||f.isTrashed)stop('개인 프로젝트 안의 파일이 아닙니다.');return f;
  }
  const fm=folder==='root'?null:await meta(folder);if(fm&&fm.type!=='folder')stop('업로드 위치가 폴더가 아닙니다.');
  async function checkedFile(key,revision) {
    const f=await meta(key);const parent=f.parentFile;
    if(f.type!=='file'||(folder==='root'?parent?.path!=='root':parent?.id!==folder))stop('선택한 폴더의 파일만 사용할 수 있습니다.');
    if(revision&&String(f.revision)!==String(revision))stop('파일이 다른 곳에서 변경되었습니다. 목록을 새로 읽고 확인하세요.');return f;
  }
  const norm=f=>({id:String(f.id),name:f.name,type:f.type==='folder'?'folder':'file',size:f.size||0,mime:f.mimeType||'',revision:String(f.revision||'')});
  if(a.action==='list') {
    const r=await api(base+'?'+new URLSearchParams({size:'50',page:String(a.page||0),order:'name',parentId:folder}));
    const items=(r?.contents||[]).filter(f=>!f.isTrashed&&f.subType!=='trash'&&f.subType!=='root');
    if(items.some(f=>f.driveId!==drive.id||f.projectId!==PROJECT))stop('폴더 범위를 확인하지 못했습니다.');
    return {items:items.map(norm),folderName:fm?.name||'개인 프로젝트',total:r.totalCount,nextPage:((a.page||0)+1)*50<r.totalCount?(a.page||0)+1:null};
  }
  // 삭제 = 휴지통으로 옮김(두레이에서 되살릴 수 있다). 이름 바꾸기 = 같은 폴더에 같은 이름이 없을 때만. 둘 다 목록에서 본 revision 과 같아야 한다
  // 경로는 두레이 드라이브 API(/drive/v1/drives/{driveId}/files/{fileId}/move · ?media=meta)를 웹 로그인으로 부른다 — 실제 두레이에서 아직 확인하지 않았다
  if(a.action==='delete') {
    const f=await checkedFile(a.fileId,a.expectedRevision);
    await api('/drive/v1/drives/'+drive.id+'/files/'+f.id+'/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({destinationFileId:'trash'})});
    return {id:String(f.id),deleted:true};
  }
  if(a.action==='rename') {
    if(!a.name||a.name.length>240||/[\\/\x00-\x1f]/.test(a.name))stop('새 파일 이름을 확인하세요.');
    const f=await checkedFile(a.fileId,a.expectedRevision);if(f.name===a.name)return norm(f);
    const existing=await api(base+'?'+new URLSearchParams({size:'1',name:a.name,parentId:folder}));if(existing.totalCount>0)stop('같은 이름의 파일이 있습니다.');
    await api('/drive/v1/drives/'+drive.id+'/files/'+f.id+'?media=meta',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:a.name})});
    return norm(await meta(String(f.id)));
  }
  const transfers=globalThis.__coworkDriveTransfers ||= new Map();
  for(const [key,v] of transfers)if(Date.now()-v.at>180000)transfers.delete(key);
  const transfer=()=>{const t=transfers.get(a.transferId);if(!t||t.folder!==folder||t.projectId!==PROJECT||t.driveId!==drive.id)stop('파일 전송이 만료되었습니다.');return t};
  if(a.action==='downloadStart') {
    const f=await checkedFile(a.fileId,a.expectedRevision);if(f.size>a.maxBytes)stop('파일 크기 한도를 초과했습니다.');
    const r=await fetch('/drive/v1/downloads/'+PROJECT+'/'+f.id,{credentials:'include',redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!r.ok||/text\/html/.test(r.headers.get('content-type')||''))stop('파일을 내려받지 못했습니다. 로그인 상태를 확인하세요.');
    const bytes=new Uint8Array(await r.arrayBuffer());if(bytes.length>a.maxBytes)stop('파일 크기 한도를 초과했습니다.');
    await checkedFile(a.fileId,String(f.revision));
    const key=crypto.randomUUID();transfers.set(key,{bytes,folder,projectId:PROJECT,driveId:drive.id,at:Date.now()});return {...norm(f),size:bytes.length,transferId:key};
  }
  if(a.action==='downloadChunk') {const t=transfer();if(!Number.isInteger(a.offset)||a.offset<0)stop('잘못된 전송 위치입니다.');const b=t.bytes.subarray(a.offset,a.offset+262144);let s='';for(let i=0;i<b.length;i+=16384)s+=String.fromCharCode(...b.subarray(i,i+16384));return {data:btoa(s)};}
  if(a.action==='release') {transfers.delete(a.transferId);return {ok:true};}
  if(a.action==='uploadStart') {
    if(!Number.isInteger(a.size)||a.size<0||a.size>a.maxBytes||!a.name||/[\\/\x00-\x1f]/.test(a.name))stop('업로드 파일을 확인하세요.');
    const key=crypto.randomUUID();transfers.set(key,{parts:[],size:0,total:a.size,folder,projectId:PROJECT,driveId:drive.id,name:a.name,mime:a.mime,max:a.maxBytes,replaceId:a.replaceId,expectedRevision:a.expectedRevision,at:Date.now()});return {transferId:key};
  }
  if(a.action==='uploadChunk') {const t=transfer();const bytes=Uint8Array.from(atob(a.data),c=>c.charCodeAt(0));if(bytes.length>262144||t.size+bytes.length>t.total)stop('파일 크기가 일치하지 않습니다.');t.parts.push(bytes);t.size+=bytes.length;return {ok:true};}
  if(a.action==='uploadCommit') {
    const t=transfer();if(t.size!==t.total)stop('파일 전송이 완료되지 않았습니다.');
    if(t.replaceId) {const f=await checkedFile(t.replaceId,t.expectedRevision);if(f.name!==t.name)stop('교체 파일 이름은 원본과 같아야 합니다.');}
    else {const existing=await api(base+'?'+new URLSearchParams({size:'1',name:t.name,parentId:folder}));if(existing.totalCount>0)stop('같은 이름의 파일이 있습니다. 목록에서 교체 대상을 선택하세요.');}
    const form=new FormData();form.append('file',new Blob(t.parts,{type:t.mime||'application/octet-stream'}),t.name);
    transfers.delete(a.transferId);
    const route='/drive/v1/uploads/'+drive.id+(t.replaceId?'/'+t.replaceId+'/update':'?'+new URLSearchParams({parentId:folder}));
    const r=await api(route,{method:'POST',body:form});const uploaded=r?.content;if(!uploaded?.id)stop('업로드 결과를 확인하지 못했습니다. 두레이에서 확인하세요.');
    const f=await meta(String(uploaded.id));return norm(f);
  }
  stop('지원하지 않는 드라이브 작업입니다.');
}
