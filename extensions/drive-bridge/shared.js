export const DOORAY_DISCOVERY='personal';
export function doorayUrl(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!/^([a-z0-9-]+\.)+(?:gov-dooray|dooray)\.com$/i.test(u.hostname)||!['/','/drive','/drive/'].includes(u.pathname))throw Error('두레이 기본 주소를 입력하세요. 예: https://team.dooray.com');
  return u.origin;
}
export async function doorayOrigin(api=chrome) {
  const saved=await api.storage.local.get('doorayOrigin');
  if(!saved.doorayOrigin)throw Error('확장 아이콘에서 두레이 주소를 먼저 저장하세요.');
  return doorayUrl(saved.doorayOrigin);
}
export function serverUrl(value) {
  const u=new URL(value);if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('cowork 서버의 기본 주소를 입력하세요.');
  const host=u.hostname.toLowerCase();const ip=host.split('.').map(Number);
  const privateIp=/^\d+\.\d+\.\d+\.\d+$/.test(host)&&ip.every(n=>n>=0&&n<=255)&&(ip[0]===127||ip[0]===10||(ip[0]===172&&ip[1]>=16&&ip[1]<=31)||(ip[0]===192&&ip[1]===168));
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&(host==='localhost'||host==='[::1]'||privateIp)))throw Error('HTTPS 서버 주소 또는 localhost·사내망 IP 주소를 입력하세요.');
  return u.origin;
}
export const bytesToBase64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(s);};
export const base64ToBytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function responseError(response,body,html=false) {
  const ngrokCode=/\bERR_NGROK_\d+\b/.exec(body)?.[0];
  const message=ngrokCode
    ? `ngrok가 cowork API 대신 안내·오류 페이지를 반환했습니다(${ngrokCode}). 서버 주소와 터널 실행 상태를 확인하세요.`
    : html?'cowork API 대신 HTML 페이지를 받았습니다. 서버의 기본 주소와 터널 상태를 확인하세요.'
      :'cowork API의 JSON 응답을 읽지 못했습니다. 서버 주소와 연결 상태를 확인하세요.';
  return Object.assign(Error(message),{status:response.status,code:html||ngrokCode?'BRIDGE_HTML_RESPONSE':'BRIDGE_BAD_JSON'});
}
async function readServerJson(response) {
  const body=await response.text();
  try{return JSON.parse(body);}catch{throw responseError(response,body,/^\s*</.test(body)||/html/i.test(response.headers.get('content-type')||''));}
}
export async function serverFetch(connection,route,options={}) {
  if(typeof route!=='string'||!route.startsWith('/api/drive/')||route.startsWith('//')||route.includes('\\'))throw Error('허용되지 않은 드라이브 API 경로입니다.');
  const headers=new Headers(options.headers);
  // 확장 요청은 웹페이지의 ngrok 방문 쿠키를 공유하지 않는다. GET·POST·바이너리 전송 모두 공식 헤더로 안내 페이지를 제외한다.
  headers.set('ngrok-skip-browser-warning','1');
  headers.set('x-cowork-drive-version',globalThis.chrome?.runtime?.getManifest?.().version||'unknown');
  if(connection.token)headers.set('Authorization',`Bearer ${connection.token}`);
  const r=await fetch(serverUrl(connection.server)+route,{...options,redirect:'error',credentials:'omit',headers,signal:AbortSignal.timeout(60000)});
  if(/html/i.test(r.headers.get('content-type')||''))throw responseError(r,await r.text(),true);
  if(!r.ok){const body=await readServerJson(r);throw Object.assign(Error(body.message||`서버 오류 ${r.status}`),{status:r.status,code:body.error});}return r;
}
export async function serverJson(connection,route,options={}) {
  const headers=new Headers(options.headers);headers.set('Accept','application/json');
  return readServerJson(await serverFetch(connection,route,{...options,headers}));
}
