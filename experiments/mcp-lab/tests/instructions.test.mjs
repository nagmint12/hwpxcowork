import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstructionStore, createInstructionTools, importAllowlistedSkill } from '../instructions.mjs';

const scope = { doc_id: 'doc1', request_id: 1 };
const create = () => createInstructionStore({ authorizeScope: async (user, item) => user === 'alice' && item.doc_id === 'doc1' && item.request_id === 1 });
const skill = { name: 'research', version: '1', source: 'client:research', instructions: '사용자가 고른 연구 방법\n원문 유지', references: [{ id: 'methods', text: '분석 방법 전체' }] };
const reject = (promise, code) => assert.rejects(promise, error => error.code === code);

test('explicit guidance preserves original instruction and full skill/reference content', async () => {
  const store = create();
  const registered = store.registerClientSkill('alice', skill);
  const original = '  원래 지시\r\n문장과 빈 줄을 보존합니다.\n\n';
  const metadata = await store.setTaskGuidance('alice', { ...scope, user_instruction: original, guidance: '선택 지침', selected_skills: [registered.skill_id] });
  assert.equal(metadata.state, 'selected');
  assert.equal(metadata.selected_skills[0].name, 'research');
  assert.equal('text' in metadata.user_instruction, false);
  assert.equal((await store.getInstructionContext('alice', { ...scope, view: 'instruction' })).text, original);
  assert.equal((await store.getInstructionContext('alice', { ...scope, view: 'reference', skill_id: registered.skill_id, reference_id: 'methods' })).text, '분석 방법 전체');
  const full = JSON.parse((await store.getInstructionContext('alice', { ...scope, view: 'full', limit: 16000 })).text);
  assert.equal(full.user_instruction, original);
  assert.equal(full.selected_skills[0].instructions, skill.instructions);
});

test('authorization is required and rechecked for every read/write, with no cross-user leakage', async () => {
  assert.throws(() => createInstructionStore(), error => error.code === 'AUTHORIZATION_REQUIRED');
  let authorized = true;
  const store = createInstructionStore({ authorizeScope: async user => user === 'alice' && authorized });
  const imported = store.registerClientSkill('alice', skill);
  await store.setTaskGuidance('alice', { ...scope, user_instruction: 'private', selected_skills: [imported.skill_id] });
  await reject(store.getInstructionContext('bob', scope), 'NOT_OWNER');
  await reject(store.setTaskGuidance('bob', { ...scope, user_instruction: 'overwrite' }), 'NOT_OWNER');
  const scoped = create();
  await reject(scoped.getInstructionContext('alice', { ...scope, doc_id: 'another-doc' }), 'NOT_OWNER');
  await reject(scoped.setTaskGuidance('alice', { ...scope, request_id: 2, user_instruction: 'wrong request' }), 'NOT_OWNER');
  authorized = false;
  await reject(store.getInstructionContext('alice', scope), 'NOT_OWNER');
  const both = createInstructionStore({ authorizeScope: async () => true });
  const owned = both.registerClientSkill('alice', skill);
  await reject(both.setTaskGuidance('bob', { ...scope, user_instruction: 'x', selected_skills: [owned.skill_id] }), 'SKILL_NOT_FOUND');
  assert.equal((await both.getInstructionContext('bob', scope)).state, 'not_set');
});

test('unknown/missing skill does not overwrite a valid selection; missing guidance is explicit', async () => {
  const store = create();
  assert.equal((await store.getInstructionContext('alice', scope)).state, 'not_set');
  await reject(store.getInstructionContext('alice', { ...scope, view: 'instruction' }), 'GUIDANCE_NOT_SET');
  await store.setTaskGuidance('alice', { ...scope, user_instruction: 'original' });
  await reject(store.setTaskGuidance('alice', { ...scope, user_instruction: 'lost', selected_skills: ['unknown'] }), 'SKILL_NOT_FOUND');
  assert.equal((await store.getInstructionContext('alice', { ...scope, view: 'instruction' })).text, 'original');
  await reject(store.getInstructionContext('alice', { ...scope, view: 'skill', skill_id: 'unknown' }), 'SKILL_NOT_SELECTED');
  await reject(store.getInstructionContext('alice', { ...scope, path: 'C:/private/SKILL.md' }), 'INVALID_ARGUMENT');
});

test('pagination reconstructs Unicode exactly, reports continuation and rejects changed snapshots', async () => {
  const store = create();
  const original = '가🙂나\n'.repeat(1201);
  await store.setTaskGuidance('alice', { ...scope, user_instruction: original });
  let offset = 0, text = '', hash;
  do {
    const page = await store.getInstructionContext('alice', { ...scope, view: 'instruction', offset, limit: 701, ...(hash ? { expected_sha256: hash } : {}) });
    hash = page.sha256;
    text += page.text;
    assert.equal(page.returned_chars, Array.from(page.text).length);
    assert.equal(page.complete, page.next_offset === null);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(text, original);
  await reject(store.getInstructionContext('alice', { ...scope, view: 'instruction', limit: 16001 }), 'INVALID_PAGE');
  await store.setTaskGuidance('alice', { ...scope, user_instruction: 'changed' });
  await reject(store.getInstructionContext('alice', { ...scope, view: 'instruction', expected_sha256: hash }), 'CONTENT_CHANGED');
});

test('model tool exposes one read-only tool and cannot select guidance or fetch arbitrary paths', async () => {
  const store = create();
  const result = createInstructionTools({ store, userId: 'alice' });
  assert.deepEqual(result.tools.map(tool => tool.name), ['get_task_guidance']);
  const tool = result.tools[0];
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  await reject(tool.handler({ ...scope, file_path: 'C:/private.txt' }), 'INVALID_ARGUMENT');
  const selected = store.registerClientSkill('alice', skill);
  await store.setTaskGuidance('alice', { ...scope, user_instruction: 'use selected skill', selected_skills: [selected.skill_id] });
  await reject(tool.handler({ ...scope, view: 'reference', skill_id: selected.skill_id, reference_id: '../../private.txt' }), 'REFERENCE_NOT_FOUND');
  await reject(tool.handler({ ...scope, view: 'reference', skill_id: selected.skill_id, reference_id: 'https://example.com/private' }), 'REFERENCE_NOT_FOUND');
});

test('launcher imports only allowlisted local text, with explicit references and no traversal', async () => {
  const root = await fs.mkdtemp(fileURLToPath(new URL('./.instructions-fixture-', import.meta.url)));
  try {
    const directory = path.join(root, 'skill');
    await fs.mkdir(path.join(directory, 'references'), { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), '# Research\n[not automatically read](secret.md)', 'utf8');
    await fs.writeFile(path.join(directory, 'references', 'methods.md'), 'explicit reference', 'utf8');
    await fs.writeFile(path.join(root, 'private.md'), 'not guidance', 'utf8');
    const store = create();
    const allowlist = { research: { directory, references: ['references/methods.md'] } };
    const registered = await importAllowlistedSkill({ store, userId: 'alice', skillId: 'research', allowlist });
    assert.equal(registered.origin, 'launcher_allowlist');
    assert.deepEqual(registered.references.map(ref => ref.id), ['references/methods.md']);
    await reject(importAllowlistedSkill({ store, userId: 'alice', skillId: directory, allowlist }), 'SKILL_NOT_ALLOWED');
    await reject(importAllowlistedSkill({ store, userId: 'alice', skillId: 'research', allowlist: { research: { directory, references: ['../private.md'] } } }), 'SKILL_PATH_OUTSIDE');
    await reject(importAllowlistedSkill({ store, userId: 'alice', skillId: 'research', allowlist: { research: { directory, references: ['missing.md'] } } }), 'SKILL_FILE_MISSING');
    await reject(importAllowlistedSkill({ store, userId: 'alice', skillId: 'missing', allowlist: { missing: { directory: path.join(root, 'missing') } } }), 'SKILL_FILE_MISSING');
    const empty = path.join(root, 'empty');
    await fs.mkdir(empty);
    await reject(importAllowlistedSkill({ store, userId: 'alice', skillId: 'empty', allowlist: { empty: { directory: empty } } }), 'SKILL_FILE_MISSING');
  } finally {
    const testDirectory = fileURLToPath(new URL('./', import.meta.url));
    const relative = path.relative(testDirectory, path.resolve(root));
    assert.ok(relative.startsWith('.instructions-fixture-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
