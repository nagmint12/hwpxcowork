export const DOORAY_PROJECT = '1234567890123456789'; // 테스트용 ID, 제품에 포함하지 않는다.
export function discover(drive, user, id = DOORAY_PROJECT) {
  const j = drive.create(user, { provider: 'dooray', projectId: 'personal', folderId: 'root', action: 'projects' });
  const { job } = drive.claim(user);
  drive.finish(user, j.id, job.claim, { result: { projects: [{ id, driveId: '9876543210123456789', type: 'private' }] } });
  drive.deliver(user, j.id);
}
export async function discoverHttp(api, bridge, id = DOORAY_PROJECT) {
  const j = await api('/api/drive/jobs', { method: 'POST', body: { provider: 'dooray', projectId: 'personal', folderId: 'root', action: 'projects' } });
  const { job } = await (await bridge('/jobs')).json();
  const response = await bridge(`/jobs/${j.id}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-drive-claim': job.claim }, body: JSON.stringify({ result: { projects: [{ id, driveId: '9876543210123456789', type: 'private' }] } }) });
  if (!response.ok) throw new Error('Test discovery failed: ' + response.status);
  await api('/api/drive/jobs/' + j.id);
}
