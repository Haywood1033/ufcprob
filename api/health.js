// GET /api/health — fetches every source the model depends on and reports what came back, so a
// changed UFCStats template or ESPN feed shows up here first. ?event={id} audits one event.
const ufc = require('../lib/ufcstats');
const { fetchCard } = require('../lib/espn');
const { dataStatus } = require('../lib/store');
const { param, send } = require('./_util');

async function check(name, fn) {
  const t = Date.now();
  try { return { name, ok: true, ms: Date.now() - t, ...(await fn()) }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
}

module.exports = async (req, res) => {
  let completed = [], upcoming = [];
  const checks = [];
  checks.push(await check('UFCStats: completed events', async () => { completed = await ufc.fetchEvents('completed'); return { events: completed.length, latest: completed[0] || null }; }));
  checks.push(await check('UFCStats: upcoming events', async () => { upcoming = await ufc.fetchEvents('upcoming'); return { events: upcoming.length, next: upcoming.sort((a, b) => a.date.localeCompare(b.date))[0] || null }; }));
  if (completed[0]) checks.push(await check(`UFCStats: last event (${completed[0].name})`, async () => {
    const ev = await ufc.fetchEvent(completed[0].id);
    return { bouts: ev.bouts.length, completed: ev.bouts.filter(b => b.completed).length, withStats: ev.bouts.filter(b => b.stats?.a?.sig !== null && b.stats?.a?.sig !== undefined).length, methods: [...new Set(ev.bouts.map(b => b.bucket))], sample: ev.bouts[0] || null };
  }));
  if (upcoming[0]) {
    checks.push(await check(`UFCStats: next card (${upcoming[0].name})`, async () => { const ev = await ufc.fetchEvent(upcoming[0].id); return { bouts: ev.bouts.length, main: ev.bouts[0] ? `${ev.bouts[0].a.name} vs ${ev.bouts[0].b.name}` : null }; }));
    checks.push(await check('UFCStats: fighter page', async () => { const ev = await ufc.fetchEvent(upcoming[0].id); const f = ev.bouts[0] ? await ufc.fetchFighter(ev.bouts[0].a.id) : null; return { fighter: f }; }));
    checks.push(await check('ESPN: card for the next event', async () => { const c = await fetchCard(upcoming[0].date); return { events: c.length, bouts: c[0]?.bouts.length || 0, segments: [...new Set((c[0]?.bouts || []).map(b => b.segment))], sample: c[0]?.bouts[0] || null }; }));
  }
  checks.push(await check('History store', async () => dataStatus()));
  let audit = null;
  const id = param(req, 'event');
  if (id) audit = await check(`Audit event ${id}`, async () => { const ev = await ufc.fetchEvent(id); return { name: ev.name, date: ev.date, bouts: ev.bouts }; });
  send(res, 200, { ok: checks.every(c => c.ok), generatedAt: new Date().toISOString(), checks, audit });
};
