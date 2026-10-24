// GET /api/backtest?events=25 — leak-free backtest of the most recent completed events.
const { runBacktest } = require('../lib/backtest');
const { numParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await runBacktest({ events: numParam(req, 'events', 25, { min: 5, max: 80 }) })); } catch (err) { fail(res, err); }
};
