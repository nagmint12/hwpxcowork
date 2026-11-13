import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
export async function createDrivePackage(root) {
  const zip=new JSZip();const dir=path.join(root,'extensions','drive-bridge');
  for(const name of ['manifest.json','background.js','worker.js','popup.html','popup.js','bridge.html','bridge.js','runner.js','dooray.js','shared.js','style.css','README.txt'])zip.file(name,await fs.readFile(path.join(dir,name)));
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
