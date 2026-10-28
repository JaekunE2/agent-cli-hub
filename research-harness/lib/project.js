// Research project scaffolding + registry, shared by the dashboard server and CLIs.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HARNESS = path.join(__dirname, '..');
function config() {
  const c = JSON.parse(fs.readFileSync(path.join(HARNESS, 'config.json'), 'utf8'));
  if (process.env.RH_PROJECTS_ROOT) c.projects_root = process.env.RH_PROJECTS_ROOT; // test instances
  c.projects_root = path.resolve(HARNESS, c.projects_root || '../research'); // relative → next to the harness
  return c;
}

// Templates carry placeholders so the harness works wherever it is installed:
// {{HARNESS}} this folder · {{CCD}} the dashboard CLI · {{SKILLS}} Claude Code skills folder ·
// {{NODE}} the node.exe running us · {{LOCAL_ENV}} this machine's rules (local-env.md)
function templateVars() {
  const cfg = config();
  const ccd = [path.join(HARNESS, '..', 'hub', 'ccd.js'), path.join(HARNESS, '..', 'cc-dashboard', 'ccd.js'), path.join(HARNESS, '..', 'dashboard', 'ccd.js')].find((p) => fs.existsSync(p)) || 'ccd.js';
  const v = {
    HARNESS, HARNESS_FWD: HARNESS.replace(/\\/g, '/'), CCD: ccd, NODE: process.execPath.replace(/\\/g, '/'),
    SKILLS: cfg.skills_dir ? path.resolve(cfg.skills_dir) : path.join(require('os').homedir(), '.claude', 'skills'),
  };
  let env = '';
  try { env = fs.readFileSync(path.join(HARNESS, 'local-env.md'), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '').trim(); } catch {}
  v.LOCAL_ENV = env || '- (no machine-specific rules: see local-env.md in the harness folder)';
  return v;
}
function renderTemplate(text, v = templateVars()) {
  const nodeCmd = /\s/.test(v.NODE) ? `"${v.NODE}"` : v.NODE;
  return text
    .replace(/\{\{LOCAL_ENV\}\}/g, () => v.LOCAL_ENV)
    // bare `node` in front of our tools → the node that runs the harness (recipients may have none on PATH)
    .replace(/\bnode ((?:--[\w-]+ )*)(?=\{\{(?:CCD|HARNESS)\}\})/g, (m, flags) => `${nodeCmd} ${flags}`)
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? v[k] : m));
}
// P10_submission is reached only when the user picks "투고 준비" on a finished study (goal = P10)
const PHASES = ['P1_ideation', 'P2_venue', 'P3_literature', 'P4_plan', 'P5_experiment', 'P6_analysis', 'P7_iterate', 'P8_writing', 'P9_review', 'P10_submission'];
const RESULTS = ['positive', 'negative', 'mixed'];

function slugify(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || `project-${Date.now().toString(36)}`;
}

// kind: 'new' | 'derived' (parents = [one finished study]) | 'synthesis' (parents = several finished studies)
function createProject({ name, direction, venue = '', root, approvalGates = [], goal = 'P9_review', kind = 'new', parents = [] }) {
  if (!PHASES.includes(goal) || goal === 'P10_submission') goal = 'P9_review';
  if (!['new', 'derived', 'synthesis'].includes(kind)) kind = 'new';
  const all = listProjects();
  const par = [...new Set(parents)].map((sl) => all.find((p) => p.state.slug === sl)).filter(Boolean);
  if (kind === 'derived' && par.length !== 1) throw new Error('파생 연구는 기반 연구 1개를 지정해야 합니다');
  if (kind === 'synthesis' && par.length < 2) throw new Error('종합 논문은 기반 연구를 2개 이상 지정해야 합니다');
  const cfg = config();
  root = root || cfg.projects_root;
  const slug = slugify(name);
  const dir = path.join(root, slug);
  if (fs.existsSync(dir)) throw new Error(`이미 있는 프로젝트 폴더: ${dir}`);
  const r = path.join(dir, 'research');
  for (const d of ['ideas', 'venue', 'lit', 'experiments', 'analysis', 'paper', 'reviews', 'workers']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.mkdirSync(path.join(dir, 'code'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

  const vars = templateVars();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), renderTemplate(fs.readFileSync(path.join(HARNESS, 'template', 'CLAUDE.md'), 'utf8'), vars));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), renderTemplate(fs.readFileSync(path.join(HARNESS, 'template', '.claude', 'settings.json'), 'utf8'), vars));

  const now = new Date().toISOString();
  const state = {
    version: 1, project: name, slug, created_at: now, updated_at: now,
    status: 'running', phase: 'P1_ideation', iteration: 0,
    next_action: 'BRIEF.md 분석 → 아이디어 후보 도출 (P1)',
    director_session_id: null, wake_at: null, wait_reason: '',
    gates: Object.fromEntries(PHASES.map((p) => [p, { passed: false, evidence: null }])),
    workers: [],
    budget: cfg.budget,
    config: { goal, venue_hint: venue || null, approval_gates: approvalGates, overleaf_remote: null },
    result: null, result_summary: null,
    lineage: kind === 'new' ? null : { kind, parents: par.map((p) => ({ slug: p.state.slug, name: p.state.project, dir: p.dir, result: p.state.result || null })) },
  };
  fs.writeFileSync(path.join(r, 'state.json'), JSON.stringify(state, null, 2));
  const w = (f, s) => fs.writeFileSync(path.join(r, f), s);
  w('BRIEF.md', `# 연구 브리프 (사용자 초기 방향)\n\n_작성: ${now}_\n\n## 방향\n${direction.trim()}\n${lineageBrief(kind, par)}\n## 목표 학회/저널 (선호)\n${venue || '(지정 없음 — P2에서 조사해 결정)'}\n\n## 이후 사용자 추가 지시\n(INBOX.md에서 처리 후 중요한 것은 여기에 요약)\n`);
  w('PLAN.md', `# 연구 계획\n\n(P1~P4에서 디렉터가 작성·갱신)\n`);
  w('JOURNAL.md', `# 연구 저널 (append-only)\n\n- ${now} 프로젝트 생성. 다음: P1 아이디어 도출\n`);
  w('DECISIONS.md', '# 자율 결정·가정 기록\n');
  w('FAILED.md', '# 실패한 접근 (재시도 금지 목록)\n');
  w('INBOX.md', '# 사용자 → 디렉터 메시지\n\n대시보드에서 보낸 메시지가 제목 줄 끝에 "안읽음" 표시(영문 unread를 괄호로)를 달고 쌓입니다. 처리하면 그 표시를 (read)로 바꾸세요.\n');
  w('QUESTIONS.md', '# 디렉터 → 사용자 질문/승인 요청\n');
  w('REPORT.md', `# 진행 보고 (게이트 통과 시 요약)\n\n## 사용자 참고\n(마감·제출 준비 등 알아두면 좋은 것 — 답을 기다리지 않음)\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.ckpt\n*.pt\n*.pth\n*.safetensors\ncheckpoints/\ndata/\nwandb/\n__pycache__/\n*.log\nresearch/.harness.log\nresearch/state.json.*.tmp\n');
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', windowsHide: true });
    git('init', '-q'); git('config', 'http.sslBackend', 'schannel');
    git('add', '-A'); git('commit', '-q', '-m', 'init: research project scaffold');
  } catch {}
  // record the child on its parents (dashboard shows the family)
  for (const p of par) { try { updateState(p.dir, (ps) => { ps.children = [...new Set([...(ps.children || []), slug])]; }); } catch {} }
  return { dir, slug, state };
}

// BRIEF section for derived / synthesis projects: where the parents' evidence lives (read-only)
function lineageBrief(kind, par) {
  if (kind === 'new' || !par.length) return '';
  const files = (p) => ['research/FINAL.md', 'research/REPORT.md', 'research/FAILED.md', 'research/DECISIONS.md', 'research/analysis', 'research/experiments', 'research/paper']
    .filter((x) => fs.existsSync(path.join(p.dir, x))).map((x) => `\`${path.join(p.dir, x)}\``).join(', ');
  const list = par.map((p) => `- **${p.state.project}** (\`${p.state.slug}\`, 결과: ${p.state.result || '미판정'}${p.state.result_summary ? ' — ' + p.state.result_summary : ''})\n  근거 파일: ${files(p)}`).join('\n');
  if (kind === 'derived') {
    return `\n## 기반 연구 (파생 연구)\n이 프로젝트는 아래 연구의 결과를 바탕으로 한 **파생 연구**다. P1 전에 기반 연구의 FINAL·REPORT·FAILED·DECISIONS를 모두 읽고, FAILED.md의 접근은 반복하지 말 것. 기반 연구 폴더는 **읽기만** 하고 필요한 코드·데이터는 이 프로젝트로 복사해 출처를 적는다. 기반 연구와의 차별점을 IDEAS.md에 명시한다.\n${list}\n`;
  }
  return `\n## 기반 연구들 (종합 논문)\n이 프로젝트는 아래 연구들의 결과(특히 음성·혼합 결과)를 **비교·분석하는 종합 논문**이다. 새 아이디어를 찾는 대신, 연구들에 공통된 실패 원인·전제·측정 문제·교훈을 찾아 하나의 논지로 묶는다. 수치는 각 연구의 results.json에서만 가져오고 출처(프로젝트·파일)를 표기하며, 새 실험은 교차 검증이나 공통 원인 확인에 필요한 최소한만 한다. 기반 연구 폴더는 **읽기만** 한다.\n${list}\n`;
}

function listProjects() {
  const root = config().projects_root;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, 'research', 'state.json');
    try { out.push({ dir: path.join(root, d), state: readJsonFile(p) }); } catch {}
  }
  return out;
}

// state.json may be written by the director through PowerShell, which adds a UTF-8 BOM — JSON.parse rejects it
function readJsonFile(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
function readState(dir) { return readJsonFile(path.join(dir, 'research', 'state.json')); }
// read-modify-write with a retry (the director may be writing too)
function updateState(dir, fn) {
  const p = path.join(dir, 'research', 'state.json');
  for (let i = 0; i < 3; i++) {
    try {
      const st = readJsonFile(p);
      fn(st);
      const tmp = `${p}.srv${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
      fs.renameSync(tmp, p);
      return st;
    } catch (e) { if (i === 2) throw e; }
  }
}
function appendInbox(dir, text, from = '사용자') {
  const stamp = new Date().toLocaleString('ko-KR', { hour12: false });
  fs.appendFileSync(path.join(dir, 'research', 'INBOX.md'), `\n## ${stamp} · ${from} (unread)\n${text.trim()}\n`);
}

module.exports = { HARNESS, config, templateVars, renderTemplate, PHASES, RESULTS, createProject, listProjects, readState, updateState, appendInbox, slugify };
