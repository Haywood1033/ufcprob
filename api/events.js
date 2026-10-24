// GET /api/events — upcoming and recent events for the event picker.
const { listEvents } = require('../lib/card');
const { send, fail } = require('./_util');

module.exports = async (req, res) => {
  try { send(res, 200, await listEvents(), 1800); } catch (err) { fail(res, err); }
};
