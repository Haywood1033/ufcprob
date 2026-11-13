// GET /api/card?event={id} — the card payload every tab reads: bouts, fighters, win/method/round
// odds, DFS means and the reasons behind each number. No id = the next (or current) card.
// &fresh=1 skips the few-minute cache (the refresh button; a bout starting or finishing).
const { getCardContext } = require('../lib/card');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const fresh = !!param(req, 'fresh');
    const { payload } = await getCardContext({ eventId: param(req, 'event'), fresh });
    send(res, 200, payload, fresh || payload.state === 'in' ? 0 : 120);
  } catch (err) { fail(res, err); }
};
