// lib/card.js — assembles one card: which event (ESPN's schedule), its bouts in running order,
// each fighter as of fight night (Elo, record, style, finish profile, physicals) from the history
// dataset, the fitted win and finish models, the simulation, ESPN's live status, and every
// per-bout number the tabs show. Cached per event for a few minutes so every product prices from
// the same simulation.
//
// ESPN fighters are matched to history by name (lib/dataset's resolver); a fighter with no UFC
// history is a debutant and starts from the debut rating, with physicals from ESPN's bio.

const { fetchSchedule, fillSegments, fetchAthlete } = require('./espn');
const { loadHistory } = require('./store');
const lock = require('./lock');
const { prepare, fighterAt, features, FEATURE_NAMES, calibrate, winProb, hazards, scaledHazards, ageAt } = require('./ratings');
const { simulateCard, summarizeBout } = require('./simulator');
const { normName } = require('./names');
const { mapLimit } = require('./http');
const { hashSeed } = require('./rng');

const SIMS = 15000, CACHE_MS = 5 * 60 * 1000, FRESH_MS = 20 * 1000;
const cache = new Map();
let calibCache = { key: null, params: null };
const american = p => (!p || p <= 0 || p >= 1 ? '—' : p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);
const today = () => new Date(Date.now()).toISOString().slice(0, 10);
const shift = (d, days) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

// Recent and upcoming cards from ESPN's schedule (about four months back, ten weeks ahead).
// `fresh` re-reads ESPN within seconds rather than minutes (fight night, the refresh button).
async function schedule(fresh = false) { return fetchSchedule(shift(today(), -120), shift(today(), 75), { live: fresh }); }

async function listEvents() {
  const all = (await schedule()).filter(e => e.bouts.length);
  const brief = e => ({ id: e.id, name: e.name, date: e.date, state: e.state, bouts: e.bouts.length });
  return {
    upcoming: all.filter(e => e.state !== 'post').map(brief),
    completed: all.filter(e => e.state === 'post').reverse().slice(0, 30).map(brief),
  };
}

async function pickEvent(eventId, fresh = false) {
  const all = (await schedule(fresh)).filter(e => e.bouts.length);
  if (eventId) {
    const e = all.find(x => x.id === String(eventId));
    if (!e) throw Object.assign(new Error(`Event ${eventId} not found`), { status: 404 });
    return e;
  }
  // The card in progress or next; fall back to the most recent completed one.
  const next = all.find(e => e.state !== 'post' && e.date >= shift(today(), -1));
  if (next) return next;
  const done = all.filter(e => e.state === 'post').at(-1);
  if (done) return done;
  throw Object.assign(new Error('No UFC events found on ESPN\'s schedule'), { status: 404 });
}

// History physicals first; ESPN's bio fills fighters the dataset lacks (debutants, missing reach).
async function physicalsFor(sides, known) {
  const out = new Map();
  const todo = [];
  for (const s of sides) {
    const k = known.get(s.id);
    if (k && k.reachIn && k.dob) out.set(s.id, k);
    else todo.push({ s, k });
  }
  await mapLimit(todo, 6, async ({ s, k }) => {
    let e = {};
    if (s.espnId) { try { e = await fetchAthlete(s.espnId); } catch { e = {}; } }
    out.set(s.id, { heightIn: k?.heightIn || e.heightIn || null, reachIn: k?.reachIn || e.reachIn || null, stance: k?.stance || e.stance || null, dob: k?.dob || e.dob || null, espnClass: e.weightClass || null });
  });
  return out;
}

// Result of a finished bout from the dataset (method, round, time); ESPN's winner if not there yet.
function resultFor(eb, a, b, date, ds) {
  if (!eb.completed) return null;
  const pair = [a, b].map(s => s.id).sort().join('|'), names = [a, b].map(s => normName(s.name)).sort().join('|');
  const lo = shift(date, -1), hi = shift(date, 2);
  const r = ds.find(x => x.date >= lo && x.date <= hi && ([x.a.id, x.b.id].sort().join('|') === pair || [x.a.name, x.b.name].map(normName).sort().join('|') === names));
  if (r) {
    const winner = r.result === 'a' ? (r.a.id === a.id || normName(r.a.name) === normName(a.name) ? a.id : b.id) : null;
    return { winner, draw: r.result === 'draw', nc: r.result === 'nc', method: r.method, bucket: r.bucket, round: r.endRound, time: r.endTime };
  }
  const winner = eb.winnerId ? (eb.winnerId === a.espnId ? a.id : eb.winnerId === b.espnId ? b.id : null) : null;
  return { winner, draw: !winner && /draw/i.test(eb.result || eb.detail || ''), nc: !winner && /no contest/i.test(eb.result || eb.detail || ''), method: eb.result || null, bucket: null, round: eb.round, time: null };
}

function reasonsFor(x, w, A, B, physA, physB, date) {
  // Contribution of each feature to the log-odds, largest first — "why this number".
  const parts = x.map((v, j) => ({ name: FEATURE_NAMES[j], value: v * w[j] })).filter(p => Math.abs(p.value) >= 0.04).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return parts.map(p => ({ name: p.name, logOdds: +p.value.toFixed(3) }));
}

async function buildCard({ eventId = null, fresh = false } = {}) {
  const ev = await pickEvent(eventId, fresh);
  // The card starts at its first bout: the earliest time ESPN lists for the event or any bout on
  // it. The lock and the start time on the page both use this, so prelims never run unlocked.
  const starts = [ev.start, ...ev.bouts.map(b => b.start)].map(s => Date.parse(s || '')).filter(Number.isFinite);
  const firstBout = starts.length ? new Date(Math.min(...starts)).toISOString() : ev.start;
  const date = ev.date;
  const hist = await loadHistory({ before: date });
  const prep = prepare(hist.bouts);
  const calKey = `${hist.bouts.length}|${hist.bouts.at(-1)?.fightId || ''}`;
  if (calibCache.key !== calKey) calibCache = { key: calKey, params: calibrate(prep, hist.bouts, hist.fighters) };
  const params = calibCache.params;
  if (ev.state !== 'post') await fillSegments(ev);

  const side = f => { const id = hist.resolve(f.name); return { id: id || `espn:${f.id}`, espnId: f.id || null, name: f.name, known: !!id, proRecord: /^\d+-\d+/.test(f.record || '') ? f.record : null }; };
  const pairs = ev.bouts.filter(eb => eb.fighters.length === 2).map(eb => ({ eb, a: side(eb.fighters[0]), b: side(eb.fighters[1]) }));
  const phys = await physicalsFor(pairs.flatMap(p => [p.a, p.b]), hist.fighters);
  const all = (await loadHistory({ before: '9999-12-31' })).bouts;

  const simInput = [], rows = [];
  for (const { eb, a, b } of pairs) {
    const wc = eb.weightClass || hist.last.get(a.id)?.weightClass || hist.last.get(b.id)?.weightClass || phys.get(a.id)?.espnClass || 'Open Weight';
    const A = fighterAt(prep, a.id, date, wc), B = fighterAt(prep, b.id, date, wc);
    A.name ||= a.name; B.name ||= b.name;
    const pa = phys.get(a.id) || {}, pb = phys.get(b.id) || {};
    const x = features(A, B, pa, pb, date);
    const pA = winProb(params, x);
    const hazA = scaledHazards(hazards(A, B, A.class, pA), params.finish), hazB = scaledHazards(hazards(B, A, B.class, 1 - pA), params.finish);
    const rounds = eb.rounds || (eb.order === 0 ? 5 : 3);
    simInput.push({ id: eb.id || `${a.id}-${b.id}`, rounds, pA, hazA, hazB, A, B, cls: A.class });
    rows.push({ eb, a, b, wc, A, B, pa, pb, x, pA, rounds });
  }
  const seed = hashSeed(`${ev.id}|${calKey}`);
  const sims = simulateCard(simInput, { sims: SIMS, seed });
  const fighterView = (F, ph, s) => ({
    id: F.id, espnId: s.espnId, name: F.name, debut: !s.known || F.ufcFights === 0, proRecord: s.proRecord, elo: Math.round(F.elo), ufcFights: F.ufcFights, record: F.record, layoffDays: F.layoffDays, lastDate: F.lastDate,
    age: ph.dob ? +ageAt(ph.dob, date).toFixed(1) : null, reachIn: ph.reachIn || null, heightIn: ph.heightIn || null, stance: ph.stance || null,
    style: Object.fromEntries(Object.entries(F.style).map(([k, v]) => [k, +v.toFixed(2)])), classStyle: { sig15: +F.class.sig15.toFixed(2), td15: +F.class.td15.toFixed(2), kd15: +F.class.kd15.toFixed(3), sub15: +F.class.sub15.toFixed(2) },
    finishProfile: Object.fromEntries(Object.entries(F.finishProfile).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])), recent: F.recent, minutes: F.minutes,
  });
  const bouts = rows.map((r, i) => {
    const s = summarizeBout(sims[i]);
    const live = { state: r.eb.state, round: r.eb.round, clock: r.eb.clock, detail: r.eb.detail, winner: r.eb.winner, result: r.eb.result };
    return {
      id: simInput[i].id, order: r.eb.order, start: r.eb.start || null, segment: r.eb.segment || (r.eb.order < 5 ? 'Main Card' : 'Prelims'), weightClass: r.wc, title: r.eb.title, women: /women/i.test(r.wc), rounds: r.rounds,
      a: fighterView(r.A, r.pa, r.a), b: fighterView(r.B, r.pb, r.b),
      pA: s.pA, pB: s.pB, fair: { a: american(s.pA), b: american(s.pB) },
      methods: s.methods, distance: s.distance, insideDistance: s.insideDistance, endsInRound: s.endsInRound, winsInRound: s.winsInRound, over: s.over,
      dfs: s.dfs, sig: s.sig, td: s.td, stats: s.stats,
      why: reasonsFor(r.x, params.win, r.A, r.B, r.pa, r.pb, date),
      result: resultFor(r.eb, r.a, r.b, date, all),
      live,
    };
  });
  const sides = pairs.flatMap(p => [p.a, p.b]);
  const payload = {
    event: { id: ev.id, name: ev.name, date, location: ev.location, start: firstBout },
    state: ev.state,
    history: { source: hist.source, bouts: hist.bouts.length, fighters: prep.byFighter.size, matched: sides.filter(s => s.known).length, onCard: sides.length, withPhysicals: [...phys.values()].filter(p => p.dob).length, latest: hist.events[0]?.date || null },
    params: { win: Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, +params.win[j].toFixed(3)])), finish: params.finish, samples: params.samples },
    sims: SIMS, bouts, generatedAt: new Date().toISOString(),
  };
  // The pre-fight projection, locked write-once at the first bout (lib/lock): saved as a draft on every
  // build before then (awaited: a serverless function can be frozen once the response is sent), sealed
  // by the database at the first bout, and from then on every bout shows its sealed pre-fight numbers
  // with live status and results laid over them. The Accuracy tab grades the same sealed copy.
  if (bouts.length) {
    if (!lock.hasStarted({ state: ev.state, start: firstBout })) {
      const r = await lock.draft('card', payload.event, payload);
      payload.snapshot = r.state === 'open' ? { saved: true, at: r.at } : { saved: false, reason: r.error || r.state };
      if (r.payload) freezeCard(payload, r);
      else payload.lock = { state: r.state === 'open' ? 'open' : r.state === 'off' ? 'off' : 'error' };
    } else {
      // A card that is already over is never saved after the fact: only a projection saved before
      // the first bout (or locked late while the card was still running) is shown as locked.
      const r = await lock.seal('card', payload.event, { ...payload, lockedLate: new Date().toISOString() }, { insert: ev.state !== 'post' });
      if (r.payload) freezeCard(payload, r); else payload.lock = { state: r.state };
    }
  }
  return { payload, sims, prep, params };
}

// A started card shows its sealed pre-fight numbers: every model field comes from the sealed copy,
// only the live status and results come from tonight. A bout added after the seal (a late
// replacement) keeps today's numbers and is marked as not part of the pre-fight projection.
const MODEL_FIELDS = ['a', 'b', 'pA', 'pB', 'fair', 'methods', 'distance', 'insideDistance', 'endsInRound', 'winsInRound', 'over', 'dfs', 'sig', 'td', 'stats', 'why', 'weightClass', 'rounds', 'title', 'women'];
function freezeCard(payload, r) {
  const snap = new Map((r.payload.bouts || []).map(b => [b.id, b]));
  payload.bouts = payload.bouts.map(b => {
    const s = snap.get(b.id);
    if (!s) return { ...b, prefight: false };
    const out = { ...b };
    for (const k of MODEL_FIELDS) if (s[k] !== undefined) out[k] = s[k];
    return out;
  });
  payload.lock = { state: r.state, savedAt: r.savedAt, lockedAt: r.lockedAt, late: !!r.payload.lockedLate };
  payload.frozen = true;
}

async function getCardContext(opts = {}) {
  const key = opts.eventId || 'current';
  const hit = cache.get(key);
  // `fresh` (the refresh button, and the page noticing a bout start or finish) accepts only a
  // build from the last few seconds, so a burst of requests still shares one build.
  if (hit && Date.now() - hit.at < (opts.fresh ? FRESH_MS : CACHE_MS)) return hit.value;
  const p = buildCard(opts);
  cache.set(key, { at: Date.now(), value: p });
  try { return await p; } catch (err) { cache.delete(key); throw err; }
}
function clearCardCache() { cache.clear(); calibCache = { key: null, params: null }; }

module.exports = { getCardContext, buildCard, listEvents, pickEvent, american, clearCardCache, SIMS };
