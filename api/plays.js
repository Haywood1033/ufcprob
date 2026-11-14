// POST /api/plays?event={id}  body: { book: "<pasted prices>" } — Best plays: sides, props and
// 3/4/5-leg parlays, ranked by value against pasted prices, else against the card's sportsbook lines from ESPN, else
// by model strength. Returns
// the parsed book too, so the UI shows what matched or was skipped.
const { getCardContext } = require('../lib/card');
const { buildPlays, lockPlays } = require('../lib/plays');
const { parseBook, marketRows, marketName } = require('../lib/book');
const { makeCard } = require('../lib/parlay');
const { param, body, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload, sims } = await getCardContext({ eventId: param(req, 'event') });
    if (!sims.length) return send(res, 409, { error: 'No bouts on this card yet.' });
    const card = sims._card || (sims._card = makeCard(sims));
    // Pasted prices win; otherwise the card's own sportsbook lines (from ESPN) are the book. Only
    // that shared view is saved and locked: a pasted comparison is the visitor's own.
    const book = parseBook(body(req).book || '', payload.bouts);
    const own = book.rows.length > 0, rows = own ? book.rows : marketRows(payload.bouts), name = own ? null : marketName(payload.bouts);
    const plays = await lockPlays(payload, buildPlays(payload, card, rows, name), { canSave: !own });
    send(res, 200, { ...plays, book: { matched: book.rows.length, skipped: book.skipped, rows, source: own ? 'yours' : name } });
  } catch (err) { fail(res, err); }
};
