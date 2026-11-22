import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { normSvg, renderSvg } from '../../server/figure-svg.js';
import { normChart, renderChart } from '../../server/chart.js';
export async function buildSeed(root, target) {
  const zip = new JSZip();
  const add = name => zip.file(name, fs.readFileSync(path.join(root, name)), { createFolders: false });
  for (const file of ['결과보고서.hwpx', 'AI 연결 — 사용자 가이드.hwpx', 'AI 활용 심화 — 연습 보고서.hwpx',
    '재수강 경험자 설문 결과(가상).xlsx', '보고서 작성 규칙(예시).skill', 'report-answers.json', 'ai-advanced-answers.json']) add('tutorial/' + file);
  add('docs/manuals/manifest.json');
  const manuals = JSON.parse(fs.readFileSync(path.join(root, 'docs/manuals/manifest.json'), 'utf8'));
  for (const { file } of manuals.documents) {
    if (path.basename(file) !== file || !file.endsWith('.hwpx')) throw Error('잘못된 설명서 파일 이름');
    add('docs/manuals/' + file);
  }
  add('server/templates/blank.hwpx');
  for (const name of ['AI_작성지침.md', '서식명세.md']) add('skill/hwpx-standard-report/reference/' + name);
  const answers = JSON.parse(fs.readFileSync(path.join(root, 'tutorial/ai-advanced-answers.json'), 'utf8'));
  for (const step of Object.values(answers.steps)) for (const call of step.calls || []) {
    if (call.name !== 'propose_figure') continue;
    const { svg, chart, width_mm: widthMm } = call.args;
    if (!svg && !chart) continue;
    const source = svg ? normSvg(svg) : JSON.stringify(normChart(chart));
    const name = 'figures/' + createHash('sha256').update(source).digest('hex');
    if (zip.file(name + '.png')) continue;
    const figure = svg ? await renderSvg(source, { widthMm }) : { png: await renderChart(JSON.parse(source)) };
    const { png, ...metadata } = figure;
    zip.file(name + '.png', png); zip.file(name + '.json', JSON.stringify(metadata));
  }
  fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
