'use strict';
// ccd calls ls | show <date> | run <date> | transcript <date> <recording>
module.exports = function cli(ctx) {
  const { api, die, pos, flags } = ctx;
  return {
    commands: {
      async calls() {
        const sub = pos[1] || 'ls';
        if (sub === 'ls') {
          const r = await api('/api/calls/days?n=' + (flags.n || 30));
          if (r.error) die(r.error);
          if (flags.json) return console.log(JSON.stringify(r));
          console.log(`source ${r.source} · stt ${r.stt} · schedule ${r.schedule || 'manual'}`);
          for (const d of r.days) console.log(`  ${d.date}  ${d.summary ? 'summary' : '       '}  ${d.run ? `${d.run.status}${d.run.error ? ` — ${d.run.error}` : ''}` : ''}`);
          return;
        }
        const date = pos[2] || die(`usage: ccd calls ${sub} <YYYY-MM-DD>`);
        if (sub === 'show') {
          const r = await api(`/api/calls/day?date=${encodeURIComponent(date)}`);
          if (r.error) die(r.error);
          if (flags.json) return console.log(JSON.stringify(r));
          for (const x of r.recordings) console.log(`  ${x.transcript ? '✓' : '·'} ${[x.meta?.time, x.meta?.counterpart].filter(Boolean).join(' · ') || x.name}`);
          console.log(r.summary ? `\n${r.summary}` : '\n(no summary yet)');
          if (r.run) console.log(`\nlast run: ${r.run.status}${r.run.error ? ` — ${r.run.error}` : ''}`);
          return;
        }
        if (sub === 'run') {
          const r = await api(`/api/calls/run?date=${encodeURIComponent(date)}`, {});
          if (r.error) die(r.error);
          return console.log(`started ${date} — follow it with: ccd calls show ${date}`);
        }
        if (sub === 'transcript') {
          const name = pos[3] || die('usage: ccd calls transcript <date> <recording>');
          const res = await fetch(`${ctx.BASE}/api/calls/transcript?date=${encodeURIComponent(date)}&name=${encodeURIComponent(name)}`, { headers: { 'x-token': ctx.token() } });
          if (!res.ok) die((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
          return process.stdout.write(await res.text());
        }
        die('usage: ccd calls ls | show <date> | run <date> | transcript <date> <recording>');
      },
    },
  };
};
