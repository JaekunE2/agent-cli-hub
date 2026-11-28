'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', '.output',
  '__pycache__', '.venv', 'venv', 'env', 'target', '.idea', '.vscode',
  'coverage', '.cache', '.turbo', '.svelte-kit', 'out', 'tmp',
]);

const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.astro',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.rb', '.swift', '.html', '.css',
]);

const SECRET_RULES = [
  { id: 'openai-key', severity: 'critical', title: 'OpenAI / API Secret Key 노출 의심', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/ },
  { id: 'anthropic-key', severity: 'critical', title: 'Anthropic API Key 노출 의심', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-pat', severity: 'critical', title: 'GitHub Personal Access Token 노출 의심', re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{24,}\b/ },
  { id: 'google-api-key', severity: 'critical', title: 'Google API Key 노출 의심', re: /\bAIzaSy[0-9A-Za-z_-]{28,}\b/ },
  { id: 'aws-access-key', severity: 'critical', title: 'AWS Access Key ID 노출 의심', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'hardcoded-secret', severity: 'warn', title: '하드코딩된 비밀번호/토큰 문자열 의심', re: /(?:api_?secret|jwt_?secret|private_?key|db_?password)\s*[:=]\s*['"`](?!your_|example|placeholder|xxx|<)[^'"`\s]{10,}['"`]/i },
];

function loadGitignorePatterns(rootDir) {
  const giPath = path.join(rootDir, '.gitignore');
  const rules = [];
  if (!fs.existsSync(giPath)) return rules;
  try {
    const raw = fs.readFileSync(giPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith('#') || clean.startsWith('!')) continue;
      rules.push(clean.replace(/\/+$/, '').replace(/^\.\//, ''));
    }
  } catch {}
  return rules;
}

function isIgnoredByGitignore(relPath, isDir, rules) {
  const norm = relPath.replace(/\\/g, '/');
  const base = path.posix.basename(norm);
  for (const r of rules) {
    if (!r.includes('/') && !r.includes('*')) {
      if (base === r || norm.split('/').includes(r)) return true;
    } else if (r.endsWith('/*')) {
      const prefix = r.slice(0, -2);
      if (norm.startsWith(prefix + '/')) return true;
    } else if (!r.includes('*')) {
      if (norm === r || (isDir && norm.startsWith(r + '/'))) return true;
    }
  }
  return false;
}

function classifyLayer(relPath, content, endpoints) {
  const low = relPath.replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(low);
  if (/(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[a-z0-9]+$/i.test(low)) return 'test';
  if (/\.md$/i.test(low) || /(?:^|\/)docs?\//.test(low)) return 'docs';
  if (/(?:package\.json|tsconfig|vite\.config|webpack|eslint|dockerfile|\.env|config\.)/i.test(base)) return 'config';
  if (endpoints.length > 0 || /(?:^|\/)(?:routes?|controllers?|endpoints?|api|server)\b/i.test(low)) return 'api';
  if (/(?:^|\/)(?:public|client|frontend|web|ui|views?|pages?|components?|screens?|widgets?)\b|\.(?:html|css|jsx|tsx|vue|svelte|astro)$/i.test(low)) return 'ui';
  if (/(?:sqlite|prisma|schema|model|store|repo|db|database|storage|migration)/i.test(low) || /projects\.json|writeFileSync|CREATE TABLE/i.test(content)) return 'data';
  return 'service';
}

function inferRoleSummary(relPath, layer, endpoints, calls, content) {
  const base = path.basename(relPath);
  const firstComment = content.match(/^\s*(?:\/\/|#|\/\*)\s*([^\n*]{6,90})/)?.[1]?.trim();
  if (firstComment && !/use strict|eslint|prettier/i.test(firstComment)) {
    return firstComment.replace(/\*\/$/, '').trim().slice(0, 80);
  }
  if (layer === 'api' && endpoints.length) {
    return `API 엔드포인트 ${endpoints.length}개 처리 (${endpoints.slice(0, 2).map((e) => e.path).join(', ')})`;
  }
  if (layer === 'ui' && calls.length) {
    return `화면 UI · 서버 API ${calls.length}개 호출`;
  }
  if (layer === 'ui') return `사용자 인터페이스 (${base})`;
  if (layer === 'data') return `데이터 저장소 · 스키마 관리`;
  if (layer === 'test') return `자동화 검증 테스트`;
  if (layer === 'config') return `프로젝트 환경 · 빌드 설정`;
  return `핵심 모듈 (${base})`;
}

function extractEndpoints(content, relPath) {
  const found = [];
  const seen = new Set();
  const addEp = (method, epPath, lineIdx) => {
    const clean = String(epPath || '').split('?')[0].trim();
    if (!clean || !clean.startsWith('/') || clean.length > 140) return;
    const key = `${method}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ method, path: clean, line: lineIdx + 1, file: relPath });
  };

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Express / Fastify / Hono: router.get('/api/...', ...) or app.post('/...')
    let m;
    const reExpress = /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;
    while ((m = reExpress.exec(l))) addEp(m[1].toUpperCase(), m[2], i);

    // Node http manual routing: p === '/api/...' or url.pathname.startsWith('/api/...')
    const reManual = /\b(?:p|path|pathname|url\.pathname)\s*===\s*['"`](\/[^'"`\s]+)['"`]/g;
    while ((m = reManual.exec(l))) {
      const meth = /req\.method\s*===\s*['"`](POST|PUT|DELETE|PATCH|GET)['"`]/i.exec(l)?.[1]?.toUpperCase() || 'ANY';
      addEp(meth, m[1], i);
    }

    // Python Flask / FastAPI: @app.get("/...") or @router.post("/...")
    const rePy = /@(?:app|router|bp)\.(get|post|put|patch|delete|route)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;
    while ((m = rePy.exec(l))) addEp(m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), m[2], i);
  }
  return found;
}

function extractApiCalls(content, relPath) {
  const calls = [];
  const seen = new Set();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    const reCall = /\b(?:fetch|api|axios\.(?:get|post|put|patch|delete)|axios)\s*\(\s*['"`](\/(?:api|auth|graphql)[^'"`\s?$]*)/gi;
    while ((m = reCall.exec(l))) {
      const p = m[1].replace(/\$\{.*$/, '');
      if (!seen.has(p)) {
        seen.add(p);
        calls.push({ path: p, line: i + 1, file: relPath });
      }
    }
  }
  return calls;
}

function extractImports(content, relPath, allRelSet, ext) {
  const imps = new Set();
  const dir = path.posix.dirname(relPath.replace(/\\/g, '/'));
  const tryResolve = (rawSpec) => {
    if (!rawSpec || !rawSpec.startsWith('.')) return null;
    const joined = path.posix.normalize(path.posix.join(dir, rawSpec));
    const candidates = [
      joined,
      `${joined}.js`, `${joined}.mjs`, `${joined}.ts`, `${joined}.tsx`, `${joined}.jsx`,
      `${joined}.py`, `${joined}/index.js`, `${joined}/index.ts`,
    ];
    for (const c of candidates) {
      if (allRelSet.has(c)) return c;
    }
    return null;
  };

  let m;
  const reImport = /(?:import\s+(?:[^'"]+\s+from\s+)?|require\s*\(\s*)['"`](\.[^'"`]+)['"`]/g;
  while ((m = reImport.exec(content))) {
    const resolved = tryResolve(m[1]);
    if (resolved && resolved !== relPath) imps.add(resolved);
  }
  // HTML <script src="/foo.js"> or <link href="/foo.css">
  if (ext === '.html') {
    const reTag = /<(?:script|link)[^>]+(?:src|href)\s*=\s*['"`]\/?([^'"`?#]+)['"`]/gi;
    while ((m = reTag.exec(content))) {
      const spec = m[1];
      const candidates = [spec, path.posix.join(dir, spec)];
      for (const c of candidates) {
        const norm = path.posix.normalize(c);
        if (allRelSet.has(norm)) { imps.add(norm); break; }
      }
    }
  }
  return [...imps];
}

function scanFloorplan(rootDir, opts = {}) {
  const maxFiles = opts.maxFiles || 450;
  if (!rootDir || typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
    return { exists: false, rootDir: rootDir || '', nodes: [], edges: [], parts: [], endpoints: [], health: { score: 100, issues: [] }, stats: { files: 0, lines: 0, endpoints: 0, edges: 0 } };
  }
  const resolvedRoot = path.resolve(rootDir);
  if (!fs.statSync(resolvedRoot, { throwIfNoEntry: false })?.isDirectory()) {
    return { exists: false, rootDir: resolvedRoot, nodes: [], edges: [], parts: [], endpoints: [], health: { score: 100, issues: [] }, stats: { files: 0, lines: 0, endpoints: 0, edges: 0 } };
  }

  const giRules = loadGitignorePatterns(resolvedRoot);
  const rawFiles = [];
  const stack = [{ abs: resolvedRoot, rel: '', depth: 0 }];
  let hasEnvFile = false;
  let envIgnored = false;

  while (stack.length && rawFiles.length < maxFiles) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur.abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      if (e.name === '.env' || e.name === '.env.local') {
        hasEnvFile = true;
        if (giRules.some((r) => /^\.?env/i.test(r) || r === '.env*')) envIgnored = true;
      }
      if (e.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(e.name) || DEFAULT_IGNORE_DIRS.has(e.name.toLowerCase())) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        if (isIgnoredByGitignore(rel, true, giRules)) continue;
        if (cur.depth < 6) stack.push({ abs: path.join(cur.abs, e.name), rel, depth: cur.depth + 1 });
      } else if (e.isFile()) {
        if (isIgnoredByGitignore(rel, false, giRules)) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXTS.has(ext) || e.name === 'package.json') {
          rawFiles.push({ abs: path.join(cur.abs, e.name), rel: rel.replace(/\\/g, '/'), name: e.name, ext });
          if (rawFiles.length >= maxFiles) break;
        }
      }
    }
  }

  const allRelSet = new Set(rawFiles.map((f) => f.rel));
  const nodes = [];
  const nodeById = new Map();
  const allEndpoints = [];
  const allCalls = [];
  const externalServices = new Set();
  const issues = [];
  let totalLines = 0;

  for (const f of rawFiles) {
    let content = '';
    let size = 0;
    try {
      const st = fs.statSync(f.abs);
      size = st.size;
      const fd = fs.openSync(f.abs, 'r');
      const buf = Buffer.alloc(Math.min(size, 524288));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      content = buf.toString('utf8');
    } catch { continue; }

    const lines = content ? content.split(/\r?\n/).length : 0;
    totalLines += lines;
    const endpoints = f.ext === '.json' ? [] : extractEndpoints(content, f.rel);
    const calls = f.ext === '.json' ? [] : extractApiCalls(content, f.rel);
    const layer = classifyLayer(f.rel, content, endpoints);
    const hasAuthCheck = /\b(?:authed|requireAuth|verifyToken|jwt|session|authenticate|isAuthenticated|x-token)\b/i.test(content);

    if (/\b(?:sqlite|prisma|supabase|firebase|mongoose|pg\b)/i.test(content)) externalServices.add('Database');
    if (/\bopenai|@anthropic-ai|gemini|codex\b/i.test(content)) externalServices.add('AI / LLM');
    if (/\btailscale|oauth|google\.com\/calendar\b/i.test(content)) externalServices.add('External Auth / Cloud');

    for (const ep of endpoints) {
      allEndpoints.push({ ...ep, hasAuth: hasAuthCheck });
    }
    for (const c of calls) allCalls.push(c);

    // Health checks per non-test, non-doc file
    if (layer !== 'test' && layer !== 'docs' && f.ext !== '.json') {
      const fileLines = content.split(/\r?\n/);
      for (let idx = 0; idx < fileLines.length; idx++) {
        const lineTxt = fileLines[idx];
        if (/placeholder|example|dummy|your[-_]|process\.env\.|CONFIG\.|test/i.test(lineTxt)) continue;
        for (const rule of SECRET_RULES) {
          if (rule.re.test(lineTxt)) {
            issues.push({
              id: `${rule.id}:${f.rel}:${idx + 1}`,
              severity: rule.severity,
              title: rule.title,
              file: f.rel,
              line: idx + 1,
              detail: `${f.rel}:${idx + 1}에서 민감 정보 패턴이 감지되었습니다. 환경 변수나 보안 설정 파일로 분리하는 것이 안전합니다.`,
              fixPrompt: `${f.rel} 파일의 ${idx + 1}번째 줄 주변에 하드코딩된 민감 정보/키가 있는지 확인하고, process.env 또는 안전한 로컬 설정 파일로 분리해 주세요.`,
            });
            break;
          }
        }
      }
      if (endpoints.length > 0 && !hasAuthCheck && !/^index\.html$/i.test(f.name)) {
        issues.push({
          id: `unauth-route:${f.rel}`,
          severity: 'warn',
          title: `인증/권한 검증 패턴이 보이지 않는 API 라우트 (${f.name})`,
          file: f.rel,
          line: endpoints[0].line,
          detail: `${endpoints.length}개 엔드포인트(${endpoints.slice(0, 3).map((e) => e.path).join(', ')})가 정의되어 있으나 파일 내부에서 토큰/세션 인증 함수가 감지되지 않았습니다.`,
          fixPrompt: `${f.rel}에 정의된 API 엔드포인트(${endpoints.slice(0, 4).map((e) => e.path).join(', ')})의 인증·인가 검사가 누락되지 않았는지 점검하고 필요한 미들웨어를 적용해 주세요.`,
        });
      }
      if (lines > 900) {
        issues.push({
          id: `large-file:${f.rel}`,
          severity: 'info',
          title: `대형 단일 파일 (${lines.toLocaleString()}줄 · 모듈 분리 권장)`,
          file: f.rel,
          line: 1,
          detail: `${f.rel} 파일이 ${lines.toLocaleString()}줄로 비대합니다. 기능 단위로 모듈을 분리하면 AI 작업 정확도와 유지보수성이 올라갑니다.`,
          fixPrompt: `${f.rel}(${lines}줄)의 책임을 점검해 독립적인 기능/도메인 모듈로 깔끔하게 분리 리팩터링해 주세요. 기존 동작과 테스트는 그대로 유지해야 합니다.`,
        });
      }
    }

    const node = {
      id: f.rel,
      name: f.name,
      relPath: f.rel,
      ext: f.ext,
      lines,
      size,
      layer,
      summary: inferRoleSummary(f.rel, layer, endpoints, calls, content),
      endpoints,
      calls,
      imports: [],
      importedBy: [],
      hasIssue: false,
    };
    node._content = content;
    nodes.push(node);
    nodeById.set(node.id, node);
  }

  // Resolve import & HTML dependency edges
  const edges = [];
  const edgeKeys = new Set();
  const pushEdge = (from, to, kind, label = '') => {
    if (!from || !to || from === to) return;
    const key = `${from}->${to}:${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind, label });
  };

  for (const n of nodes) {
    const imps = n.ext === '.json' ? [] : extractImports(n._content || '', n.relPath, allRelSet, n.ext);
    n.imports = imps;
    for (const target of imps) {
      const tNode = nodeById.get(target);
      if (tNode) {
        tNode.importedBy.push(n.id);
        pushEdge(n.id, target, 'import');
      }
    }
    delete n._content;
  }

  // Match frontend API calls to backend API endpoints!
  const matchedCalls = [];
  const unmatchedCalls = [];
  for (const c of allCalls) {
    const hits = allEndpoints.filter((ep) => c.path === ep.path || c.path.startsWith(ep.path + '/') || ep.path.startsWith(c.path));
    if (hits.length) {
      matchedCalls.push({ ...c, targets: hits.map((h) => h.file) });
      for (const h of hits) pushEdge(c.file, h.file, 'api', c.path);
    } else {
      unmatchedCalls.push(c);
    }
  }

  if (hasEnvFile && !envIgnored) {
    issues.push({
      id: 'env-gitignore',
      severity: 'critical',
      title: '.env 파일이 .gitignore에 등록되지 않았을 수 있습니다',
      file: '.gitignore',
      line: 1,
      detail: '작업 폴더에 .env 파일이 존재하지만 .gitignore에서 .env 패턴이 확인되지 않았습니다.',
      fixPrompt: '.gitignore 파일을 확인하고 .env 및 .env.* 파일이 Git에 커밋되지 않도록 규칙을 추가해 주세요.',
    });
  }

  const issueFileSet = new Set(issues.map((x) => x.file));
  for (const n of nodes) {
    if (issueFileSet.has(n.relPath)) n.hasIssue = true;
    const isTestOrCfg = n.layer === 'test' || n.layer === 'config';
    const isHubEntry = /^(server|index|app|main)\.(js|ts|mjs|cjs|py|go)$/i.test(n.name);
    const impScore = Math.max(0,
      (n.importedBy.length * 6) +
      (n.endpoints.length * 4) +
      Math.min(10, n.calls.length) +
      Math.min(10, n.imports.length * 1.5) +
      (isHubEntry ? 8 : 0) +
      (n.layer === 'api' ? 5 : n.layer === 'ui' ? 3 : 0) -
      (isTestOrCfg ? 10 : 0)
    );
    n.importanceScore = Math.round(impScore);
    n.importance = (!isTestOrCfg && impScore >= 16) ? 'core' : impScore >= 7 ? 'major' : 'support';
  }
  nodes.sort((a, b) => b.importanceScore - a.importanceScore || b.importedBy.length - a.importedBy.length || b.lines - a.lines);

  // Group into macro Parts (layers) for high-level Floorplan architecture view
  const LAYER_META = [
    { id: 'ui', title: '화면 · UI 레이어', desc: '브라우저 화면, 컴포넌트, 스타일' },
    { id: 'api', title: '서버 · API 게이트웨이', desc: 'HTTP 엔드포인트, 웹소켓, 라우팅' },
    { id: 'service', title: '비즈니스 로직 · 코어 모듈', desc: '에이전트 제어, 스캐너, 유틸리티' },
    { id: 'data', title: '데이터 · 저장소', desc: 'JSON 스토어, DB 스키마, 상태 영속화' },
    { id: 'test', title: '테스트 · 검증', desc: '단위/통합 테스트 스위트' },
    { id: 'config', title: '설정 · 문서', desc: '패키지 메타, 실행 스크립트, README' },
  ];

  const parts = [];
  for (const lm of LAYER_META) {
    const members = nodes.filter((n) => n.layer === lm.id || (lm.id === 'config' && n.layer === 'docs'));
    if (!members.length) continue;
    const epCount = members.reduce((s, m) => s + m.endpoints.length, 0);
    const callCount = members.reduce((s, m) => s + m.calls.length, 0);
    const issueCount = members.filter((m) => m.hasIssue).length;
    parts.push({
      id: lm.id,
      title: lm.title,
      desc: lm.desc,
      fileCount: members.length,
      lineCount: members.reduce((s, m) => s + m.lines, 0),
      epCount,
      callCount,
      issueCount,
      files: members.slice(0, 40).map((m) => m.relPath),
    });
  }

  // Dedupe issues & compute health score
  const seenIssue = new Set();
  const dedupedIssues = issues.filter((it) => {
    const k = `${it.id}`;
    if (seenIssue.has(k)) return false;
    seenIssue.add(k);
    return true;
  }).slice(0, 30);

  let score = 100;
  for (const it of dedupedIssues) {
    score -= it.severity === 'critical' ? 22 : it.severity === 'warn' ? 8 : 3;
  }
  score = Math.max(20, score);

  return {
    exists: true,
    rootDir: resolvedRoot,
    scannedAt: Date.now(),
    nodes: nodes.slice(0, 120),
    edges: edges.slice(0, 300),
    parts,
    endpoints: allEndpoints.slice(0, 120),
    externalServices: [...externalServices],
    health: {
      score,
      criticalCount: dedupedIssues.filter((x) => x.severity === 'critical').length,
      warnCount: dedupedIssues.filter((x) => x.severity === 'warn').length,
      infoCount: dedupedIssues.filter((x) => x.severity === 'info').length,
      issues: dedupedIssues,
    },
    stats: {
      files: nodes.length,
      lines: totalLines,
      endpoints: allEndpoints.length,
      apiCalls: allCalls.length,
      matchedCalls: matchedCalls.length,
      edges: edges.length,
    },
  };
}

module.exports = { scanFloorplan, extractEndpoints, extractApiCalls, classifyLayer };
