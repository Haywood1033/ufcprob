// GET /api/sync — backfill completed events (and fighter physicals) into Postgres. Each call does
// what fits in ~45s and reports `remaining` / `fightersRemaining`; call again until both reach 0.
// The weekly cron (?cron=1) also grades last week's snapshot.
const { sync } = require('../lib/store');
const { gradeAll } = require('../lib/grading');
const db = require('../lib/db');
const { param, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    if (!db.hasDb) return send(res, 400, { error: 'DATABASE_URL is not set — history sync needs Postgres.' });
    const result = await sync({ deadline: Date.now() + 45000 });
    const grading = param(req, 'cron') ? await gradeAll({ deadline: Date.now() + 6000 }).catch(err => ({ error: err.message })) : null;
    send(res, 200, { ...result, grading });
  } catch (err) { fail(res, err); }
};
