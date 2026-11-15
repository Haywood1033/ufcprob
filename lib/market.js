// lib/market.js — the win chance the card shows: the model's own number blended with the Vegas
// line when ESPN lists one.
//
// Why: the line is sharper than the model. On 2,903 bouts from 2021 to Oct 2026 (the public
// nlbair/ufc-data odds history; every model chance predicted only from earlier bouts, blend
// weights fit only on earlier years):
//
//                         log loss   winner picked
//   model alone            0.648        62.5%
//   Vegas closing line     0.595        68.4%
//   Vegas opening line     0.618        64.4%
//   blend with closing     0.593        68.7%
//   blend with opening     0.612        67.2%
//
// Where model and line were 15+ points apart (896 bouts) the line's side won 74.4%, the model's
// 57.9%. On bouts with a UFC debutant the line scored 0.550 against the model's 0.655.
//
// The blend is a weighted sum in log-odds: logit(p) = wModel·logit(model) + wLine·logit(line).
// The fitted weights were stable year to year (model 0.12–0.20, line 1.09–1.16 on the closing
// line; model 0.43–0.53, line 0.90–1.03 on the opening line). A line read more than two days
// before the first bout is treated as an opening line, anything later as a closing line; the card
// locks at the first bout, so the locked numbers always use the closing weights.

const CLOSE = { model: 0.16, line: 1.13 }, OPEN = { model: 0.5, line: 0.98 };
const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = p => Math.log(clip(p) / (1 - clip(p)));
const sigmoid = z => 1 / (1 + Math.exp(-z));

const weightsAt = hoursToStart => (Number.isFinite(hoursToStart) && hoursToStart > 48 ? OPEN : CLOSE);

// model, line: fighter A's win chance from each (the line with the book's margin removed).
function blendWin(model, line, hoursToStart) {
  if (!(line > 0 && line < 1)) return model;
  const w = weightsAt(hoursToStart);
  return sigmoid(w.model * logit(model) + w.line * logit(line));
}

module.exports = { blendWin, weightsAt, logit, CLOSE, OPEN };
