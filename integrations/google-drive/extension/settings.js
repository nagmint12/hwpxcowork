// 배포에서 제외한 Google OAuth 설정 화면. 복구 전 별도 검증이 필요하다.
import {googleLogin} from './google.js';
import {googleSupport} from './support.js';
const saved=await chrome.storage.local.get('googleClientId');
let redirect=null;try{if(googleSupport())redirect=chrome.identity.getRedirectURL();}catch{}
document.querySelector('#redirect').textContent=redirect||'Google 로그인 기능이 이 브라우저에서 꺼져 있습니다.';
document.querySelector('#google-client').value=saved.googleClientId||'';
document.querySelector('#google-login').disabled=!redirect;
document.querySelector('#google-login').onclick=async()=>{try{await googleLogin(document.querySelector('#google-client').value.trim());document.querySelector('#google-status').textContent='구글 계정을 연결했습니다.';}catch(e){document.querySelector('#google-status').textContent=e.message;}};
document.querySelector('#google-logout').onclick=async()=>{const {google}=await chrome.storage.session.get('google');await chrome.storage.session.remove('google');if(google?.token)await fetch('https://accounts.google.com/o/oauth2/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:google.token})}).catch(()=>{});document.querySelector('#google-status').textContent='구글 연결을 해제했습니다.';};
