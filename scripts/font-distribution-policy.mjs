// Build/package gate. This module itself is not a server runtime dependency.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const policy=JSON.parse(fs.readFileSync(new URL('./font-distribution-policy.json',import.meta.url),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const knownNames=new Set(policy.excludedFingerprints.map(r=>r.name.toLowerCase()));
const retired=Buffer.from('{"schema":1,"primary":{"version":2022,"defaults":');
export function createFontDistributionGuard({excluded=policy.excludedFingerprints,approved=policy.approvedAssets,sourceBytes=[]}={}){
 const denied=new Set(excluded.map(r=>r.sha256)),sizes=new Set(excluded.map(r=>r.bytes)),allowed=new Set(approved.map(r=>r.sha256));
 return function check(relative,bytes){
  const name=relative.replaceAll('\\','/'),base=name.split('/').at(-1).toLowerCase();
  if(/(^|\/)(fontdb|fontdata)(\/|$)|(^|\/)fonts\/hft(\/|$)/i.test(name)||base.endsWith('.hft')||knownNames.has(base))throw Error(`Offline font source cannot ship: ${name}`);
  if(sizes.has(bytes.length)&&denied.has(sha(bytes)))throw Error(`Copied font source fingerprint: ${name}`);
  if(/\.(?:ttf|otf|ttc|otc|woff2?)$/i.test(base)&&!allowed.has(sha(bytes)))throw Error(`Font asset has no approved distribution fingerprint: ${name}`);
  if(bytes.includes(retired)||bytes.includes(Buffer.from('cowork.font-source-audit')))throw Error(`Offline/retired source catalogue cannot ship: ${name}`);
  for(const raw of sourceBytes)if(bytes.includes(raw)||bytes.includes(Buffer.from(raw.toString('base64'))))throw Error(`Embedded unchanged font source: ${name}`);
 };
}
let guard;
export function assertFontDistributionEntry(relative,bytes){
 if(!guard){
  const folder=path.join(root,'FontDB'),sourceBytes=fs.existsSync(folder)?fs.readdirSync(folder).filter(n=>/\.(dat|ini)$/i.test(n)).map(n=>fs.readFileSync(path.join(folder,n))):[];
  guard=createFontDistributionGuard({sourceBytes});
 }
 guard(relative,bytes);
}
export async function assertFontDistributionTree(folder){
 let files=0;
 async function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error(`Symlink not allowed in font audit: ${p}`);
  if(e.isDirectory())await walk(p);else if(e.isFile()){await assertFontDistributionBundle(path.relative(folder,p),fs.readFileSync(p));files++;}
 }}
 await walk(folder);return {files};
}
const isZip=b=>b.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(b.readUInt32LE(0));
export async function assertFontDistributionBundle(name,bytes){
 assertFontDistributionEntry(name,bytes);
 if(isZip(bytes))return assertFontDistributionZip(bytes,{prefix:name+'!'});
 return {entries:0};
}
export async function assertFontDistributionZip(bytes,{prefix='',depth=0}={}){
 const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(bytes);let entries=0;
 for(const e of Object.values(zip.files)){
  if(e.dir)continue;const name=prefix+e.name,body=await e.async('nodebuffer');assertFontDistributionEntry(name,body);entries++;
  if(isZip(body)){
   if(depth>=3)throw Error(`Nested archive exceeds audit depth: ${name}`);
   entries+=(await assertFontDistributionZip(body,{prefix:name+'!',depth:depth+1})).entries;
  }
 }
 return {entries};
}
