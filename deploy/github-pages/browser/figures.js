import files from './files.js';
import { createHash } from './crypto.js';
function read(source) {
  const key = createHash('sha256').update(source).digest('hex');
  const base = '/project/figures/' + key;
  if (!files.existsSync(base + '.png')) throw Error('이 튜토리얼에 등록된 그림을 찾을 수 없습니다.');
  return { png: files.readFileSync(base + '.png'), ...JSON.parse(files.readFileSync(base + '.json', 'utf8')) };
}
export async function renderChart(chart) { return read(JSON.stringify(chart)).png; }
export async function renderSvg(source, { widthMm, maxWidthMm = 300 } = {}) {
  const image = read(source);
  return { ...image, widthMm: Math.min(maxWidthMm, widthMm || image.widthMm) };
}
