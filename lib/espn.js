// lib/espn.js — ESPN's MMA feeds: the schedule (scoreboard by date range), each card's bouts in
// running order with scheduled rounds, live status (round, clock, winner as it happens), card
// segments, and fighter bios (height, reach, stance, date of birth) for fighters the history
// dataset doesn't cover. Undocumented, so every field is read defensively.

const { fetchJson, mapLimit, TTL } = require('./http');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';
const CORE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc';
const ATHLETE = id => `https://site.web.api.espn.com/apis/common/v3/sports/mma/athletes/${id}`;
const ymd = d => d.replace(/-/g, '');
const SCOREBOARD = (from, to) => `${SITE}?dates=${ymd(from)}${to && to !== from ? `-${ymd(to)}` : ''}&limit=500`;
// The card's US date (ESPN times are UTC; a 10pm ET main card is the next day in UTC).
const etDate = iso => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null);
const CLASS_RE = /(women'?s\s+)?(strawweight|flyweight|bantamweight|featherweight|lightweight|welterweight|middleweight|light heavyweight|heavyweight|catch ?weight)/i;

function parseBout(c) {
  const comp = (c.competitors || []).map(x => ({ id: String(x.athlete?.id || x.id || ''), name: x.athlete?.displayName || x.athlete?.fullName || x.displayName || null, winner: x.winner === true, record: x.records?.[0]?.summary || null }));
  const st = c.status || {};
  const cls = [c.type?.text, c.type?.abbreviation, c.type?.name, ...(c.notes || []).map(n => n.headline || n.text)].map(t => String(t || '').match(CLASS_RE)).find(Boolean);
  const notes = (c.notes || []).map(n => n.headline || n.text || '').join(' ');
  return {
    id: String(c.id || ''), fighters: comp, names: comp.map(x => x.name),
    winner: comp.find(x => x.winner)?.name || null, winnerId: comp.find(x => x.winner)?.id || null,
    state: st.type?.state || 'pre',          // pre | in | post
    completed: !!st.type?.completed || st.type?.state === 'post',
    detail: st.type?.detail || st.type?.shortDetail || null,
    round: st.period ?? null, clock: st.displayClock ?? null,
    rounds: c.format?.regulation?.periods ?? null,
    result: st.result?.name || st.result?.displayName || null,
    weightClass: cls ? `${cls[1] ? "Women's " : ''}${cls[2].toLowerCase().replace(/catch ?weight/, 'catch weight').replace(/\b\w/g, ch => ch.toUpperCase())}` : null,
    title: /title/i.test(notes) || /title/i.test(c.type?.text || ''),
    segment: c.cardSegment?.description || c.cardSegment?.name || null,
    start: c.date || c.startDate || null,
  };
}

// Running order, main event first. ESPN lists bouts in start order (prelims first); when start
// times tie, the 5-round bout is the main event.
function ordered(bouts) {
  const out = bouts.map((b, i) => ({ b, i })).sort((x, y) => String(y.b.start || '').localeCompare(String(x.b.start || '')) || y.i - x.i).map(x => x.b);
  if (out.length > 1 && out[0].rounds !== 5 && out.at(-1).rounds === 5) out.reverse();
  return out.map((b, order) => ({ ...b, order }));
}

function parseEvent(e) {
  const bouts = ordered((e.competitions || []).map(parseBout));
  const states = bouts.map(b => b.state);
  const state = e.status?.type?.state || (states.length && states.every(s => s === 'post') ? 'post' : states.some(s => s !== 'pre') ? 'in' : 'pre');
  return { id: String(e.id), name: e.name || e.shortName || null, start: e.date || null, date: etDate(e.date), state, location: e.venues?.[0]?.fullName || e.competitions?.[0]?.venue?.fullName || null, bouts };
}

// Every UFC event between two dates (YYYY-MM-DD), earliest first.
async function fetchSchedule(from, to, { live = false } = {}) {
  const raw = await fetchJson(SCOREBOARD(from, to), { ttlMs: live ? 30 * 1000 : TTL.short, timeoutMs: 12000 });
  return (raw.events || []).map(parseEvent).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}
// The card(s) on one date — what /api/live polls.
const fetchCard = (date, opts) => fetchSchedule(date, date, opts);

// Card segment from the core API, for bouts the scoreboard didn't label (best effort).
async function fillSegments(ev) {
  const todo = ev.bouts.filter(b => !b.segment && b.id);
  await mapLimit(todo, 6, async b => {
    try {
      const c = await fetchJson(`${CORE}/events/${ev.id}/competitions/${b.id}`, { ttlMs: TTL.long, timeoutMs: 6000, retries: 0 });
      let seg = c.cardSegment;
      if (seg?.$ref && !seg.description && !seg.name) seg = await fetchJson(seg.$ref.replace(/^http:/, 'https:'), { ttlMs: TTL.long, timeoutMs: 6000, retries: 0 });
      b.segment = seg?.description || seg?.name || null;
    } catch { /* falls back to running order */ }
  });
  return ev;
}

// "5' 7\"" → 67; "66\"" → 66; "30/3/1990" (D/M/YYYY) → 1990-03-30.
const inchesOf = s => { const t = String(s || ''); const ft = t.match(/(\d+)'\s*(\d+)?/); if (ft) return Number(ft[1]) * 12 + Number(ft[2] || 0); const n = parseFloat(t); return Number.isFinite(n) && n > 40 ? n : null; };
function dobOf(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})-(\d\d)-(\d\d)/);
  return m ? m[0] : null;
}
async function fetchAthlete(id) {
  const a = (await fetchJson(ATHLETE(id), { ttlMs: TTL.long, timeoutMs: 8000, retries: 0 })).athlete || {};
  return {
    id: String(id), name: a.displayName || a.fullName || null, heightIn: inchesOf(a.displayHeight), reachIn: inchesOf(a.displayReach),
    stance: a.stance?.text || a.stance?.name || (typeof a.stance === 'string' ? a.stance : null), dob: dobOf(a.displayDOB) || dobOf(a.dateOfBirth),
    weightClass: a.weightClass?.text || null, women: /female/i.test(a.gender || ''),
  };
}

// Sportsbook lines for one bout from the core API's odds list (the first provider, DraftKings at
// the time of writing): each fighter's moneyline now and at open, method-of-victory prices, and
// the round total. American odds as integers, keyed by ESPN athlete id. Null when ESPN has none.
//   items[0]: { provider: { name }, overUnder, overOdds, underOdds,
//               awayAthleteOdds | homeAthleteOdds: { moneyLine, athlete: { $ref: …/athletes/{id} },
//                 open: { moneyLine: { american } },
//                 current: { moneyLine: { american }, victoryMethod: { koTkoDq, submission, points: { american } } } } }
const ODDS = (eventId, compId) => `${CORE}/events/${eventId}/competitions/${compId}/odds?lang=en&region=us`;
const amer = v => { const n = typeof v === 'number' ? v : parseInt(String(v?.american ?? v ?? '').replace('−', '-').replace(/^EVEN$/i, '100'), 10); return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null; };
function parseOdds(raw) {
  const item = [...(raw?.items || [])].filter(i => i?.awayAthleteOdds || i?.homeAthleteOdds).sort((x, y) => (x.provider?.priority ?? 99) - (y.provider?.priority ?? 99))[0];
  if (!item) return null;
  const sides = {};
  for (const s of [item.awayAthleteOdds, item.homeAthleteOdds]) {
    const id = (String(s?.athlete?.$ref || '').match(/athletes\/(\d+)/) || [])[1];
    if (!id) continue;
    const vm = s.current?.victoryMethod || s.open?.victoryMethod || {};
    sides[id] = { ml: amer(s.moneyLine) ?? amer(s.current?.moneyLine), open: amer(s.open?.moneyLine), ko: amer(vm.koTkoDq), sub: amer(vm.submission), dec: amer(vm.points) };
  }
  if (Object.values(sides).filter(s => s.ml !== null).length < 2) return null;
  const line = Number(item.overUnder);
  return { provider: item.provider?.name || null, sides, total: Number.isFinite(line) && line > 0 ? { line, over: amer(item.overOdds) ?? amer(item.current?.over), under: amer(item.underOdds) ?? amer(item.current?.under) } : null };
}
async function fetchOdds(eventId, compId, { live = false } = {}) {
  try { return parseOdds(await fetchJson(ODDS(eventId, compId), { ttlMs: live ? 30 * 1000 : 5 * 60 * 1000, timeoutMs: 6000, retries: 0 })); } catch { return null; }
}

module.exports = { ODDS, parseOdds, fetchOdds, SCOREBOARD, ATHLETE, fetchSchedule, fetchCard, fillSegments, fetchAthlete, parseBout, parseEvent, etDate, inchesOf, dobOf };
