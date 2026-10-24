// lib/card.js — assembles one card: which event, its bouts, each fighter as of fight night
// (Elo, record, style, finish profile, physicals), the fitted win and finish models, the
// simulation, ESPN's live status, and every per-bout number the tabs show. Cached per event for
// a few minutes so every product prices from the same simulation.

const { fetchEvents, fetchEvent, fetchFighter } = require('./ufcstats');
const { fetchCard } = require('./espn');
const { loadHistory, saveSnapshot } = require('./store');
const { prepare, fighterAt, features, FEATURE_NAMES, calibrate, winProb, hazards, scaledHazards, ageAt } = require('./ratings');
const { simulateCard, summarizeBout } = require('./simulator');
const { buildMatcher } = require('./names');
const { mapLimit } = require('./http');
const { hashSeed } = require('./rng');

const SIMS = 15000, CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
let calibCache = { key: null, params: null };
const american = p => (!p || p <= 0 || p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);
const today = () => new Date(Date.now()).toISOString().slice(0, 10);

async function listEvents() {
  const [up, done] = await Promise.all([fetchEvents('upcoming').catch(() => []), fetchEvents('completed').catch(() => [])]);
  return { upcoming: up.sort((a, b) => a.date.localeCompare(b.date)), completed: done.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30) };
}

async function pickEvent(eventId) {
  const { upcoming, completed } = await listEvents();
  if (eventId) {
    const e = [...upcoming, ...completed].find(x => x.id === eventId);
    if (!e) throw Object.assign(new Error(`Event ${eventId} not found`), { status: 404 });
    return e;
  }
  // The card on today or next; fall back to the most recent completed one.
  const next = upcoming.find(e => e.date >= today()) || upcoming[0];
  if (next) return next;
  if (completed[0]) return completed[0];
  throw Object.assign(new Error('No UFC events found'), { status: 404 });
}

async function physicalsFor(ids, known) {
  const out = new Map(known);
  const missing = ids.filter(id => !out.has(id));
  await mapLimit(missing, 6, async id => { try { const f = await fetchFighter(id); out.set(id, { heightIn: f.heightIn, reachIn: f.reachIn, stance: f.stance, dob: f.dob }); } catch { out.set(id, {}); } });
  return out;
}

function reasonsFor(x, w, A, B, physA, physB, date) {
  // Contribution of each feature to the log-odds, largest first — "why this number".
  const parts = x.map((v, j) => ({ name: FEATURE_NAMES[j], value: v * w[j] })).filter(p => Math.abs(p.value) >= 0.04).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return parts.map(p => ({ name: p.name, logOdds: +p.value.toFixed(3) }));
}

async function buildCard({ eventId = null } = {}) {
  const meta = await pickEvent(eventId);
  const ev = await fetchEvent(meta.id, { live: true });
  const date = ev.date || meta.date;
  const hist = await loadHistory({ before: date });
  const prep = prepare(hist.bouts);
  const calKey = `${hist.bouts.length}|${hist.bouts.at(-1)?.fightId || ''}`;
  if (calibCache.key !== calKey) calibCache = { key: calKey, params: calibrate(prep, hist.bouts, hist.fighters) };
  const params = calibCache.params;

  const ids = ev.bouts.flatMap(b => [b.a.id, b.b.id]);
  const phys = await physicalsFor(ids, hist.fighters);
  let espn = null;
  try { espn = (await fetchCard(date, { live: true }))[0] || null; } catch { espn = null; }
  const espnMatch = espn ? buildMatcher(espn.bouts.flatMap((b, i) => b.names.map(n => ({ id: `${i}`, name: n })))) : null;

  const simInput = [], rows = [];
  for (const b of ev.bouts) {
    const A = fighterAt(prep, b.a.id, date, b.weightClass), B = fighterAt(prep, b.b.id, date, b.weightClass);
    A.name ||= b.a.name; B.name ||= b.b.name;
    const pa = phys.get(b.a.id) || {}, pb = phys.get(b.b.id) || {};
    const x = features(A, B, pa, pb, date);
    const pA = winProb(params, x);
    const hazA = scaledHazards(hazards(A, B, A.class, pA), params.finish), hazB = scaledHazards(hazards(B, A, B.class, 1 - pA), params.finish);
    const ei = espnMatch ? Number(espnMatch(b.a.name)?.id ?? espnMatch(b.b.name)?.id ?? NaN) : NaN;
    const eb = Number.isFinite(ei) ? espn.bouts[ei] : null;
    const rounds = eb?.rounds || b.rounds;
    simInput.push({ id: b.fightId || `${b.a.id}-${b.b.id}`, rounds, pA, hazA, hazB, A, B, cls: A.class });
    rows.push({ b, A, B, pa, pb, x, pA, eb, rounds });
  }
  const seed = hashSeed(`${meta.id}|${calKey}`);
  const sims = simulateCard(simInput, { sims: SIMS, seed });
  const fighterView = (F, ph) => ({
    id: F.id, name: F.name, elo: Math.round(F.elo), ufcFights: F.ufcFights, record: F.record, layoffDays: F.layoffDays, lastDate: F.lastDate,
    age: ph.dob ? +ageAt(ph.dob, date).toFixed(1) : null, reachIn: ph.reachIn || null, heightIn: ph.heightIn || null, stance: ph.stance || null,
    style: Object.fromEntries(Object.entries(F.style).map(([k, v]) => [k, +v.toFixed(2)])), classStyle: { sig15: +F.class.sig15.toFixed(2), td15: +F.class.td15.toFixed(2), kd15: +F.class.kd15.toFixed(3), sub15: +F.class.sub15.toFixed(2) },
    finishProfile: Object.fromEntries(Object.entries(F.finishProfile).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])), recent: F.recent, minutes: F.minutes,
  });
  const bouts = rows.map((r, i) => {
    const s = summarizeBout(sims[i]);
    const live = r.eb ? { state: r.eb.state, round: r.eb.round, clock: r.eb.clock, detail: r.eb.detail, winner: r.eb.winner, result: r.eb.result } : null;
    return {
      id: simInput[i].id, order: r.b.order, segment: r.eb?.segment || (r.b.order < 5 ? 'Main Card' : 'Prelims'), weightClass: r.b.weightClass, title: r.b.title, women: r.b.women, rounds: r.rounds,
      a: fighterView(r.A, r.pa), b: fighterView(r.B, r.pb),
      pA: s.pA, pB: s.pB, fair: { a: american(s.pA), b: american(s.pB) },
      methods: s.methods, distance: s.distance, insideDistance: s.insideDistance, endsInRound: s.endsInRound, winsInRound: s.winsInRound, over: s.over,
      dfs: s.dfs, sig: s.sig, td: s.td,
      why: reasonsFor(r.x, params.win, r.A, r.B, r.pa, r.pb, date),
      result: r.b.completed ? { winner: r.b.result === 'a' ? r.b.a.id : null, draw: r.b.result === 'draw', nc: r.b.result === 'nc', method: r.b.method, bucket: r.b.bucket, round: r.b.round, time: r.b.time } : null,
      live,
    };
  });
  const state = ev.bouts.length && ev.bouts.every(b => b.completed) ? 'post' : espn?.state === 'in' || bouts.some(b => b.live?.state === 'in' || b.live?.state === 'post') ? 'in' : 'pre';
  const payload = {
    event: { id: meta.id, name: ev.name || meta.name, date, location: ev.location || meta.location, start: espn?.date || null },
    state, history: { source: hist.source, bouts: hist.bouts.length, fighters: prep.byFighter.size, withPhysicals: [...phys.values()].filter(p => p.dob).length },
    params: { win: Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, +params.win[j].toFixed(3)])), finish: params.finish, samples: params.samples },
    sims: SIMS, bouts, generatedAt: new Date().toISOString(),
  };
  if (state === 'pre' && bouts.length) saveSnapshot(payload.event, payload).catch(() => {});
  return { payload, sims, prep, params };
}

async function getCardContext(opts = {}) {
  const key = opts.eventId || 'current';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const p = buildCard(opts);
  cache.set(key, { at: Date.now(), value: p });
  try { return await p; } catch (err) { cache.delete(key); throw err; }
}
function clearCardCache() { cache.clear(); calibCache = { key: null, params: null }; }

module.exports = { getCardContext, buildCard, listEvents, pickEvent, american, clearCardCache, SIMS };
