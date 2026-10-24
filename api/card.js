// GET /api/card?event={id} — the card payload every tab reads: bouts, fighters, win/method/round
// odds, DFS means and the reasons behind each number. No id = the next (or current) card.
const { getCardContext } = require('../lib/card');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const { payload } = await getCardContext({ eventId: param(req, 'event') });
    send(res, 200, payload, payload.state === 'in' ? 0 : 120);
  } catch (err) { fail(res, err); }
};
