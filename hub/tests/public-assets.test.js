'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('every local script and stylesheet in the Hub entry page is served', () => {
  const hub = path.join(__dirname, '..');
  const entry = fs.readFileSync(path.join(hub, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(hub, 'server.js'), 'utf8');
  const routes = server.match(/const STATIC = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(routes, 'Missing static asset table');
  const files = new Map([...routes.matchAll(/'([^']+)':\s*'([^']+)'/g)].map(([, url, file]) => [url, file]));
  const aliases = server.match(/if \(p === '\/' \|\| STATIC\[p\]([^\n]+)\{/i)?.[1] || '';
  for (const [, url] of entry.matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css))"/g)) {
    const file = files.get(url) || (aliases.includes(`p === '${url}'`) && `public${url}`);
    assert.ok(file, `Missing HTTP route for ${url}`);
    assert.ok(fs.existsSync(path.join(hub, file)), `Missing asset for ${url}`);
  }
});
