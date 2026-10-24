// POST /api/dfs?event={id}  body: { csv: "<salary export>" } — projections for every fighter, joined
// to salaries when a CSV is sent, plus the run-by-run sample and opponent pairs the browser's
// lineup scorer needs. The optimizer runs in a Web Worker (lib/dfs-optimizer.js).
const { getCardContext } = require('../lib/card');
const { parseSalaries, projections, simSample, cardFighters } = require('../lib/dfs');
const { makeCard } = require('../lib/parlay');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload, sims } = await getCardContext({ eventId: param(req, 'event') });
    if (!sims.length) return send(res, 409, { error: 'No bouts on this card yet.' });
    const card = sims._card || (sims._card = makeCard(sims));
    const csv = body(req).csv || '';
    const sal = csv ? parseSalaries(csv, cardFighters(payload)) : { rows: [], unmatched: [] };
    if (sal.error) return send(res, 400, { error: sal.error });
    const proj = projections(payload, card, sal.rows);
    const sample = sal.rows.length ? simSample(payload, card, proj.filter(p => p.salary).map(p => p.id)) : null;
    send(res, 200, { projections: proj, sample, opponents: payload.bouts.map(b => [b.a.id, b.b.id]), salaries: { matched: sal.rows.length, unmatched: sal.unmatched } });
  } catch (err) { fail(res, err); }
};
