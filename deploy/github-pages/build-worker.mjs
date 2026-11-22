import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = path.join(dir, 'browser');
const root = path.resolve(dir, '../..');
const require = createRequire(import.meta.url);
const aliases = { fs: './browser/files.js', crypto: './browser/crypto.js', zlib: './browser/zlib.js', path: 'path-browserify', stream: 'readable-stream', events: 'events/', buffer: 'buffer/', util: 'util/', process: 'process/browser.js' };
const os = "export const homedir=()=>'/personal'; export const tmpdir=()=>'/tmp'; export const platform=()=>'browser'; export const endianness=()=>'LE'; export default {homedir,tmpdir,platform,endianness,EOL:'\\n', constants:{errno:{}}};";
const publicModules = {
  'node:os': os, os,
  'node:url': "export const fileURLToPath=url=>decodeURIComponent(new URL(url).pathname); export const pathToFileURL=path=>new URL('file://'+path);",
  'node:worker_threads': "export class Worker {constructor(){throw new Error('Native worker unavailable')}}",
  'node:child_process': "export function spawn(){throw new Error('Native process unavailable')} export const execFile=spawn;",
  'node:http': 'export default {};',
  'node:stream/promises': "export function pipeline(){throw new Error('Native stream unavailable')}",
};
const debug = `export const withAiDebug=(_,fn)=>fn(); export const debugRecord=()=>{}; export const debugError=e=>e?.message; export const debugServiceState=()=>null;
  export const currentAiDebug=()=>null; export const debugHttpResponse=r=>r; export const connectDebugTransport=(s,t)=>s.connect(t); export const debugStream=()=>null;`;
export async function buildWorker(output) {
  await build({ entryPoints: [path.join(browser, 'service.js')], outfile: output, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    legalComments: 'eof', inject: [path.join(browser, 'platform.js')], define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'personal-browser', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (publicModules[args.path]) return { path: args.path, namespace: 'platform' };
        const spec = args.path.replace(/^node:/, '');
        if (Object.hasOwn(aliases, spec)) return { path: require.resolve(aliases[spec]) };
        if (args.path.endsWith('/ai-debug.js')) return { path: 'debug', namespace: 'platform' };
        if (args.path.endsWith('/layout-check.js')) return { path: 'layout', namespace: 'platform' };
        if (args.path === './local.js' && args.importer.endsWith('library.js')) return { path: 'machine', namespace: 'platform' };
        if (args.path === 'unpdf') return { path: 'pdf', namespace: 'platform' };
        if (args.path === 'exceljs') return { path: require.resolve('exceljs/dist/exceljs.min.js') };
      });
      b.onLoad({ filter: /.*/, namespace: 'platform' }, args => ({ contents: publicModules[args.path] ?? ({
        debug, layout: 'export const enqueueLayoutCheck=()=>{}; export const takeLayoutNote=()=>null; export const layoutChecker=()=>null; export const pageEstimateEnabled=()=>false;',
        machine: 'export const isSameMachine=()=>false;',
        pdf: "export async function extractText(){throw new Error('PDF 본문 읽기는 설치판에서 제공합니다.')}",
      })[args.path] }));
      b.onLoad({ filter: /[\\/]studio[\\/]dist[\\/]rhwp\.js$/ }, args => ({
        contents: fs.readFileSync(args.path, 'utf8').replaceAll('import.meta.url', 'new URL("studio/rhwp.js", self.registration.scope).href'),
        loader: 'js', resolveDir: path.dirname(args.path),
      }));
      b.onLoad({ filter: /[\\/](server|engine)[\\/].*\.js$/ }, args => {
        if (!args.path.startsWith(root + path.sep) || args.path.includes(path.sep + 'node_modules' + path.sep)) return;
        let contents = fs.readFileSync(args.path, 'utf8');
        const relative = path.relative(root, args.path).split(path.sep).join('/');
        if (relative === 'server/toc-engine.js') {
          const start = contents.indexOf('let mod = null;'), end = contents.indexOf('class TocEngineError', start);
          if (start < 0 || end < 0) throw Error('편집기 엔진 초기화 코드를 확인하세요.');
          contents = contents.slice(0,start) + "import * as mod from '../studio/dist/rhwp.js'; const loadError=null;\n" + contents.slice(end);
        }
        if (relative === 'server/chart.js' || relative === 'server/figure-svg.js') {
          const kind = relative.includes('figure-svg') ? 'Svg' : 'Chart';
          const cut = contents.indexOf('export function render' + kind + '(');
          if (cut < 0) throw Error('튜토리얼 그림 생성기를 확인하세요.');
          contents = contents.slice(0,cut) + "export { render" + kind + " } from '../deploy/github-pages/browser/figures.js';";
        }
        return { contents: contents.replaceAll('import.meta.url', JSON.stringify('file:///project/' + relative)), resolveDir: path.dirname(args.path), loader: 'js' };
      });
    } }] });
}
