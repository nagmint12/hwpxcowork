import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';

// Matches the request body limit of the existing HWPX upload route.
const maxHwpxBytes = 300 * 1024 * 1024;
const isHwpx = value => typeof value === 'string' && /\.hwpx$/i.test(value);

export function officeFileArguments(args, workingDirectory) {
  const paths = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--mode', '--verification-profile', '--user-data-dir'].includes(value)) { index++; continue; }
    if (!value.startsWith('-') && isHwpx(value)) paths.push(path.resolve(workingDirectory, value));
  }
  return paths;
}

export async function openOfficeFile(filePath) {
  if (!path.isAbsolute(filePath) || !isHwpx(filePath)) throw Error('HWPX 파일을 선택해 주세요.');
  const canonical = await realpath(filePath);
  const handle = await open(canonical, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) throw Error('내용이 있는 HWPX 파일을 선택해 주세요.');
    if (info.size > maxHwpxBytes) throw Error('300 MB 이하인 HWPX 파일을 선택해 주세요.');
    const source = createHash('sha256').update(canonical).digest('hex');
    return {
      name: path.basename(filePath), source, size: info.size,
      stream: () => handle.createReadStream({ start: 0, end: info.size - 1, highWaterMark: 1024 * 1024, autoClose: false }),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
