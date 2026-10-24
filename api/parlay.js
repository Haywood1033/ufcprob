// POST /api/parlay?event={id}  body: { legs: [{ bout, market, side?, line?, dec? }] } — prices a
// custom ticket inside the fight simulation.
const { getCardContext } = require('../lib/card');
const { priceParlay, makeCard } = require('../lib/parlay');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { sims } = await getCardContext({ eventId: param(req, 'event') });
    const card = sims._card || (sims._card = makeCard(sims));
    const legs = (body(req).legs || []).slice(0, 10).map(l => ({ bout: String(l.bout), market: String(l.market), side: l.side ? String(l.side) : undefined, line: l.line !== undefined ? Number(l.line) : undefined, dec: Number(l.dec) > 1 ? Number(l.dec) : null }));
    const r = priceParlay(card, legs);
    send(res, r.error ? 400 : 200, r.error ? { error: r.error } : r);
  } catch (err) { fail(res, err); }
};
