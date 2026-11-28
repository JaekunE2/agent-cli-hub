const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseAgyUsageJson, parseAgyUsageTsv, parseAgyQuotaTui, createAgyQuotaService } = require('../agy-quota');

test('parseAgyUsageJson parses structured agy --print /usage --output-format json output with ISO reset times', () => {
  const sample = JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash',
            buckets: [
              { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.7886, reset_time: '2026-11-29T00:00:35Z' },
              { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.3708, reset_time: '2026-11-22T10:00:35Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
            buckets: [
              { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-29T07:55:09Z' },
              { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-11-22T12:55:09Z' },
            ],
          },
        ],
      },
    },
  });

  const q = parseAgyUsageJson(`some notice line\n${sample}\n`, 'user@example.com');
  assert.ok(q);
  assert.equal(q.account, 'user@example.com');
  assert.equal(q.groups.length, 2);
  assert.equal(q.groups[0].name, 'GEMINI');
  assert.equal(q.groups[0].models, 'Gemini 4 Neon, Gemini 3.8 Flash');
  assert.equal(q.groups[0].weeklyRem, 78.9);
  assert.equal(q.groups[0].weekly, 21.1);
  assert.equal(q.groups[0].weeklyResetAt, '2026-11-29T00:00:35Z');
  assert.equal(q.groups[0].fiveHRem, 37.1);
  assert.equal(q.groups[0].fiveH, 62.9);
  assert.equal(q.groups[0].fiveHResetAt, '2026-11-22T10:00:35Z');
  assert.equal(q.groups[1].name, 'CLAUDE AND GPT');
  assert.equal(q.groups[1].fiveH, 0);
  assert.equal(q.groups[1].fiveHReset, 'Quota available');
});

test('parseAgyUsageTsv parses plain TSV fallback output', () => {
  const tsv = [
    'Gemini Models\tWeekly Limit Remaining\t79%\t2026-11-29T00:00:35Z',
    'Gemini Models\tFive Hour Limit Remaining\t37%\t2026-11-22T10:00:35Z',
  ].join('\n');
  const q = parseAgyUsageTsv(tsv, 'a@b.com');
  assert.equal(q.account, 'a@b.com');
  assert.equal(q.groups[0].weekly, 21);
  assert.equal(q.groups[0].fiveH, 63);
  assert.equal(q.groups[0].fiveHResetAt, '2026-11-22T10:00:35Z');
});

test('createAgyQuotaService deduplicates concurrent refreshes, caches fresh reads, and persists account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-agy-quota-'));
  const file = path.join(dir, 'agy-quota.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ account: 'saved@example.com', groups: [], fetchedAt: '2020-01-01T00:00:00Z' }));
    let runs = 0;
    const svc = createAgyQuotaService({
      file,
      ttlMs: 60_000,
      staleMs: 120_000,
      runner: async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 30));
        return {
          account: null,
          groups: [{ name: 'GEMINI', models: '', fiveH: 40, fiveHRem: 60, weekly: 20, weeklyRem: 80, fiveHResetAt: '2026-11-22T10:00:35Z', weeklyResetAt: '2026-11-29T00:00:35Z' }],
          fetchedAt: new Date().toISOString(),
        };
      },
    });

    // Two concurrent force refreshes share one CLI run (single-flight)
    const [r1, r2] = await Promise.all([svc.refresh({ force: true }), svc.refresh({ force: true })]);
    assert.equal(runs, 1);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r1.quota.account, 'saved@example.com');

    // Subsequent non-force refresh hits TTL cache (0ms, no new CLI run)
    const r3 = await svc.refresh({ force: false });
    assert.equal(runs, 1);
    assert.equal(r3.cached, true);

    // Persisted on disk with preserved account
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.account, 'saved@example.com');
    assert.equal(disk.groups[0].fiveH, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseAgyQuotaTui still parses TUI output as passive fallback', () => {
  const raw = 'Models & Quota\nAccount: me@example.com\nGEMINI MODELS\nWeekly Limit\n80% Refreshes in 4d\n';
  const q = parseAgyQuotaTui(raw);
  assert.equal(q.account, 'me@example.com');
  assert.equal(q.groups[0].weekly, 20);
});
