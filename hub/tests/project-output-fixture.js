const fs = require('node:fs');
const path = require('node:path');
const { createProjectRoutes } = require('../routes-projects');
const { createSystemRoutes } = require('../routes-system');
const { createProjectHarnessStore } = require('../project-harness');
const { scanFloorplan } = require('../workspace-floorplan');

module.exports = async function outputFixture(dir) {
  const projects = require('../projects')(path.join(dir, 'projects.json'));
  const cwd = path.join(dir, 'workspace');
  const empty = path.join(dir, 'empty');
  for (const folder of [cwd, empty]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(cwd, 'main.js'), "require('./helper');\n");
  fs.writeFileSync(path.join(cwd, 'helper.js'), 'exports.answer = 42;\n');
  const project = projects.save({ name: 'Fixture', cwd, agent: 'codex', goal: 'Build the fixture', tasks: [], termIds: [] });
  const emptyProject = projects.save({ name: 'Empty', cwd: empty, agent: 'codex', goal: 'Check empty results', tasks: [], termIds: [] });
  const harnessPath = path.join(dir, 'project-harness.json');
  const projectHarness = createProjectHarnessStore(harnessPath);
  const defaults = projectHarness.get();
  projectHarness.save({
    roles: { plan: { model: 'legacy-model' } },
    adapters: { codex: { rules: 'legacy rules' } },
  });
  const artifactsMod = require('../artifacts')({ dir, index: { get: () => undefined } });
  const hub = { baseDir: dir, config: {}, projects, scanFloorplan, projectHarness, artifactsMod };
  const { handleProjectRoutes } = createProjectRoutes(hub);
  const { handleSystemRoutes } = createSystemRoutes(hub);
  const body = async req => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks));
  };
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const route = async (url, req, res) => {
    const p = url.pathname;
    const handler = /^\/api\/projects\/(harness|floorplan(\/report)?)$/.test(p)
      ? handleProjectRoutes : p.startsWith('/api/artifact') ? handleSystemRoutes : null;
    if (!handler) return false;
    try { return await handler(p, url, req, res, body, send, () => true); }
    catch (error) { send(res, 500, { error: error.message }); return true; }
  };
  const fixture = await require('./browser-fixture')(projects, route);
  return { ...fixture, cwd, project, emptyProject, harnessPath, defaults };
};
