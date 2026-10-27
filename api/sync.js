// GET /api/sync — reloads the history dataset (it refreshes about weekly upstream) and grades any
// saved pre-fight snapshots whose results have arrived. The weekly cron calls it on Mondays.
// GET /api/sync?snapshot=1 — builds the next card so its pre-fight projection is saved even if
// nobody opens the site before the first bout (daily cron).
const { loadDataset } = require('../lib/dataset');
const { gradeAll } = require('../lib/grading');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    if (param(req, 'snapshot')) {
      const { buildCard } = require('../lib/card');
      const { payload: p } = await buildCard();
      return send(res, 200, { event: p.event?.name || null, state: p.state, snapshot: p.snapshot || { saved: false, reason: p.state === 'pre' ? 'not saved' : `card is ${p.state}, only pre-fight projections are saved` } });
    }
    const ds = await loadDataset({ force: true });
    const grading = await gradeAll({ deadline: Date.now() + 30000 }).catch(err => ({ error: err.message }));
    send(res, 200, { loadedAt: ds.loadedAt, bouts: ds.bouts.length, fighters: ds.fighters.size, latestEvent: ds.events[0] || null, grading });
  } catch (err) { fail(res, err); }
};
