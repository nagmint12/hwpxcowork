// 외부 드라이브의 전송함과 기존 문서함을 연결하는 화면 모델. 기존 권한 계산을 재사용한다.
import {moveTargets,crumbs,locKey,docLoc} from './library-model.js';
export function driveImportTargets(library,me){
  if(!library||!me)return [];
  return moveTargets(library,me).map(t=>({key:locKey(t.loc),location:t.loc,label:crumbs(library,t.loc,me).map(c=>c.label).join(' › ')}));
}
export function defaultDriveImportTarget(targets,me,preferred=null){
  return targets.find(t=>preferred&&t.key===locKey(preferred))||targets.find(t=>t.key===locKey({space:'private',owner:me?.name,folderId:null}))||null;
}
export function driveDocumentChoices(library,me){
  const ids=new Set((library?.folders||[]).map(f=>f.id));
  return (library?.docs||[]).map(d=>({id:d.id,label:[...crumbs(library,docLoc(d,ids),me).map(c=>c.label),d.title].join(' › ')}));
}
