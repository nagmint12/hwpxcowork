// 과거의 '모든 글꼴 제외' 검사기. 후속 사용자 지시로 현재 배포는 rhwp-original-font-policy.mjs를 쓴다.
// 이름·매칭·폭·크기·기준선 표는 유지하며, 기존 FontDB/HFT 원본 차단도 함께 적용한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertFontDistributionEntry as checkSource } from './font-distribution-policy.mjs';
const policy=JSON.parse(fs.readFileSync(new URL('./font-distribution-policy.json',import.meta.url),'utf8'));
const known=new Set(policy.approvedAssets.map(p=>p.sha256));
const sizes=new Set(policy.approvedAssets.map(p=>p.bytes));
const signatures=new Set(['00010000','4f54544f','74746366','774f4646','774f4632','74727565','74797031']);
const isZip=b=>b.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(b.readUInt32LE(0));
export const isFontAssetPath=name=>/\.(?:ttf|otf|ttc|otc|woff2?|hft|eot|pf[abm]|fnt|fon)$/i.test(name);
// 확장자·파일 선두 검사로는 WASM data section의 include_bytes! OTF를 놓친다.
// [hwpx-cowork] 내부의 유효한 SFNT/WOFF 헤더·테이블을 검사하여 수치표의 우연한 일치는 제외한다.
export function embeddedFontOffset(bytes){
  let earliest=-1;
  for(const signature of signatures){
    const marker=Buffer.from(signature,'hex');
    for(let at=bytes.indexOf(marker);at>=0;at=bytes.indexOf(marker,at+1)){
      if(earliest>=0&&at>=earliest)break;
      if(at+12>bytes.length)continue;
      if(['4f54544f','00010000','74727565','74797031'].includes(signature)){
        const count=bytes.readUInt16BE(at+4);
        if(!count||count>256||at+12+count*16>bytes.length)continue;
        const tables=new Map();let valid=true;
        for(let i=0;i<count;i++){
          const row=at+12+i*16,tag=bytes.toString('ascii',row,row+4),offset=bytes.readUInt32BE(row+8),length=bytes.readUInt32BE(row+12);
          if(!/^[A-Za-z0-9 /]{4}$/.test(tag)||at+offset+length>bytes.length){valid=false;break;}
          tables.set(tag,{offset:at+offset,length});
        }
        const head=tables.get('head');
        if(valid&&tables.has('cmap')&&tables.has('maxp')&&head?.length>=54
          &&bytes.readUInt32BE(head.offset+12)===0x5f0f3cf5){earliest=at;break;}
      }else if(signature==='74746366'){
        const count=bytes.readUInt32BE(at+8);
        if(!count||count>4096||at+12+count*4>bytes.length)continue;
        const first=at+bytes.readUInt32BE(at+12);
        if(first+4<=bytes.length&&['00010000','4f54544f'].includes(bytes.subarray(first,first+4).toString('hex'))){earliest=at;break;}
      }else{
        const minimum=signature==='774f4632'?48:44;
        if(at+minimum>bytes.length)continue;
        const length=bytes.readUInt32BE(at+8),count=bytes.readUInt16BE(at+12),reserved=bytes.readUInt16BE(at+14);
        if(length>=minimum&&at+length<=bytes.length&&count>0&&count<=256&&reserved===0
          &&['00010000','4f54544f','74727565'].includes(bytes.subarray(at+4,at+8).toString('hex'))){earliest=at;break;}
      }
    }
  }
  return earliest;
}
export function assertFontDistributionEntry(name,bytes){
  checkSource(name,bytes);
  if(isFontAssetPath(name)||signatures.has(bytes.subarray(0,4).toString('hex'))
    ||(sizes.has(bytes.length)&&known.has(crypto.createHash('sha256').update(bytes).digest('hex')))){
    throw Error(`Actual font binaries cannot be downloaded: ${name}`);
  }
  const offset=embeddedFontOffset(bytes);
  if(offset>=0)throw Error(`Embedded font binary cannot be downloaded: ${name} at byte ${offset}`);
}
export async function assertFontDistributionBundle(name,bytes){
  assertFontDistributionEntry(name,bytes);
  return isZip(bytes)?assertFontDistributionZip(bytes,{prefix:name+'!'}):{entries:0};
}
export async function assertFontDistributionZip(bytes,{prefix='',depth=0}={}){
  const {default:JSZip}=await import('jszip'),zip=await JSZip.loadAsync(bytes);let entries=0;
  for(const e of Object.values(zip.files)){
    if(e.dir)continue;
    const name=prefix+e.name,body=await e.async('nodebuffer');assertFontDistributionEntry(name,body);entries++;
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
    const p=path.join(dir,e.name);
    if(e.isSymbolicLink())throw Error(`Symlink not allowed in font audit: ${p}`);
    if(e.isDirectory())await walk(p);
    else if(e.isFile()){await assertFontDistributionBundle(path.relative(folder,p),fs.readFileSync(p));files++;}
  }}
  await walk(folder);return {files};
}
