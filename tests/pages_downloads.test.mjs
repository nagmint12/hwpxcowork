import assert from 'node:assert/strict';
import test from 'node:test';
import { pagesDownloads } from '../deploy/github-pages/downloads.mjs';

const releases = 'https://github.com/nagmint12/hwpxcowork/releases';
const names = ['HwpxCowork-Setup-1.2.3.exe', 'hwpx-cowork-macos-editor-2.0.0.zip', 'hwpx-cowork-3.0.0.apk'];
const assets = names.map(name => ({ name, size: 100, browser_download_url: releases + '/download/v123/' + name }));

test('Pages links identify tagged release assets and keep the installer manifest on the Pages origin', () => {
  const { links, packages } = pagesDownloads({ tag_name: 'v123', assets }, '/project/');
  assert.equal(links.get('/download'), releases + '/latest');
  assert.equal(links.get('/download/release.json'), '/project/personal-downloads.json');
  for (const [i, os] of ['windows', 'mac', 'android'].entries()) assert.equal(links.get('/download#' + os), assets[i].browser_download_url);
  assert.deepEqual(packages.map(p => p.file), names);
});

test('offline builds and platforms with no unique asset link to GitHub’s latest release', () => {
  assert.equal(pagesDownloads(null, '/').links.get('/download#windows'), releases + '/latest');
  assert.equal(pagesDownloads({ tag_name: 'v123', assets: [assets[1], assets[1]] }, '/').links.get('/download#mac'), releases + '/latest');
  assert.throws(() => pagesDownloads({ tag_name: 'v123', assets: [{ ...assets[0], browser_download_url: 'https://example.com/file.exe' }] }, '/'));
});
