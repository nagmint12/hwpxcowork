import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ID, problem, productModule, restRequest, verifyProduct } from './connection.mjs';

const maxHwpxBytes = 300 * 1024 * 1024; // The product's existing HWPX request limit.
const maxJsonBytes = 16 * 1024 * 1024;
const exportKinds = new Set(['export', 'working', 'tracked', 'final', 'version']);
const linkUnavailable = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EPERM']);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export async function openWorkspace(dir) {
  if (!dir) throw problem('WORK_DIR_REQUIRED', '파일에는 --work-dir로 명시한 기존 작업 폴더가 필요합니다.');
  const root = await fs.realpath(dir);
  if (!(await fs.stat(root)).isDirectory()) throw problem('BAD_WORK_DIR', '--work-dir는 폴더여야 합니다.');
  function pathWithin(given) {
    if (!given || typeof given !== 'string') throw problem('BAD_PATH', '파일 경로를 지정하세요.');
    const target = path.resolve(root, given);
    if (!inside(root, target)) throw problem('OUTSIDE', '작업 폴더 밖의 파일은 사용할 수 없습니다.');
    if (process.platform === 'win32' && path.relative(root, target).includes(':')) {
      throw problem('BAD_PATH', 'Windows 파일 경로에 데이터 스트림 또는 예약된 구분자를 사용할 수 없습니다.');
    }
    return target;
  }
  async function read(given, limit) {
    const target = pathWithin(given);
    const real = await fs.realpath(target);
    if (!inside(root, real)) throw problem('OUTSIDE', '작업 폴더 밖으로 연결된 파일은 사용할 수 없습니다.');
    const file = await fs.open(real, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw problem('NOT_FILE', '일반 파일을 지정하세요.');
      if (!stat.size) throw problem('EMPTY_FILE', '빈 파일입니다.');
      if (stat.size > limit) throw problem('FILE_TOO_LARGE', '파일 크기 한도를 초과했습니다.');
      const bytes = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await file.read(bytes, offset, stat.size - offset, offset);
        if (!bytesRead) throw problem('FILE_CHANGED', '읽는 동안 파일 크기가 바뀌었습니다.');
        offset += bytesRead;
      }
      const current = await file.stat();
      if (stat.mtimeMs !== current.mtimeMs || stat.size !== current.size) throw problem('FILE_CHANGED', '읽는 동안 파일이 바뀌었습니다.');
      return bytes;
    } finally { await file.close(); }
  }
  async function destination(given) {
    const target = pathWithin(given);
    const parent = await fs.realpath(path.dirname(target));
    if (parent !== root && !inside(root, parent)) throw problem('OUTSIDE', '작업 폴더 밖으로 연결된 폴더에는 저장할 수 없습니다.');
    const real = path.join(parent, path.basename(target));
    try { await fs.lstat(real); } catch (error) {
      if (error.code === 'ENOENT') return real;
      throw error;
    }
    throw problem('OUTPUT_EXISTS', '출력 파일이 이미 있습니다. 새 파일 이름을 지정하세요.');
  }
  async function publish(target, bytes) {
    // Prefer publishing the completed temporary file atomically.
    const dir = path.dirname(target);
    if (await fs.realpath(dir) !== dir) throw problem('OUTSIDE', '출력 폴더가 바뀌었습니다.');
    const pending = path.join(dir, '.hwpx-cli-' + randomUUID() + '.tmp');
    const file = await fs.open(pending, 'wx', 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try {
        await fs.link(pending, target);
      } catch (error) {
        const windowsUnsupported = process.platform === 'win32' && ['EINVAL', 'EISDIR'].includes(error.code);
        if (!linkUnavailable.has(error.code) && !windowsUnsupported) throw error;
        if (await fs.realpath(dir) !== dir) throw problem('OUTSIDE', '출력 폴더가 바뀌었습니다.');
        // The exclusive flag preserves files created by another process. For a
        // failed copy, Node attempts to remove only the destination it opened.
        await fs.copyFile(pending, target, fs.constants.COPYFILE_EXCL);
      }
    } catch (error) {
      if (error.code === 'EEXIST') throw problem('OUTPUT_EXISTS', '출력 파일이 이미 있습니다. 새 파일 이름을 지정하세요.');
      throw error;
    } finally { await fs.unlink(pending); }
  }
  return { read, destination, publish };
}

export function parseJson(value) {
  try { return JSON.parse(value.replace(/^\uFEFF/, '')); }
  catch { throw problem('INVALID_JSON', '올바른 JSON을 지정하세요.'); }
}

export async function readJson(workspace, file) {
  return parseJson((await workspace.read(file, maxJsonBytes)).toString('utf8'));
}

function hwpxName(file) {
  if (!file || !/\.hwpx$/i.test(file)) throw problem('NOT_HWPX', '.hwpx 파일을 지정하세요.');
}

function hwpxArchive(bytes) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw problem('NOT_HWPX', 'HWPX 압축 파일이 아닙니다.');
}

async function importDocument(connection, workspace, file) {
  hwpxName(file);
  const bytes = await workspace.read(file, maxHwpxBytes);
  hwpxArchive(bytes);
  const { safeFileName } = await productModule('bridge.js');
  const name = safeFileName(path.basename(file, path.extname(file)), '문서') + '.hwpx';
  const response = await restRequest(connection, '/api/docs', {
    method: 'POST', body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-space': 'private' },
  });
  const data = await response.json();
  if (typeof data?.id !== 'string' || !ID.test(data.id)) throw problem('BAD_RESPONSE', '서버가 가져온 문서 ID를 반환하지 않았습니다.');
  return { data, hash: sha256(bytes) };
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function exportDocument(connection, workspace, docId, output, kind, version, originalHash) {
  if (!docId || !ID.test(docId)) throw problem('BAD_DOC_ID', '올바른 문서 ID를 지정하세요.');
  if (!exportKinds.has(kind)) throw problem('BAD_KIND', '--kind는 export, working, tracked, final, version 중 하나입니다.');
  if ((kind === 'version') !== (version != null) || (version != null && !/^[1-9][0-9]*$/.test(version))) {
    throw problem('BAD_VERSION', '--kind version과 --version <기록 번호>를 함께 지정하세요.');
  }
  const query = new URLSearchParams({ kind, ...(version ? { n: version } : {}) });
  const response = await restRequest(connection, '/api/docs/' + docId + '/file?' + query);
  if (Number(response.headers.get('content-length')) > maxHwpxBytes) {
    await response.body?.cancel();
    throw problem('FILE_TOO_LARGE', '파일 크기 한도를 초과했습니다.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > maxHwpxBytes) throw problem('FILE_TOO_LARGE', '파일 크기 한도를 초과했습니다.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  hwpxArchive(bytes);
  const hash = sha256(bytes);
  if (originalHash && hash === originalHash) throw problem('UNCHANGED_FILE', '편집 뒤 바뀐 HWPX를 확인하지 못했습니다.');
  await workspace.publish(output, bytes);
  return {
    doc_id: docId, path: output, bytes: size, sha256: hash,
    kind: response.headers.get('x-export-kind') || kind,
    version: Number(response.headers.get('x-doc-version')) || null,
    ...(response.headers.has('x-export-fallback') ? { fallback: response.headers.get('x-export-fallback') } : {}),
  };
}

function requireSuccess(call) {
  if (!call.ok) throw problem(call.error.code, call.error.message, { result: call.result });
  return call.data;
}

function proposalIds(receipt) {
  const ids = new Set();
  for (const row of [...(receipt?.saved || []), ...(receipt?.structure ? [receipt.structure] : [])]) {
    if (Number.isSafeInteger(row.pid) && row.pid > 0) ids.add(row.pid);
    if (typeof row.pids !== 'string') continue;
    for (const range of row.pids.split(',')) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
      if (!match) throw problem('BAD_RESPONSE', '서버가 예상과 다른 제안 번호를 반환했습니다.');
      const from = Number(match[1]);
      const to = Number(match[2] || match[1]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || from > to || to - from > 10_000) {
        throw problem('BAD_RESPONSE', '서버가 확인할 수 없는 제안 번호 범위를 반환했습니다.');
      }
      for (let id = from; id <= to; id++) ids.add(id);
    }
  }
  return [...ids];
}

async function editFile({ connection, tools, workspace, file, output, ops, kind }) {
  for (const name of ['read', 'edit']) tools.describe(name);
  if (!Array.isArray(ops) || !ops.length || ops.length > 2000 || ops.some(op => !op || typeof op.op !== 'string')) {
    throw problem('BAD_ARGS', '--ops-file에는 하나 이상의 MCP edit 연산 JSON 배열이 필요합니다.');
  }
  if (ops.some(op => ['alternatives', 'withdraw'].includes(op.op) || op.apply_now === true)) {
    throw problem('BAD_ARGS', '파일 편집에는 한 결과를 만드는 연산을 지정하세요. 대안, 제안 거두기, 연산별 즉시 반영은 call edit에서 지정할 수 있습니다.');
  }
  if (!exportKinds.has(kind) || kind === 'version') throw problem('BAD_KIND', '파일 편집은 새 결과를 export, working, tracked 또는 final로 저장합니다.');
  const { data: document, hash } = await importDocument(connection, workspace, file);
  const docId = document.id;
  let receipt;
  let ids = [];
  const readProposals = async () => {
    const list = requireSuccess(await tools.call('read', { doc_id: docId, view: 'proposals' }));
    if (!Array.isArray(list)) throw problem('BAD_RESPONSE', '서버의 제안 상태를 확인하지 못했습니다.');
    return new Map(list.map(proposal => [proposal.pid, proposal.status]));
  };
  try {
    requireSuccess(await tools.call('read', { doc_id: docId, view: 'map' }));
    const edit = await tools.call('edit', { doc_id: docId, ops });
    receipt = edit.data;
    ids = proposalIds(receipt);
    requireSuccess(edit);
    let states = await readProposals();
    if (ids.some(id => !states.has(id))) throw problem('BAD_RESPONSE', '편집 응답의 제안을 서버에서 확인하지 못했습니다.');
    const remaining = ids.filter(id => states.get(id) !== 'applied');
    if (remaining.length) {
      if (remaining.some(id => states.get(id) !== 'pending')) throw problem('EDIT_INCOMPLETE', '반영할 제안 상태가 바뀌었습니다.');
      const pending = reason => ({
        ok: false, status: 'pending', error: { code: 'APPROVAL_PENDING', message: reason },
        data: { doc_id: docId, proposal_ids: ids, pending_ids: ids.filter(id => states.get(id) === 'pending'), receipt },
      });
      if (document.settings?.editMode !== 'realtime') return pending('문서함에 검토 제안을 남겼습니다. 승인 후 파일을 내보내세요.');
      if (!tools.items.some(tool => tool.name === 'apply_proposal')) return pending('현재 MCP 연결에 제안 반영 도구가 없습니다.');
      for (const id of remaining) {
        const apply = await tools.call('apply_proposal', { doc_id: docId, proposal_id: id });
        if (!apply.ok) {
          states = await readProposals();
          if (['FORBIDDEN', 'DIRECT_APPLY_FORBIDDEN'].includes(apply.error.code)) return pending(apply.error.message);
          requireSuccess(apply);
        }
      }
      states = await readProposals();
    }
    if (ids.some(id => states.get(id) !== 'applied')) throw problem('EDIT_INCOMPLETE', '모든 변경이 반영된 상태를 확인하지 못했습니다.');
    if (!ids.length && !receipt?.saved?.length) throw problem('UNCHANGED_FILE', '저장된 편집 결과를 확인하지 못했습니다.');
    const data = await exportDocument(connection, workspace, docId, output, kind, null, hash);
    return { ok: true, status: 'saved', data: { ...data, proposal_ids: ids, receipt } };
  } catch (error) {
    throw Object.assign(error, { data: { doc_id: docId, proposal_ids: ids, ...(receipt ? { receipt } : {}) } });
  }
}

export async function fileCommand(connection, workspace, command, parameters, options, openTools) {
  const [first, second] = parameters;
  const kind = options.kind || 'export';
  if (command === 'import' && parameters.length === 1 && !options.out && !options['ops-file'] && !options.kind && !options.version) {
    await verifyProduct(connection);
    const { data } = await importDocument(connection, workspace, first);
    return { ok: true, status: 'imported', data };
  }
  const output = second || options.out;
  if (!['edit', 'export'].includes(command) || !first || !output || parameters.length > 2 || (second && options.out)) {
    throw problem('BAD_USAGE', 'file import <입력>, file edit <입력> <출력> --ops-file <JSON>, file export <문서 ID> <출력>을 사용하세요.');
  }
  hwpxName(output);
  const destination = await workspace.destination(output);
  if (command === 'export') {
    if (options['ops-file']) throw problem('BAD_USAGE', 'file export에서는 --ops-file을 사용하지 않습니다.');
    await verifyProduct(connection);
    const data = await exportDocument(connection, workspace, first, destination, kind, options.version);
    return { ok: true, status: 'saved', data };
  }
  if (!options['ops-file'] || options.version) throw problem('BAD_USAGE', 'file edit에는 --ops-file이 필요합니다.');
  hwpxName(first);
  const ops = await readJson(workspace, options['ops-file']);
  await verifyProduct(connection);
  const tools = await openTools(connection);
  try { return await editFile({ connection, tools, workspace, file: first, output: destination, ops, kind }); }
  finally { await tools.close(); }
}
