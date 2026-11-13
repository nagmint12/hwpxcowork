export const canImportDriveFile=f=>f?.type==='file'&&/\.hwpx$/i.test(f.name||'');
export function driveRows(items,query='',descending=false){
  const q=String(query).trim().toLocaleLowerCase('ko-KR');
  return (items||[]).filter(f=>!q||f.name.toLocaleLowerCase('ko-KR').includes(q)).slice().sort((a,b)=>a.type===b.type?(descending?-1:1)*a.name.localeCompare(b.name,'ko-KR'):a.type==='folder'?-1:1);
}
export const folderKey=(provider,projectId,folderId)=>[provider,projectId,folderId].join(':');
// 사용자가 읽은 경로만 나무로 만든다. 하위 폴더 전체를 순회하거나 다른 프로젝트로 요청하지 않는다.
export function driveTree(cache,provider,projectId,rootName){
  const root={id:'root',name:rootName,path:[{id:'root',name:rootName}],children:new Map()};
  function add(path){let node=root;for(let i=1;i<path.length;i++){const f=path[i];if(!node.children.has(f.id))node.children.set(f.id,{id:f.id,name:f.name,path:path.slice(0,i+1),children:new Map()});node=node.children.get(f.id);}return node;}
  for(const entry of cache.values())if(entry.provider===provider&&entry.projectId===projectId){add(entry.path);for(const folder of entry.folders)add([...entry.path,{id:folder.id,name:folder.name}]);}
  const rows=[];function visit(node,depth){rows.push({id:node.id,name:node.name,path:node.path,depth});for(const child of [...node.children.values()].sort((a,b)=>a.name.localeCompare(b.name,'ko-KR')))visit(child,depth+1);}visit(root,0);return rows;
}
export function importSpaceTargets(targets,space,me){return targets.filter(t=>t.location.space===space&&(space==='public'||t.location.owner===me?.name));}
