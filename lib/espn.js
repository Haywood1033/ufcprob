// lib/espn.js — ESPN's MMA scoreboard: live bout status (round, clock, result as it happens),
// the card segments (main card / prelims) and scheduled rounds. Undocumented, so every field is
// read defensively; bouts are joined to UFCStats by fighter names (lib/names).

const { fetchJson, TTL } = require('./http');

const SCOREBOARD = date => `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard${date ? `?dates=${date.replace(/-/g, '')}` : ''}`;

function parseBout(c, segment) {
  const comp = (c.competitors || []).map(x => ({ name: x.athlete?.displayName || x.athlete?.fullName || x.displayName || null, winner: x.winner === true, order: x.order ?? null }));
  const st = c.status || {};
  return {
    names: comp.map(x => x.name),
    winner: comp.find(x => x.winner)?.name || null,
    state: st.type?.state || 'pre',          // pre | in | post
    detail: st.type?.detail || st.type?.shortDetail || null,
    round: st.period ?? null, clock: st.displayClock ?? null,
    rounds: c.format?.regulation?.periods ?? null,
    result: st.result?.name || st.result?.displayName || null,
    segment: segment || c.cardSegment?.description || c.cardSegment?.name || null,
    start: c.date || c.startDate || null,
  };
}

async function fetchCard(date, { live = false } = {}) {
  const raw = await fetchJson(SCOREBOARD(date), { ttlMs: live ? 30 * 1000 : TTL.short, timeoutMs: 10000 });
  const events = raw.events || [];
  return events.map(e => ({
    id: String(e.id), name: e.name || e.shortName || null, date: e.date || null,
    state: e.status?.type?.state || null,
    bouts: (e.competitions || []).map(c => parseBout(c, c.cardSegment?.description)),
  }));
}

module.exports = { SCOREBOARD, fetchCard, parseBout };
