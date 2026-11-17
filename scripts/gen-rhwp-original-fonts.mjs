// rhwp v0.9.0 원본 Git blob과 작업 파일을 대조해 배포 지문을 생성한다.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const cwd=new URL('../vendor/rhwp/',import.meta.url),tag='v0.9.0';
const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_NO_LAZY_FETCH:'1'}}).trim();
const rows=git(['ls-tree','-r',tag,'--','assets/fonts']).split('\n'),fonts=[];
for(const row of rows){
  const [meta,path]=row.split('\t');if(!/\.(ttf|otf|ttc|otc|woff2?)$/i.test(path))continue;
  const blob=meta.split(' ')[2],bytes=fs.readFileSync(new URL('../vendor/rhwp/'+path,import.meta.url));
  const current=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  if(current!==blob)throw Error(`원본 rhwp와 다른 글꼴: ${path}`);
  fonts.push({path,bytes:bytes.length,gitBlob:blob,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
const data={schema:1,originalTag:tag,originalCommit:git(['rev-parse',tag+'^{commit}']),fonts};
fs.writeFileSync(new URL('./rhwp-original-fonts.json',import.meta.url),JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({originalTag:tag,fonts:fonts.length}));
