import fs from 'node:fs';
import path from 'node:path';
const archName = cpu => cpu === 0x100000c ? 'arm64' : cpu === 0x1000007 ? 'x64' : String(cpu);
const version = n => `${n >>> 16}.${n >>> 8 & 255}.${n & 255}`;
const numeric = s => s.split('.').reduce((n,v,i)=>n+Number(v)*[65536,256,1][i],0);
export function machoTargets(bytes, start = 0) {
  if (bytes.length < start + 4) return [];
  const be=bytes.readUInt32BE(start),le=bytes.readUInt32LE(start);
  if ([0xcafebabe,0xcafebabf].includes(be) || [0xcafebabe,0xcafebabf].includes(le)) {
    const little=[0xcafebabe,0xcafebabf].includes(le),wide=(little?le:be)===0xcafebabf;
    const u32 = at => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
    const count=u32(start+4);if(count>16)throw Error('Invalid Mach-O slice count');
    const result=[];
    for(let i=0;i<count;i++){const at=start+8+i*(wide?32:20);const offset=wide?Number(little?bytes.readBigUInt64LE(at+8):bytes.readBigUInt64BE(at+8)):u32(at+8);result.push(...machoTargets(bytes,start+offset));}
    return result;
  }
  const little=[0xfeedface,0xfeedfacf].includes(le),magic=little?le:be;
  if(![0xfeedface,0xfeedfacf].includes(magic))return [];
  const u32=at=>little?bytes.readUInt32LE(start+at):bytes.readUInt32BE(start+at);
  const cpu=u32(4),count=u32(16);let at=magic===0xfeedfacf?32:28,min=null;
  if(count>10000)throw Error('Invalid Mach-O command count');
  for(let i=0;i<count;i++){const command=u32(at),size=u32(at+4);if(size<8||start+at+size>bytes.length)throw Error('Invalid Mach-O load command');if(command===0x32 && u32(at+8)===1)min=version(u32(at+12));if(command===0x24)min=version(u32(at+8));at+=size;}
  return [{arch:archName(cpu),minimumMacos:min}];
}
export function auditMacBinaries(root,{arch,target='12.1'}={}) {
  const required = arch === 'universal' ? ['x64', 'arm64'] : [arch];
  if (required.some(a => !['x64', 'arm64'].includes(a))) throw Error('Unsupported Mac architecture: ' + arch);
  const binaries=[];
  const visit=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){visit(file);continue;}
    const head=Buffer.alloc(4),fd=fs.openSync(file,'r');try{fs.readSync(fd,head,0,4,0);}finally{fs.closeSync(fd);}
    const macho=['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(head.toString('hex'));
    if(!macho){if(file.endsWith('.node'))throw Error('Non-Mac native module: '+file);continue;}
    const targets=machoTargets(fs.readFileSync(file));
    if(required.some(a=>!targets.some(t=>t.arch===a)))throw Error('Missing target architecture: '+file);
    for(const t of targets)if(!t.minimumMacos || numeric(t.minimumMacos)>numeric(target))throw Error(`macOS ${target} incompatible: ${file} ${t.arch} requires ${t.minimumMacos}`);
    binaries.push({file:path.relative(root,file).replaceAll('\\','/'),targets});
  }};
  visit(root);if(!binaries.length)throw Error('No Mach-O binaries audited');
  return {targetMacos:target,arch,binaries};
}
