// POST /api/plays?event={id}  body: { book: "<pasted prices>" } — Best plays: sides, props and
// 3/4/5-leg parlays, ranked by value when prices are pasted, by model strength when not. Returns
// the parsed book too, so the UI shows what matched or was skipped.
const { getCardContext } = require('../lib/card');
const { buildPlays } = require('../lib/plays');
const { parseBook } = require('../lib/book');
const { makeCard } = require('../lib/parlay');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload, sims } = await getCardContext({ eventId: param(req, 'event') });
    if (!sims.length) return send(res, 409, { error: 'No bouts on this card yet.' });
    const card = sims._card || (sims._card = makeCard(sims));
    const book = parseBook(body(req).book || '', payload.bouts);
    send(res, 200, { ...buildPlays(payload, card, book.rows), book: { matched: book.rows.length, skipped: book.skipped, rows: book.rows } });
  } catch (err) { fail(res, err); }
};
