// 보관용 어댑터. 현재 배포 확장·서버에서는 불러오지 않는다.
const BASE='https://www.googleapis.com';
const FIELDS='id,name,mimeType,size,version,parents,trashed,capabilities(canEdit,canDownload)';
const exports={
 'application/vnd.google-apps.document':['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],
 'application/vnd.google-apps.spreadsheet':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],
 'application/vnd.google-apps.presentation':['application/vnd.openxmlformats-officedocument.presentationml.presentation','.pptx'],
 'application/vnd.google-apps.drawing':['application/pdf','.pdf'],
};
const norm=f=>({id:f.id,name:f.name,type:f.mimeType==='application/vnd.google-apps.folder'?'folder':'file',size:Number(f.size)||0,mime:f.mimeType,revision:String(f.version||'')});
export async function googleLogin(clientId) {
  if(!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId))throw Error('Google OAuth 클라이언트 ID를 확인하세요.');
  const state=crypto.randomUUID();const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search=new URLSearchParams({client_id:clientId,redirect_uri:chrome.identity.getRedirectURL(),response_type:'token',scope:'https://www.googleapis.com/auth/drive',state,prompt:'select_account'});
  const response=await chrome.identity.launchWebAuthFlow({url:u.href,interactive:true});const result=new URL(response);const p=new URLSearchParams(result.hash.slice(1));
  if(result.origin!==new URL(chrome.identity.getRedirectURL()).origin||p.get('state')!==state||!p.get('access_token'))throw Error(p.get('error')||'Google 인증 응답을 확인하지 못했습니다.');
  if(!(p.get('scope')||'').split(' ').includes('https://www.googleapis.com/auth/drive'))throw Error('파일 탐색과 수정을 위한 Drive 권한이 필요합니다.');
  await chrome.storage.session.set({google:{token:p.get('access_token'),expires:Date.now()+Number(p.get('expires_in')||3600)*1000}});
  await chrome.storage.local.set({googleClientId:clientId});
}
export async function googleAction(job,blob) {
  const {google}=await chrome.storage.session.get('google');if(!google||google.expires<Date.now()+10000)throw Error('연결 실행 창에서 구글 계정을 연결해 주세요.');
  const good=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(s);
  if(job.target.projectId!=='my-drive'||!good(job.target.folderId)||((job.fileId||job.replaceId)&&!good(job.fileId||job.replaceId)))throw Error('구글 드라이브 범위를 확인하세요.');
  async function request(route,options={}) {
    const r=await fetch(BASE+route,{...options,redirect:'error',headers:{Authorization:`Bearer ${google.token}`,...options.headers},signal:AbortSignal.timeout(60000)});
    if(!r.ok){if(r.status===401)await chrome.storage.session.remove('google');throw Error(r.status===412?'원격 파일이 변경되었습니다. 새로 읽고 확인하세요.':`Google Drive 응답 오류 ${r.status}`)}return r;
  }
  const meta=async key=>{const r=await request('/drive/v3/files/'+encodeURIComponent(key)+'?'+new URLSearchParams({fields:FIELDS,supportsAllDrives:'true'}));return {...await r.json(),etag:r.headers.get('etag')};};
  const folder=await meta(job.target.folderId);if(folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder')throw Error('선택한 위치가 폴더가 아닙니다.');
  const checked=async key=>{const f=await meta(key);if(f.trashed||!f.parents?.includes(folder.id)||f.mimeType==='application/vnd.google-apps.folder')throw Error('선택한 폴더의 파일만 사용할 수 있습니다.');if(job.expectedRevision&&String(f.version)!==job.expectedRevision)throw Error('파일이 변경되었습니다. 새로 읽고 확인하세요.');return f;};
  if(job.action==='projects')return {projects:[{id:'my-drive',name:'내 드라이브'}]};
  if(job.action==='list') {
    const q="'"+folder.id+"' in parents and trashed = false";
    const r=await request('/drive/v3/files?'+new URLSearchParams({q,fields:`nextPageToken,files(${FIELDS})`,pageSize:'50',pageToken:job.pageToken||'',orderBy:'folder,name'}));const j=await r.json();
    return {items:j.files.map(norm),folderName:folder.name,nextPageToken:j.nextPageToken||'',total:j.files.length};
  }
  if(job.action==='download') {
    const f=await checked(job.fileId);if(Number(f.size||0)>job.maxBytes||f.capabilities?.canDownload===false)throw Error('다운로드 권한 또는 파일 크기를 확인하세요.');
    const exp=exports[f.mimeType];if(f.mimeType.startsWith('application/vnd.google-apps.')&&!exp)throw Error('이 Google 문서 형식은 내보내기를 지원하지 않습니다.');
    const r=await request('/drive/v3/files/'+f.id+(exp?'/export?'+new URLSearchParams({mimeType:exp[0]}):'?alt=media'));
    const data=await r.blob();if(data.size>job.maxBytes)throw Error('파일 크기 한도를 초과했습니다.');await checked(job.fileId);
    return {blob:data,name:f.name+(exp&&!f.name.endsWith(exp[1])?exp[1]:''),mime:exp?.[0]||f.mimeType};
  }
  if(job.action==='upload') {
    if(blob.size>job.maxBytes)throw Error('파일 크기 한도를 초과했습니다.');
    let previous=null;
    if(job.replaceId){previous=await checked(job.replaceId);if(previous.mimeType.startsWith('application/vnd.google-apps.'))throw Error('Google 문서는 새 파일로 올려 주세요. 원본 교체는 일반 파일만 지원합니다.');if(previous.name!==job.name)throw Error('교체 파일 이름은 원본과 같아야 합니다.');}
    else {const r=await request('/drive/v3/files?'+new URLSearchParams({q:"'"+folder.id+"' in parents and trashed = false and name = '"+job.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'",fields:'files(id)',pageSize:'1'}));if((await r.json()).files.length)throw Error('같은 이름의 파일이 있습니다. 교체 대상을 선택하세요.');}
    const metadata=previous?{name:job.name}:{name:job.name,parents:[folder.id]};
    const headers={'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':job.mime||'application/octet-stream','X-Upload-Content-Length':String(blob.size)};if(previous?.etag)headers['If-Match']=previous.etag;
    const init=await request('/upload/drive/v3/files'+(previous?'/'+previous.id:'')+'?'+new URLSearchParams({uploadType:'resumable',fields:FIELDS,supportsAllDrives:'true'}),{method:previous?'PATCH':'POST',headers,body:JSON.stringify(metadata)});
    const session=new URL(init.headers.get('location'));if(session.origin!==BASE||!session.pathname.startsWith('/upload/drive/v3/files'))throw Error('Google 업로드 주소를 확인하지 못했습니다.');
    if(previous)await checked(job.replaceId);
    const uploadHeaders={'Content-Type':job.mime||'application/octet-stream'};if(previous?.etag)uploadHeaders['If-Match']=previous.etag;
    const r=await request(session.pathname+session.search,{method:'PUT',headers:uploadHeaders,body:blob});return norm(await r.json());
  }
  throw Error('지원하지 않는 작업입니다.');
}
