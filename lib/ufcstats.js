// lib/ufcstats.js — UFCStats.com (the UFC's official stats site, server-rendered HTML) parsed
// into events, bouts and fighters. One event page carries every bout's result and per-fighter
// totals (knockdowns, significant strikes, takedowns, submission attempts), so history costs one
// request per event. Fighter pages add height, reach, stance and date of birth.
//
// The parsers read UFCStats' long-stable table templates; /api/health reports what each page
// returned so a template change is caught there.

const { fetchText, TTL } = require('./http');
const { rows, cells, lines, links, attr, idFrom, text } = require('./html');

// UFCStats has long served plain http; if that comes back empty from a host, https is tried and
// whichever works is used for the rest of the instance's life.
const BASES = ['http://ufcstats.com', 'https://ufcstats.com', 'http://www.ufcstats.com'];
let BASE = BASES[0];
const URLS = {
  completed: (b = BASE) => `${b}/statistics/events/completed?page=all`,
  upcoming: (b = BASE) => `${b}/statistics/events/upcoming?page=all`,
  event: id => `${BASE}/event-details/${id}`,
  fighter: id => `${BASE}/fighter-details/${id}`,
};

const parseDate = s => { const d = new Date(`${String(s || '').trim()} 00:00:00 UTC`); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

// Events list (completed or upcoming): id, name, date, location.
function parseEventList(html) {
  const viaRows = parseEventRows(html);
  if (viaRows.length) return viaRows;
  // Fallback: any event link followed by a date, wherever it sits in the page.
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/href="[^"]*event-details\/([0-9a-f]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,400}?([A-Z][a-z]+\.? \d{1,2}, \d{4})/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const date = parseDate(m[3]);
    if (date) out.push({ id: m[1], name: text(m[2]), date, location: null });
  }
  return out;
}

function parseEventRows(html) {
  return rows(html, /b-statistics__table-row/).map(r => {
    const a = links(r.html).find(l => /event-details/.test(l.href));
    if (!a) return null;
    const c = cells(r.html);
    const date = (r.html.match(/b-statistics__date[^>]*>([\s\S]*?)</) || [])[1];
    return { id: idFrom(a.href, 'event-details'), name: a.text, date: parseDate(text(date)), location: c[1] ? text(c[1]) : null };
  }).filter(e => e && e.id && e.date);
}

// Methods as UFCStats prints them → model buckets.
function methodBucket(m) {
  const s = String(m || '').toUpperCase();
  if (/KO|TKO/.test(s) && !/DQ/.test(s)) return 'KO';
  if (/SUB/.test(s)) return 'SUB';
  if (/DEC/.test(s)) return 'DEC';
  return 'OTHER'; // DQ, overturned, could not continue
}
const num = s => { const n = Number(String(s ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) && String(s ?? '').trim() !== '' && String(s).trim() !== '--' ? n : null; };
const clock = s => { const m = String(s || '').match(/(\d+):(\d\d)/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// One event page → bouts. Completed bouts list the winner first; draws and no contests carry
// a "draw" / "nc" flag. `order` is the card position (0 = main event).
function parseEvent(html, id) {
  const name = text((html.match(/<span class="b-content__title-highlight">([\s\S]*?)<\/span>/) || [])[1]);
  const dateTxt = (html.match(/Date:\s*<\/i>([\s\S]*?)<\/li>/) || [])[1];
  const locTxt = (html.match(/Location:\s*<\/i>([\s\S]*?)<\/li>/) || [])[1];
  const bouts = rows(html, /b-fight-details__table-row(?!_type_head)/).filter(r => /fighter-details/.test(r.html)).map((r, order) => {
    const c = cells(r.html);
    if (c.length < 8) return null;
    const fighters = links(c[1]).filter(l => /fighter-details/.test(l.href)).map(l => ({ id: idFrom(l.href, 'fighter-details'), name: l.text }));
    if (fighters.length !== 2) return null;
    const flags = lines(c[0]).join(' ').toLowerCase();
    const pair = i => lines(c[i]).map(num);
    const [kd, str, td, sub] = [2, 3, 4, 5].map(pair);
    const methodLines = lines(c[7]);
    const done = /win|draw|nc/.test(flags) || !!methodLines[0];
    const round = num(lines(c[8] || '')[0]), time = clock(lines(c[9] || '')[0]);
    const weightClass = lines(c[6])[0] || null;
    return {
      fightId: idFrom(attr(r.attrs, 'data-link'), 'fight-details'), order,
      a: fighters[0], b: fighters[1],
      weightClass, title: /belt\.png/i.test(c[6]), women: /women/i.test(weightClass || ''),
      completed: done,
      result: !done ? null : /draw/.test(flags) ? 'draw' : /\bnc\b/.test(flags) ? 'nc' : 'a',
      method: done ? methodLines[0] || null : null, methodDetail: done ? methodLines[1] || null : null, bucket: done ? methodBucket(methodLines[0]) : null,
      round, time,
      stats: done ? { a: { kd: kd[0], sig: str[0], td: td[0], sub: sub[0] }, b: { kd: kd[1], sig: str[1], td: td[1], sub: sub[1] } } : null,
      bonus: [...String(c[6]).matchAll(/\/(perf|fight|sub|ko)\.png/gi)].map(m => m[1].toLowerCase()),
    };
  }).filter(Boolean);
  // Five-round bouts: title fights and the main event (UFCStats' event table doesn't print the
  // scheduled length; the fight page does, but costs a request per bout).
  for (const b of bouts) b.rounds = b.title || b.order === 0 || (b.round || 0) > 3 ? 5 : 3;
  return { id, name, date: parseDate(text(dateTxt)), location: text(locTxt) || null, bouts };
}

function parseFighter(html, id) {
  const field = label => text((html.match(new RegExp(`${label}:\\s*</i>([\\s\\S]*?)</li>`, 'i')) || [])[1]);
  const ht = field('Height').match(/(\d+)'\s*(\d+)/);
  const reach = num(field('Reach'));
  const record = text((html.match(/b-content__title-record">([\s\S]*?)</) || [])[1]).match(/(\d+)-(\d+)-(\d+)/);
  return {
    id, name: text((html.match(/b-content__title-highlight">([\s\S]*?)</) || [])[1]),
    heightIn: ht ? Number(ht[1]) * 12 + Number(ht[2]) : null, reachIn: reach, stance: field('STANCE') || null,
    dob: parseDate(field('DOB')), record: record ? { w: +record[1], l: +record[2], d: +record[3] } : null,
  };
}

async function fetchEvents(kind = 'completed') {
  const ttlMs = kind === 'upcoming' ? TTL.short : TTL.long;
  let lastErr = null;
  for (const b of [BASE, ...BASES.filter(x => x !== BASE)]) {
    try {
      const list = parseEventList(await fetchText(kind === 'upcoming' ? URLS.upcoming(b) : URLS.completed(b), { ttlMs }));
      if (list.length) { BASE = b; return list; }
    } catch (err) { lastErr = err; }
  }
  if (lastErr) throw lastErr;
  return [];
}
async function fetchEvent(id, { live = false } = {}) { return parseEvent(await fetchText(URLS.event(id), { ttlMs: live ? TTL.live : TTL.long }), id); }
async function fetchFighter(id) { return parseFighter(await fetchText(URLS.fighter(id), { ttlMs: TTL.long }), id); }

module.exports = { URLS, parseEventList, parseEvent, parseFighter, methodBucket, fetchEvents, fetchEvent, fetchFighter, clock };
