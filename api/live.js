// GET /api/live?date=YYYY-MM-DD — ESPN's live status for a card (round, clock, results as they
// happen). Polled by the page on fight night; cached 20 seconds at the edge.
const { fetchCard } = require('../lib/espn');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, { events: await fetchCard(param(req, 'date'), { live: true }) }, 20); } catch (err) { fail(res, err); }
};
