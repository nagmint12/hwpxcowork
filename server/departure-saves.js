import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './store.js';
import { ServiceError } from './service.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const day = 24 * 60 * 60 * 1000;

// Only a departure save passes through this journal. A receipt covers the actual
// uploaded bytes and the original optimistic concurrency parameters. Tokens are
// never persisted. Workers use the ordinary edit service and its document lock.
export class DepartureSaves {
  constructor({ directory, apply, track = fn => fn() }) {
    this.directory = directory;
    this.apply = apply;
    this.track = track;
    this.jobs = new Map();
    this.active = new Map();
    this.recovery = new Map();
    this.tail = Promise.resolve();
  }

  file(key, extension) {
    if (typeof key !== 'string' || !uuid.test(key)) throw new ServiceError('BAD_RECEIPT', '저장 접수 번호가 올바르지 않습니다.');
    return path.join(this.directory, key + extension);
  }

  record(key) {
    try { return JSON.parse(fs.readFileSync(this.file(key, '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  write(record) {
    writeFileAtomic(this.file(record.key, '.json'), JSON.stringify(record));
    if (record.state === 'failed') this.recovery.set(record.key, record);
  }

  failedCopies(doc, owner) {
    return [...this.recovery.values()].filter(r => r.doc === doc && r.owner === owner)
      .map(r => ({ key: r.key, time: r.time, message: r.problem.message }));
  }

  pending(doc, owner) {
    return [...this.active.values()].filter(r => r.doc === doc && r.owner === owner).map(r => r.key);
  }

  owned(key, doc, owner) {
    const record = this.record(key);
    if (!record || record.doc !== doc || record.owner !== owner) throw new ServiceError('NO_RECEIPT', '저장 접수 내역을 찾지 못했습니다.', 404);
    return record;
  }

  accept(key, request, bytes) {
    const existing = this.record(key);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (existing) {
      this.owned(key, request.doc, request.owner);
      if (existing.digest !== digest || JSON.stringify(existing.args) !== JSON.stringify(request.args) || existing.mode !== request.mode)
        throw new ServiceError('RECEIPT_CHANGED', '같은 접수 번호의 문서 내용이나 기준이 바뀌었습니다.', 409);
      this.start(existing);
      return;
    }
    if (!bytes.length) throw new ServiceError('EMPTY', '저장할 문서가 비었습니다.');
    fs.mkdirSync(this.directory, { recursive: true });
    writeFileAtomic(this.file(key, '.hwpx'), bytes);
    const record = { key, ...request, digest, time: Date.now(), state: 'queued' };
    try { this.write(record); }
    catch (error) { fs.rmSync(this.file(key, '.hwpx'), { force: true }); throw error; }
    this.start(record);
  }

  start(record) {
    if (record.state !== 'queued' || this.jobs.has(record.key)) return;
    this.active.set(record.key, record);
    const job = this.tail.then(() => new Promise(resolve => setImmediate(resolve))).then(() => this.track(async () => {
      try {
        const bytes = await fs.promises.readFile(this.file(record.key, '.hwpx'));
        if (createHash('sha256').update(bytes).digest('hex') !== record.digest)
          throw new ServiceError('RECEIPT_DAMAGED', '서버의 접수본 무결성을 확인할 수 없습니다.', 500);
        // A crash after this transition leaves a recovery copy. Replaying an
        // ambiguous live merge could overwrite a newer collaborator's edit.
        record.state = 'applying';
        this.write(record);
        record.result = await this.apply(record, bytes);
        record.state = 'saved';
      } catch (error) {
        record.state = 'failed';
        record.problem = { code: error.code || 'SAVE_FAILED', message: error.message,
          status: error.status || 500, extra: error.extra };
      }
      this.write(record);
      if (record.state === 'saved') await fs.promises.rm(this.file(record.key, '.hwpx'), { force: true });
    })).finally(() => { this.jobs.delete(record.key); this.active.delete(record.key); });
    this.jobs.set(record.key, job);
    this.tail = job.catch(() => {});
    job.catch(error => console.error('[departure-save]', error.message));
  }

  resume() {
    if (!fs.existsSync(this.directory)) return;
    const records = [];
    for (const name of fs.readdirSync(this.directory)) {
      const key = name.slice(0, -5);
      if (!name.endsWith('.json') || !uuid.test(key)) continue;
      try {
        const record = this.record(key);
        if (record?.key !== key) throw new Error('접수 번호가 일치하지 않습니다.');
        records.push(record);
      } catch (error) {
        console.error('[departure-save] 접수 기록을 복원하지 못했습니다.', key, error.message);
      }
    }
    records.sort((a, b) => a.time - b.time);
    for (const record of records) {
      if (record.state === 'applying') {
        record.state = 'failed';
        record.problem = { code: 'SAVE_INTERRUPTED', message: '서버 재시작으로 최종 반영 여부를 확인해야 합니다. 접수된 원본을 내려받을 수 있습니다.', status: 409 };
        this.write(record);
      } else if (record.state === 'failed') {
        this.recovery.set(record.key, record);
      } else if (record.state === 'saved' && Date.now() - record.time > day) {
        fs.rmSync(this.file(record.key, '.json'), { force: true });
        fs.rmSync(this.file(record.key, '.hwpx'), { force: true });
      } else this.start(record);
    }
  }

  async result(key, doc, owner) {
    this.owned(key, doc, owner);
    await this.jobs.get(key);
    const record = this.owned(key, doc, owner);
    if (record.state === 'saved') return record.result;
    const problem = record.problem || { code: 'SAVE_PENDING', message: '서버가 저장 접수본을 보관 중입니다.', status: 503 };
    throw new ServiceError(problem.code, problem.message, problem.status, { ...problem.extra, receipt: key });
  }
}
