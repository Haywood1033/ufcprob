// End to end through the real route handlers over the synthetic world.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.UFC_MEMORY_EVENTS = '120';
const { installMockFetch } = require('./fixtures');

const NOW = '2026-10-24T15:00:00Z';
const realNow = Date.now;
let world;
test.before(() => { const off = Date.parse(NOW) - realNow(); Date.now = () => realNow() + off; world = installMockFetch({ now: NOW }); });
test.after(() => { world.restore(); Date.now = realNow; });

function call(name, { query = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let code = 200;
    const res = { setHeader() {}, status(c) { code = c; return this; }, json(b) { resolve({ code, body: b }); }, end() { resolve({ code }); } };
    require(`../api/${name}.js`)({ method: body ? 'POST' : 'GET', query, body }, res).catch(reject);
  });
}

test('card payload: bouts, odds, segments, physicals', async () => {
  const { code, body } = await call('card');
  assert.equal(code, 200);
  assert.equal(body.event.id, world.upcoming.id);
  assert.equal(body.state, 'pre');
  assert.equal(body.bouts.length, 12);
  assert.equal(body.bouts[0].rounds, 5);
  assert.equal(body.bouts[0].segment, 'Main Card');
  assert.equal(body.bouts[11].segment, 'Prelims');
  for (const b of body.bouts) {
    assert.ok(Math.abs(b.pA + b.pB - 1) < 1e-9);
    const m = b.methods;
    assert.ok(Math.abs(m.A.KO + m.A.SUB + m.A.DEC + m.B.KO + m.B.SUB + m.B.DEC - 1) < 1e-9);
  }
  assert.ok(body.bouts[0].a.reachIn > 0 && body.bouts[0].a.age > 18);
});

test('plays: model mode without prices, value mode with them', async () => {
  const card = (await call('card')).body;
  const m = (await call('plays', { body: { book: '' } })).body;
  assert.equal(m.sides.mode, 'model');
  assert.ok(m.sides.items.length > 0);
  const b = card.bouts[0], longshot = b.pA < b.pB ? b.a : b.b;
  const v = (await call('plays', { body: { book: `${longshot.name}, ml, +5000\n${b.a.name} vs ${b.b.name}, distance, +900\nNo One, ml, +100` } })).body;
  assert.equal(v.sides.mode, 'value');
  assert.equal(v.sides.items[0].title, longshot.name);
  assert.equal(v.book.matched, 2);
  assert.equal(v.book.skipped.length, 1);
});

test('parlay and DFS routes', async () => {
  const card = (await call('card')).body;
  const [b0, b1] = card.bouts;
  const p = (await call('parlay', { body: { legs: [{ bout: b0.id, market: 'win', side: 'A' }, { bout: b1.id, market: 'distance' }] } })).body;
  assert.ok(p.joint > 0 && p.joint < 1);
  const fighters = card.bouts.flatMap(b => [b.a, b.b]);
  const csv = ['Position,Name + ID,Name,ID,Roster Position,Salary', ...fighters.map((f, i) => `F,${f.name} (${i}),${f.name},${i},F,${6500 + (i % 20) * 150}`)].join('\n');
  const d = (await call('dfs', { body: { csv } })).body;
  assert.equal(d.salaries.matched, 24);
  assert.equal(d.opponents.length, 12);
  assert.ok(d.sample.n === 2000 && d.sample.ids.length === 24);
});

test('health and backtest', async () => {
  const h = (await call('health')).body;
  assert.ok(h.ok, JSON.stringify(h.checks.filter(c => !c.ok)));
  const bt = (await call('backtest', { query: { events: '10' } })).body;
  assert.equal(bt.events, 10);
  assert.ok(bt.winner.logLoss.model < bt.winner.logLoss.coin, 'beats a coin flip');
});
