// 지우기 도우미. Node 24.11 의 Windows fs.rmSync(·rmdirSync recursive)는 폴더 경로에 한글 등 비ASCII 가 있으면
// try/catch 로 못 잡는 강제 종료(0xC0000409)로 프로세스를 죽인다(24.22·22.x 는 정상, 2026-10-30 실측).
// 서버를 '바탕 화면\새 폴더'·한글 사용자 폴더에 풀어도 문서 삭제·기록 정리에서 죽지 않게 unlink·rmdir 만 쓴다.
import fs from 'node:fs';
import path from 'node:path';

/** 파일 하나 지우기 — 없으면 조용히 넘어간다(rmSync force 와 같음) */
export function removeFile(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** 폴더(또는 파일)를 통째로 지우기 — 없으면 조용히 넘어간다. 심볼릭 링크는 따라가지 않고 링크만 지운다 */
export function removeTree(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isDirectory()) { removeFile(target); return; }
  for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
  fs.rmdirSync(target);
}
