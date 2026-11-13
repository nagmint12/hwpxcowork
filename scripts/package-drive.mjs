import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDrivePackage} from '../server/drive-package.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'artifacts');await fs.mkdir(dir,{recursive:true});
const out=path.join(dir,'cowork-drive-bridge.zip');await fs.writeFile(out,await createDrivePackage(root));console.log(out);
