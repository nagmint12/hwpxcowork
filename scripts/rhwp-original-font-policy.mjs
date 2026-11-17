// 원본 rhwp 글꼴과 사용자가 허용한 공식 CLI/Electron 내부 글꼴만 배포한다.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {assertFontDistributionEntry as checkSource} from './font-distribution-policy.mjs';
import {embeddedFontOffset,isFontAssetPath} from './font-free-downloads.mjs';
const original=JSON.parse(fs.readFileSync(new URL('./rhwp-original-fonts.json',import.meta.url),'utf8'));
const runtimes=JSON.parse(fs.readFileSync(new URL('./rhwp-approved-runtime-fonts.json',import.meta.url),'utf8'));
const known=new Map(original.fonts.map(f=>[f.sha256,f]));
const lengths=[...new Set(original.fonts.map(f=>f.bytes))];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const isZip=b=>b.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(b.readUInt32LE(0));
const signatures=new Set(['00010000','4f54544f','74746366','774f4646','774f4632','74727565','74797031']);
export function assertFontDistributionEntry(name,bytes){
  checkSource(name,bytes);
  const normalized=name.replaceAll('\\','/');
  if(runtimes.officialExecutables.some(e=>normalized.endsWith('/'+e.file)&&bytes.length===e.bytes&&sha(bytes)===e.sha256))return;
  if(isFontAssetPath(name)||signatures.has(bytes.subarray(0,4).toString('hex'))){
    if(!known.has(sha(bytes)))throw Error(`Font differs from original rhwp ${original.originalTag}: ${name}`);
    return;
  }
  let cursor=0;
  while(cursor<bytes.length){
    const relative=embeddedFontOffset(bytes.subarray(cursor));if(relative<0)break;
    const at=cursor+relative;
    const runtimeFonts=normalized.endsWith('/Electron Framework')?runtimes.embeddedFonts:[];
    const length=lengths.find(n=>at+n<=bytes.length&&known.has(sha(bytes.subarray(at,at+n))))
      ??runtimeFonts.find(f=>at+f.bytes<=bytes.length&&sha(bytes.subarray(at,at+f.bytes))===f.sha256)?.bytes;
    if(!length)throw Error(`Embedded font differs from original rhwp: ${name} at byte ${at}`);
    cursor=at+length;
  }
}
export async function assertFontDistributionBundle(name,bytes){
  assertFontDistributionEntry(name,bytes);
  return isZip(bytes)?assertFontDistributionZip(bytes,{prefix:name+'!'}):{entries:0};
}
export async function assertFontDistributionZip(bytes,{prefix='',depth=0}={}){
  const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(bytes);let entries=0;
  for(const e of Object.values(zip.files)){
    if(e.dir)continue;const name=prefix+e.name,body=await e.async('nodebuffer');assertFontDistributionEntry(name,body);entries++;
    if(isZip(body)){
      if(depth>=3)throw Error(`Nested archive exceeds font audit depth: ${name}`);
      entries+=(await assertFontDistributionZip(body,{prefix:name+'!',depth:depth+1})).entries;
    }
  }
  return {entries};
}
export async function assertFontDistributionTree(folder){
  let files=0;
  async function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error(`Symlink not allowed in font audit: ${p}`);
    if(e.isDirectory())await walk(p);else if(e.isFile()){await assertFontDistributionBundle(path.relative(folder,p),fs.readFileSync(p));files++;}
  }}
  await walk(folder);return {files};
}
