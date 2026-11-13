import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createLabRuntime } from './runtime.mjs';
import { createLabConnection } from './gateway.mjs';
import { seedLab } from './serve.mjs';

const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const unpack = response => { assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text); };

// Checks transmission of a real, explicitly selected skill. Does not claim the model followed it.
export async function verifyGuidance(skillDir) {
  if (!skillDir) throw new Error('An explicit skill directory is required.');
  const runtime = createLabRuntime(); let connection;
  try {
    const seed = await seedLab(runtime, { skillDir, instruction: '내가 선택한 교육연구 지침을 읽고 문서의 근거와 해석을 검토해줘.' });
    connection = await createLabConnection(runtime);
    const scope = { doc_id: seed.doc_id, request_id: seed.request_id };
    const request = unpack(await connection.call('get_request', scope));
    assert.equal(request.guidance.state, 'selected');
    const metadata = unpack(await connection.call('get_task_guidance', scope));
    assert.equal(metadata.selected_skills.length, 1);
    const skill = metadata.selected_skills[0], readings = [];
    const readAll = async (view, reference_id) => {
      let offset = 0, sha, combined = '', pages = 0;
      for (;;) {
        const part = unpack(await connection.call('get_task_guidance', { ...scope, view, skill_id: skill.skill_id,
          ...(reference_id ? { reference_id } : {}), offset, limit: 777, ...(sha ? { expected_sha256: sha } : {}) }));
        sha ||= part.sha256; combined += part.text; pages++;
        if (part.complete) break;
        assert.ok(part.next_offset > offset); offset = part.next_offset;
      }
      assert.equal(hash(combined), sha);
      const original = await fs.readFile(path.join(skillDir, reference_id || 'SKILL.md'), 'utf8');
      assert.equal(combined, original);
      readings.push({ resource: reference_id || 'SKILL.md', pages, chars: Array.from(combined).length, sha256: sha, exactMatch: true });
    };
    await readAll('skill');
    for (const ref of skill.references) await readAll('reference', ref.id);
    return { passed: true, check: 'explicit real skill transmission and exact Unicode pagination',
      skill: { name: skill.name, version: skill.version, source: skill.source }, readings,
      modelReasoningEvaluated: false, modelTokens: null, paidApiCalls: 0 };
  } finally { await connection?.close(); await runtime.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyGuidance(process.argv[2]);
    const report = fileURLToPath(new URL('./artifacts/real-guidance-report.json', import.meta.url));
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.writeFile(report, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed: result.passed, skill: result.skill.name, resources: result.readings.length, report }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
