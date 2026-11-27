'use strict';
const { createHash } = require('node:crypto');

const API = 'https://api.github.com/repos/';
const ZIP_LIMIT = 50 * 1024 * 1024;
const HEADERS = { 'User-Agent': 'Agent-CLI-Hub', Accept: 'application/vnd.github+json' };
const TOPIC = 'agent-cli-hub-app';

function githubRepo(value) {
  const raw = String(value || '').trim();
  const repo = raw.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '');
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_-][a-z\d_.-]{0,99}$/i.test(repo)) {
    throw new Error('GitHub 저장소 주소는 owner/repository 형식이어야 합니다.');
  }
  return repo.toLowerCase();
}

function githubSource(value) {
  const raw = String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '');
  if (/^[a-z\d][a-z\d-]{0,38}$/i.test(raw)) return { owner: raw.toLowerCase() };
  return { repo: githubRepo(raw) };
}

async function discoverRepos(fetcher, owner) {
  const found = [];
  const signal = AbortSignal.timeout(15000);
  for (let page = 1; ; page++) {
    const r = await fetcher(`https://api.github.com/users/${owner}/repos?type=owner&per_page=100&page=${page}`, {
      headers: HEADERS, redirect: 'error', signal,
    });
    const repos = JSON.parse(await readLimited(r, 4 * 1024 * 1024));
    for (const repo of repos) {
      if (repo.private || repo.archived || !repo.topics?.includes(TOPIC)) continue;
      const fullName = githubRepo(repo.full_name);
      if (fullName.startsWith(owner + '/')) found.push({ repo: fullName, name: repo.name, description: repo.description });
    }
    if (!r.headers.get('link')?.includes('rel="next"')) return found;
  }
}

async function readLimited(response, maxBytes) {
  if (!response.ok) throw new Error(`GitHub 요청 실패 (HTTP ${response.status})`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('다운로드 용량 한도를 초과했습니다.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function latestPackage(fetcher, repo, assetName) {
  const response = await fetcher(API + repo + '/releases/latest', {
    headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const release = JSON.parse(await readLimited(response, 1024 * 1024));
  const assets = (release.assets || []).filter(a => a.state === 'uploaded' && /\.zip$/i.test(a.name));
  const portable = assets.filter(a => /-share-.*\.zip$/i.test(a.name));
  const candidates = assetName ? assets.filter(a => a.name === assetName) : portable.length ? portable : assets;
  if (candidates.length !== 1) throw new Error('릴리스에 설치할 ZIP을 하나 올리거나 카탈로그에서 파일 이름을 지정하세요.');
  const asset = candidates[0];
  if (!/^sha256:[a-f\d]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > ZIP_LIMIT) {
    throw new Error('ZIP의 SHA-256 또는 크기를 확인할 수 없습니다.');
  }
  return { repo, version: release.tag_name, asset: asset.name, digest: asset.digest, download: asset.browser_download_url };
}

async function downloadPackage(fetcher, pkg) {
  let url = new URL(pkg.download);
  if (url.origin !== 'https://github.com' || !url.pathname.toLowerCase().startsWith('/' + pkg.repo + '/releases/download/')) {
    throw new Error('GitHub 릴리스 다운로드 주소가 올바르지 않습니다.');
  }
  const signal = AbortSignal.timeout(35000);
  for (let count = 0; count < 4; count++) {
    const response = await fetcher(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const zip = await readLimited(response, ZIP_LIMIT);
      if ('sha256:' + createHash('sha256').update(zip).digest('hex') !== pkg.digest) {
        throw new Error('릴리스 ZIP의 SHA-256이 일치하지 않습니다.');
      }
      return zip;
    }
    url = new URL(response.headers.get('location'), url);
    if (!['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'].includes(url.origin)) break;
  }
  throw new Error('GitHub 다운로드 경로를 확인할 수 없습니다.');
}
module.exports = { githubRepo, githubSource, discoverRepos, latestPackage, downloadPackage, readLimited };
