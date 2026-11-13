// 비활성 공급자 정의. 현재 서버·웹·확장 패키지는 이 모듈을 참조하지 않는다.
export const GOOGLE_DRIVE={id:'google',name:'구글 드라이브',projectId:'my-drive',rootName:'내 드라이브',loginUrl:'https://drive.google.com/drive/my-drive'};
export const GOOGLE_MANIFEST_PERMISSIONS={permissions:['identity'],host_permissions:['https://www.googleapis.com/*','https://accounts.google.com/*']};
export function googleTarget(v){
  const safe=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(s);
  if(v?.provider!=='google'||v.projectId!=='my-drive'||!safe(v.folderId||'root'))throw Error('구글 내 드라이브 범위를 확인하세요.');
  return {provider:'google',projectId:'my-drive',folderId:v.folderId||'root'};
}
export function nextGooglePage(state,token){return {...state,pageTokens:[...state.pageTokens,state.pageToken],pageToken:token};}
export function previousGooglePage(state){const history=[...state.pageTokens];return {...state,pageToken:history.pop()||'',pageTokens:history};}
