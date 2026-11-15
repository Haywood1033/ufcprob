// GET /api/live?date=YYYY-MM-DD — ESPN's live status for a card (round, clock, results as they
// happen). Polled by the page on fight night; cached 20 seconds at the edge.
const { fetchCard, fillResults } = require('../lib/espn');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const events = await fetchCard(param(req, 'date'), { live: true });
    await Promise.all(events.map(fillResults)); // how each finished bout ended
    send(res, 200, { events }, 20);
  } catch (err) { fail(res, err); }
};
