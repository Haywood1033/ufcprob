// lib/dfs-optimizer.js — exact Classic-format lineup optimizer: 6 fighters, $50,000 cap,
// no positions. Runs in the browser (window.DFSOpt) and in node tests (module.exports).
//
// bestN is nflprob's 0/1 knapsack (exactly-N items, maximize points, weight = salary in $100
// units), kept as the FULL per-item-prefix table so reconstruction walks back by item index —
// the collapsed take[k][w] pointer version silently duplicated players in nflprob.
//
// Multiple lineups are built one at a time, each the exact best lineup that satisfies the rules
// against the lineups already chosen (exposure cap, minimum players different). Each is found by
// best-first branch and bound: solve without the uniqueness rule; if the answer overlaps an
// earlier lineup too much, branch on excluding each shared player (any valid lineup must drop
// at least one of them), and the first valid answer popped is optimal. Before every solve, any
// driver whom six cheaper-or-equal fighters all out-project is dropped: a lineup holding them can
// always swap one in, so it never changes the optimum but shrinks the knapsack a lot.
(function (root) {
  'use strict';
  const CAP = 50000, UNIT = 100, ROSTER = 6;

  // One flat buffer reused across solves: dp[(p * (n+1) + k) * Wd + w]. Multi-lineup builds run
  // thousands of solves, and allocating fresh tables each time dominated the run time.
  let buf = new Float64Array(0);
  function bestN(players, budgetUnits, n) {
    if (n === 0) return { points: 0, salary: 0, players: [] };
    if (budgetUnits < 0 || players.length < n) return null;
    const NEG = -Infinity, P = players.length, Wd = budgetUnits + 1, K = n + 1;
    const size = (P + 1) * K * Wd;
    if (buf.length < size) buf = new Float64Array(size);
    const dp = buf;
    dp.fill(NEG, 0, K * Wd);
    dp.fill(0, 0, Wd); // p = 0, k = 0
    const wts = players.map(x => Math.round(x.salary / UNIT));
    for (let p = 1; p <= P; p++) {
      const w = wts[p - 1], v = players[p - 1].points;
      const prevBase = (p - 1) * K * Wd, curBase = p * K * Wd;
      for (let k = 0; k <= n; k++) {
        const pk = prevBase + k * Wd, pk1 = prevBase + (k - 1) * Wd, ck = curBase + k * Wd;
        for (let wt = 0; wt < Wd; wt++) {
          let best = dp[pk + wt];
          if (k && wt >= w) { const b = dp[pk1 + wt - w]; if (b !== NEG && b + v > best) best = b + v; }
          dp[ck + wt] = best;
        }
      }
    }
    const last = P * K * Wd + n * Wd;
    let bestW = -1;
    for (let wt = 0; wt < Wd; wt++) if (dp[last + wt] > NEG && (bestW < 0 || dp[last + wt] > dp[last + bestW] + 1e-9)) bestW = wt;
    if (bestW < 0) return null;
    const chosen = [];
    let k = n, wt = bestW;
    for (let p = P; p >= 1 && k > 0; p--) {
      // Item p-1 wasn't needed if the prefix without it already reaches this value.
      if (dp[(p * K + k) * Wd + wt] === dp[((p - 1) * K + k) * Wd + wt]) continue;
      chosen.push(players[p - 1]);
      wt -= wts[p - 1]; k--;
    }
    const salary = chosen.reduce((s, x) => s + x.salary, 0);
    return { points: dp[last + bestW], salary, players: chosen };
  }

  // Drop fighters dominated by 6 others (salary <= theirs and points >= theirs): exact pruning.
  function prune(players, keep) {
    const sorted = [...players].sort((a, b) => a.salary - b.salary || b.points - a.points);
    return sorted.filter(p => {
      if (keep.has(p.id)) return true;
      let n = 0;
      for (const q of sorted) {
        if (q.salary > p.salary) break;
        if (q !== p && q.points >= p.points) { n++; if (n >= ROSTER) return false; }
      }
      return true;
    });
  }

  // Best lineup with some players forced in and some forced out (by id).
  function solve(pool, forcedIn, forcedOut, cap) {
    const ins = pool.filter(p => forcedIn.has(p.id));
    if (ins.length > ROSTER) return null;
    const used = ins.reduce((s, p) => s + p.salary, 0);
    if (used > cap) return null;
    const rest = prune(pool.filter(p => !forcedIn.has(p.id) && !forcedOut.has(p.id)), new Set());
    const r = bestN(rest, Math.floor((cap - used) / UNIT), ROSTER - ins.length);
    if (!r) return null;
    const players = [...ins, ...r.players].sort((a, b) => b.salary - a.salary);
    return { players, points: players.reduce((s, p) => s + p.points, 0), salary: used + r.salary };
  }

  // pool: [{id, name, salary, points}] · opts: {count, locks, excludes, maxExposure (0..1),
  // minUnique (players that must differ from every earlier lineup), cap, maxNodes per lineup,
  // timeLimitMs, onProgress(built, count)}
  function buildLineups(pool, opts = {}) {
    const count = opts.count || 1, cap = opts.cap || CAP;
    const locks = new Set(opts.locks || []), excludes = new Set(opts.excludes || []);
    const maxUse = opts.maxExposure ? Math.max(1, Math.floor(opts.maxExposure * count + 1e-9)) : Infinity;
    const maxShared = ROSTER - Math.max(1, opts.minUnique || 1);
    const maxNodes = opts.maxNodes || 600;
    const usable = pool.filter(p => p.salary > 0 && isFinite(p.points));
    const prior = opts.prior || [];
    const lineups = [...prior], usage = new Map();
    for (const l of prior) for (const p of l.players) usage.set(p.id, (usage.get(p.id) || 0) + 1);
    const opp = new Map();
    for (const [x, y] of opts.opponents || []) { opp.set(x, y); opp.set(y, x); }
    let examined = 0, reason = null;
    const deadline = opts.timeLimitMs ? Date.now() + opts.timeLimitMs : Infinity;

    for (let n = 0; n < count; n++) {
      if (Date.now() > deadline) { reason = `Built ${n} of ${count} before the time limit — fewer lineups or looser rules will finish.`; break; }
      const capped = usable.filter(p => !locks.has(p.id) && (usage.get(p.id) || 0) >= maxUse).map(p => p.id);
      const baseOut = new Set([...excludes, ...capped]);
      const heap = [];
      const push = node => {
        let lo = 0, hi = heap.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (heap[mid].sol.points >= node.sol.points) lo = mid + 1; else hi = mid; }
        heap.splice(lo, 0, node);
      };
      const seen = new Set();
      const first = solve(usable, locks, baseOut, cap);
      if (first) push({ sol: first, outs: baseOut });
      let found = null, nodes = 0;
      while (heap.length && nodes < maxNodes) {
        const node = heap.shift();
        nodes++;
        const ids = new Set(node.sol.players.map(p => p.id));
        // Opponents in one lineup: any valid lineup drops at least one of the two — branch on each.
        const pair = node.sol.players.find(p => opp.has(p.id) && ids.has(opp.get(p.id)));
        const clash = pair ? { players: [pair, node.sol.players.find(p => p.id === opp.get(pair.id))] } : lineups.find(l => l.players.filter(p => ids.has(p.id)).length > maxShared);
        if (!clash) { found = node.sol; break; }
        for (const p of clash.players) {
          if (!ids.has(p.id) || locks.has(p.id)) continue;
          const outs = new Set(node.outs); outs.add(p.id);
          const key = [...outs].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const sol = solve(usable, locks, outs, cap);
          if (sol) push({ sol, outs });
        }
      }
      examined += nodes;
      if (!found) {
        reason = n === 0 ? 'No lineup fits the cap with these locks/excludes.'
          : nodes >= maxNodes ? `Built ${n} of ${count}: the next lineup needed more search than allowed — loosen the exposure cap or uniqueness rule.`
          : `Only ${n} lineups satisfy these rules (exposure cap ${opts.maxExposure ? Math.round(opts.maxExposure * 100) + '%' : 'none'}, ${ROSTER - maxShared} unique per lineup).`;
        break;
      }
      lineups.push(found);
      for (const p of found.players) usage.set(p.id, (usage.get(p.id) || 0) + 1);
      if (opts.onProgress) opts.onProgress(n + 1, count);
    }
    return { lineups: lineups.slice(prior.length), examined, reason };
  }

  // ── Simulation-scored lineups ──────────────────────────────────────────────────────────
  // A lineup's average is just the sum of its fighters' averages, but its spread is not: laps
  // led and fastest laps are one pool, so two front-runners mostly split it and rarely both
  // have their best day in the same race. Ceilings (what tournaments pay for) therefore have to
  // be measured on whole lineups, race by race. Candidates come from the exact solver
  // (on average points and on each driver's upside, and, with a dominator cap, once per allowed
  // set of dominators), then every candidate is scored race by race against a sample of the
  // simulated races, so its ceiling includes how its fighters' points move together. The best lineups by the contest's metric are kept, subject to exposure and
  // uniqueness.
  // sample: { n, ids: [...], data: Int16Array (driver-major, points × 10) }
  // opts: { count, metric: 'mean'|'ceiling', locks, excludes, maxExposure, minUnique,
  //         dominators: [ids], maxDominators, opponents: [[id, id]], onProgress }
  // `opponents`: pairs that may not share a lineup (UFC: the two fighters in one bout, whose win
  // bonuses cancel).
  function quantile(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }
  function scoreLineup(rows, n) {
    const tot = new Float64Array(n);
    for (const r of rows) for (let k = 0; k < n; k++) tot[k] += r[k];
    let sum = 0; for (let k = 0; k < n; k++) sum += tot[k];
    const sorted = Float64Array.from(tot).sort();
    return { mean: sum / n / 10, p50: quantile(sorted, 0.5) / 10, ceiling: quantile(sorted, 0.9) / 10 };
  }
  function* subsets(arr, k, start = 0, acc = []) {
    if (acc.length === k) { yield acc.slice(); return; }
    for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); yield* subsets(arr, k, i + 1, acc); acc.pop(); }
  }
  function buildSimLineups(pool, sample, opts = {}) {
    const count = opts.count || 1, metric = opts.metric === 'ceiling' ? 'ceiling' : 'mean';
    const rowOf = new Map(sample.ids.map((id, i) => [id, sample.data.subarray(i * sample.n, (i + 1) * sample.n)]));
    const usable = pool.filter(p => p.salary > 0 && rowOf.has(p.id));
    const doms = (opts.dominators || []).filter(id => usable.some(p => p.id === id)).slice(0, 6);
    const domSet = new Set(doms);
    const maxDom = opts.maxDominators ?? Infinity;
    const oppOf = new Map();
    for (const [x, y] of opts.opponents || []) { oppOf.set(x, y); oppOf.set(y, x); }
    const clash = ids => ids.some(id => oppOf.has(id) && ids.includes(oppOf.get(id)));
    const excludes = new Set(opts.excludes || []), locks = opts.locks || [];
    // Generation runs: each excludes the dominators outside one allowed set.
    const allowedSets = maxDom >= doms.length ? [doms] : [...subsets(doms, maxDom)];
    const objectives = [p => p.points, p => p.ceiling ?? p.points];
    const runs = allowedSets.length * objectives.length;
    // Enough candidates to choose `count` from after the rules, spread across runs. Generation
    // itself asks for variety (2 unique, 60% exposure) so the final rules have room to work.
    const per = Math.max(10, Math.ceil(Math.max(120, (opts.count || 1) * 8) / runs));
    const cands = new Map();
    let done = 0;
    for (const keep of allowedSets) {
      const outs = new Set([...excludes, ...doms.filter(d => !keep.includes(d) && !locks.includes(d))]);
      for (const obj of objectives) {
        const res = buildLineups(usable.map(p => ({ ...p, points: obj(p) })), { count: per, locks, excludes: [...outs], minUnique: 2, maxExposure: 0.6, maxNodes: 150, timeLimitMs: Math.max(1500, 20000 / runs), opponents: opts.opponents });
        for (const l of res.lineups) {
          const ids = l.players.map(p => p.id).sort();
          const key = ids.join('|');
          if (!cands.has(key)) cands.set(key, ids);
        }
        done++;
        if (opts.onProgress) opts.onProgress(done, runs);
      }
    }
    const byId = new Map(usable.map(p => [p.id, p]));
    const scored = [...cands.values()].map(ids => {
      const players = ids.map(id => byId.get(id)).sort((a, b) => b.salary - a.salary);
      const sc = scoreLineup(ids.map(id => rowOf.get(id)), sample.n);
      const naive = players.reduce((s, p) => s + p.points, 0);
      return { players, salary: players.reduce((s, p) => s + p.salary, 0), points: sc.mean, mean: sc.mean, p50: sc.p50, ceiling: sc.ceiling, naive, dominators: ids.filter(id => domSet.has(id)).length };
    }).filter(l => l.dominators <= maxDom && l.salary <= (opts.cap || CAP) && !clash(l.players.map(p => p.id)))
      .sort((a, b) => b[metric] - a[metric] || b.mean - a.mean);
    const maxUse = opts.maxExposure ? Math.max(1, Math.floor(opts.maxExposure * count + 1e-9)) : Infinity;
    const maxShared = ROSTER - Math.max(1, opts.minUnique || 1);
    const lockSet = new Set(locks), usage = new Map(), lineups = [];
    for (const l of scored) {
      if (lineups.length >= count) break;
      if (l.players.some(p => !lockSet.has(p.id) && (usage.get(p.id) || 0) >= maxUse)) continue;
      const ids = new Set(l.players.map(p => p.id));
      if (lineups.some(x => x.players.filter(p => ids.has(p.id)).length > maxShared)) continue;
      lineups.push(l);
      for (const p of l.players) usage.set(p.id, (usage.get(p.id) || 0) + 1);
    }
    // Short of `count`: let the exact solver build the rest directly under the final rules (it
    // respects exposure and uniqueness against what's already chosen), then score each the same
    // way and keep those within the dominator cap.
    if (lineups.length < count) {
      const objective = metric === 'ceiling' ? (p => p.ceiling ?? p.points) : (p => p.points);
      const objPool = usable.map(p => ({ ...p, points: objective(p) }));
      let stalls = 0;
      while (lineups.length < count && stalls < allowedSets.length) {
        let added = false;
        for (const keep of allowedSets) {
          if (lineups.length >= count) break;
          const capped = usable.filter(p => !lockSet.has(p.id) && (usage.get(p.id) || 0) >= maxUse).map(p => p.id);
          const res = buildLineups(objPool, { count: 1, locks, prior: lineups, minUnique: opts.minUnique || 1, maxNodes: 400, timeLimitMs: 3000, opponents: opts.opponents,
            excludes: [...excludes, ...capped, ...doms.filter(d => !keep.includes(d) && !lockSet.has(d))] });
          const f = res.lineups[0];
          if (!f) continue;
          const ids = f.players.map(p => p.id);
          const domN = ids.filter(id => domSet.has(id)).length;
          if (domN > maxDom || clash(ids)) continue;
          const players = ids.map(id => byId.get(id)).sort((a, b) => b.salary - a.salary);
          const sc = scoreLineup(ids.map(id => rowOf.get(id)), sample.n);
          lineups.push({ players, salary: players.reduce((t, p) => t + p.salary, 0), points: sc.mean, mean: sc.mean, p50: sc.p50, ceiling: sc.ceiling, naive: players.reduce((t, p) => t + p.points, 0), dominators: domN });
          for (const id of ids) usage.set(id, (usage.get(id) || 0) + 1);
          added = true;
        }
        stalls = added ? 0 : stalls + 1;
      }
    }
    return {
      lineups, candidates: scored.length, sims: sample.n, metric,
      reason: lineups.length < count ? `${lineups.length} of ${count} lineups pass the rules out of ${scored.length} candidates scored — loosen exposure, uniqueness or the dominator cap for more.` : null,
    };
  }

  const api = { bestN, solve, prune, buildLineups, buildSimLineups, scoreLineup, CAP, ROSTER };
  // Inside a Web Worker: build on request and stream progress back to the page.
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = e => {
      const { pool, opts, sample } = e.data;
      const onProgress = (built, count) => root.postMessage({ type: 'progress', built, count });
      const out = sample ? buildSimLineups(pool, sample, { ...opts, onProgress }) : buildLineups(pool, { ...opts, onProgress });
      root.postMessage({ type: 'done', ...out });
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DFSOpt = api;
})(typeof self !== 'undefined' ? self : this);
