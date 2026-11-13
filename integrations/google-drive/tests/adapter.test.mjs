import test from 'node:test';
import assert from 'node:assert/strict';
import {googleAction} from '../extension/google.js';

test('Google: 현재 폴더만 조회·바이너리 다운로드·revision 검사·resumable 업로드',async t=>{
 const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;const visits=[];
 globalThis.chrome={storage:{session:{get:async()=>({google:{token:'test-google-token',expires:Date.now()+3600000}}),remove:async()=>{}}}};
 const folder={id:'folder1',name:'내 폴더',mimeType:'application/vnd.google-apps.folder',version:'1'};
 const file={id:'file1',name:'자료.txt',mimeType:'text/plain',size:'4',version:'7',parents:['folder1']};
 globalThis.fetch=async(url,options)=>{visits.push({url,options});const u=new URL(url);if(u.searchParams.get('alt')==='media')return new Response('test');if(u.pathname==='/upload/drive/v3/files/file1'&&options.method==='PATCH')return new Response('',{headers:{location:'https://www.googleapis.com/upload/drive/v3/files/file1?upload_id=test'}});if(options.method==='PUT')return Response.json({...file,version:'8'});if(u.pathname==='/drive/v3/files')return Response.json({files:[file],nextPageToken:'next'});return Response.json(u.pathname.endsWith('/file1')?file:folder,{headers:{etag:'"etag-7"'}});};
 t.after(()=>{globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;});
 const base={target:{provider:'google',projectId:'my-drive',folderId:'folder1'},maxBytes:1024};
 const listing=await googleAction({...base,action:'list'});assert.equal(listing.items[0].revision,'7');assert.equal(listing.nextPageToken,'next');assert.match(decodeURIComponent(visits.find(v=>v.url.includes('/files?')).url),/folder1/);
 const download=await googleAction({...base,action:'download',fileId:'file1',expectedRevision:'7'});assert.equal(await download.blob.text(),'test');
 await assert.rejects(googleAction({...base,action:'download',fileId:'file1',expectedRevision:'old'}),/변경/);
 const upload=await googleAction({...base,action:'upload',replaceId:'file1',expectedRevision:'7',name:'자료.txt',mime:'text/plain'},new Blob(['test']));assert.equal(upload.revision,'8');
 const init=visits.find(v=>v.options.method==='PATCH');assert.equal(init.options.headers['If-Match'],'"etag-7"');assert.ok(visits.some(v=>v.options.method==='PUT'&&v.options.body instanceof Blob));
 await assert.rejects(googleAction({...base,target:{...base.target,projectId:'other'},action:'list'}),/범위/);
});
