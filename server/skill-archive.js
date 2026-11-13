// Archive paths never become local filesystem paths.
import JSZip from 'jszip';
const fail = message => Object.assign(new Error(message), { code: 'SKILL_RESOURCE' });
export async function openSkillArchive(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(f => !f.dir);
  if (files.length > 500) throw fail('스킬 파일은 500개까지 읽을 수 있습니다.');
  let total = 0;
  for (const f of files) {
    const original = f.unsafeOriginalName || f.name;
    if (original !== f.name || /(^\/|\\|(^|\/)\.\.?($|\/)|:)/.test(original)) throw fail('스킬 안에 안전하지 않은 경로가 있습니다.');
    total += f._data?.uncompressedSize || 0;
    if (total > 32 * 1048576) throw fail('스킬을 푼 크기가 32MB를 넘습니다.');
  }
  const mains = files.filter(f => /(^|\/)SKILL\.md$/i.test(f.name));
  if (mains.length !== 1) throw fail('SKILL.md가 하나 있는 스킬 묶음이 필요합니다.');
  const main = mains[0].name, root = main.slice(0, main.lastIndexOf('/') + 1);
  const resources = files.filter(f => f.name.startsWith(root)).map(f => ({ path: f.name.slice(root.length), size: f._data?.uncompressedSize || 0 }));
  return { resources, async read(resource = 'SKILL.md') {
    if (!resources.some(f => f.path === resource)) throw fail('스킬 안에 해당 자료가 없습니다.');
    const f = zip.file(root + resource);
    if (f._data.uncompressedSize > 8 * 1048576) throw fail('스킬 자료 하나는 8MB까지 읽을 수 있습니다.');
    const data = await f.async('nodebuffer');
    return { path: resource, bytes: data, text: /\.(md|txt|json|py|mjs|js|toml|yaml|yml|csv|xml|html|css)$/i.test(resource) ? new TextDecoder('utf-8', { fatal: true }).decode(data) : null };
  } };
}
export async function skillText(bytes) {
  const archive = await openSkillArchive(bytes), main = await archive.read();
  return { text: `${main.text}\n\n스킬 내부 자료(read_skill_resource의 resource로 읽기):\n${archive.resources.map(f => `${f.path} (${f.size}B)`).join('\n')}`, resources: archive.resources };
}
