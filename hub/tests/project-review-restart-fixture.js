'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { completeAutopilotTask, checkAutopilotCompletions } = require('../project-autopilot');
const { randomUUID } = require('node:crypto');

const [baseDir, phase] = process.argv.slice(2);
const projects = require('../projects')(path.join(baseDir, 'projects.json'));
const save = projects.save;
projects.save = (input, options) => {
  if (phase === 'before-card-save' && input.tasks[0].stage === 'done') process.exit(73);
  const saved = save(input, options);
  if (phase === 'before-dispatch' && options?.reviewRun) process.exit(73);
  return saved;
};
const hub = {
  baseDir, projects, terms: new Map(),
  projectHarness: { get: () => ({ roles: { review: { agent: 'codex' } } }) },
  codexLaunch: (args) => ({
    cmd: process.execPath, args: ['-e', `(${fakeCodex})()`, baseDir, args[args.indexOf('--output-last-message') + 1]],
  }),
};

function fakeCodex() {
  const fs = require('node:fs');
  const path = require('node:path');
  const [dir, output] = process.argv.slice(1);
  const verdict = { verdict: 'APPROVE', reason: 'fixture result' };
  fs.appendFileSync(path.join(dir, 'submissions'), '1\n');
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(dir, 'release'))) return;
    clearInterval(timer);
    fs.writeFileSync(output, JSON.stringify(verdict));
    console.log(JSON.stringify({ type: 'thread.started', thread_id: require('node:crypto').randomUUID() }));
  }, 25);
  setTimeout(() => process.exit(1), 8000).unref();
}

async function main() {
  if (phase.startsWith('resume')) {
    const scheduled = await checkAutopilotCompletions(hub);
    await Promise.all(scheduled.map(({ promise }) => promise));
    const expected = phase === 'resume' ? 'approved' : 'error';
    if (projects.list()[0].tasks[0].reviewStatus !== expected) throw new Error('Unexpected recovery status');
    return;
  }
  const project = projects.save({ name: 'Fixture', goal: '', cwd: baseDir, autopilot: true, termIds: [],
    tasks: [{ id: randomUUID(), title: 'Task', detail: '', kind: 'dev', stage: 'doing', termId: '', after: [] }] });
  if (phase === 'after-dispatch') {
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(baseDir, 'submissions'))) process.exit(73);
    }, 10);
    timer.unref();
  }
  await completeAutopilotTask(hub, project.id, project.tasks[0].id);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
