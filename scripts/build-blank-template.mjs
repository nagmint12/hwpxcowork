// Reproduce the blank university standard document from the tutorial's verified styles.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HwpxDoc } from '../engine/doc.js';
import { Section } from '../engine/section.js';
import { elements, removeElements } from '../engine/page-layout.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildBlankTemplate() {
  const doc = await HwpxDoc.load(await fs.readFile(path.join(root, 'tutorial', '결과보고서.hwpx')));
  const sec = doc.sections[1] || doc.sections[0];
  const head = sec.xml.slice(0, sec.xml.indexOf('>', sec.xml.indexOf('<hs:sec')) + 1);
  let prop = elements(sec.xml, 'hp:secPr')[0].xml;
  prop = removeElements(prop, 'hp:masterPage').replace(/masterPageCnt="\d+"/, 'masterPageCnt="0"').replace(/(<hp:startNum\b[^>]*\bpage=")\d+"/, '$10"');
  const style = doc.header.style({ id: '0' });
  const controlCharPr = sec.bodyParas[0].runs[0].charPr;
  const para = `<hp:p id="0" paraPrIDRef="${style.paraPr}" styleIDRef="${style.styleId}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${controlCharPr}">${prop}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run><hp:run charPrIDRef="${style.charPr}"><hp:t/></hp:run></hp:p>`;
  doc.sections = [new Section(head + para + '</hs:sec>', 0)];
  doc._rewriteSectionFiles();
  for (const name of [...doc.container.files.keys()]) if (/^(BinData\/|Preview\/)|^Contents\/(masterpage|chart)/i.test(name)) doc.container.remove(name);
  let hpf = removeElements(doc.container.getText('Contents/content.hpf'), 'opf:item', e => /^(BinData\/|Preview\/)|^Contents\/(masterpage|chart)/i.test(e.attrs.href || ''));
  for (const tag of ['dc:title', 'dc:subject', 'dc:creator', 'dc:description', 'dc:lastsaveby', 'dc:date']) hpf = removeElements(hpf, tag);
  doc.container.setText('Contents/content.hpf', hpf);
  doc.container.setText('META-INF/container.rdf', '<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2011/meta#Section"/></rdf:Description></rdf:RDF>');
  doc.container.setText('settings.xml', '<?xml version="1.0" encoding="UTF-8"?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>');
  doc.header.xml = doc.header.xml.replace(/<hh:trackChanges\b[\s\S]*?<\/hh:trackChanges>/g, '<hh:trackChanges itemCnt="0"/>').replace(/<hh:trackChangeAuthors\b[\s\S]*?<\/hh:trackChangeAuthors>/g, '<hh:trackChangeAuthors itemCnt="0"/>');
  return doc.save();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = await buildBlankTemplate();
  await fs.writeFile(path.join(root, 'server', 'templates', 'blank.hwpx'), bytes);
  process.stdout.write(`표준서식 빈 문서: ${bytes.length}B\n`);
}
