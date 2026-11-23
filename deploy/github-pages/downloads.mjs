const releases = 'https://github.com/nagmint12/hwpxcowork/releases';
const platforms = [
  ['windows', 'windows-app', /^HwpxCowork-Setup-[\w.-]+\.exe$/i],
  ['mac', 'macos-editor-universal', /^hwpx-cowork-macos-editor-[\w.-]+\.zip$/i],
  ['android', 'android-editor', /^hwpx-cowork-[\d.]+\.apk$/i],
];

export function pagesDownloads(release, base) {
  const latest = releases + '/latest';
  const links = new Map([['/download', latest], ['/download/release.json', base + 'personal-downloads.json']]);
  const packages = [];
  if (release && (!release.tag_name || !Array.isArray(release.assets))) throw Error('GitHub 릴리스 형식을 확인하세요.');
  const assetBase = release ? releases + '/download/' + encodeURIComponent(release.tag_name) + '/' : latest + '/download/';
  links.set('/download/', assetBase);
  for (const [os, target, pattern] of platforms) {
    const assets = (release?.assets ?? []).filter(asset => pattern.test(asset.name));
    // If a release has multiple platform variants, let the visitor choose on GitHub.
    const asset = assets.length === 1 ? assets[0] : null;
    if (asset && asset.browser_download_url !== assetBase + encodeURIComponent(asset.name)) throw Error('GitHub 설치 파일 주소를 확인하세요.');
    links.set('/download#' + os, asset?.browser_download_url ?? latest);
    if (asset) packages.push({ target, file: asset.name, bytes: asset.size });
  }
  return { links, packages };
}
