// GET /api/sync — reloads the history dataset (it refreshes about weekly upstream) and grades any
// saved pre-fight snapshots whose results have arrived. The weekly cron calls it on Mondays.
const { loadDataset } = require('../lib/dataset');
const { gradeAll } = require('../lib/grading');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const ds = await loadDataset({ force: true });
    const grading = await gradeAll({ deadline: Date.now() + 30000 }).catch(err => ({ error: err.message }));
    send(res, 200, { loadedAt: ds.loadedAt, bouts: ds.bouts.length, fighters: ds.fighters.size, latestEvent: ds.events[0] || null, grading });
  } catch (err) { fail(res, err); }
};
