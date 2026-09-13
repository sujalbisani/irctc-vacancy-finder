/**
 * Greedy minimum-interval cover: given a target route-index range [start, end)
 * and a list of candidate intervals ({ fromIdx, toIdx, ...meta }), returns an
 * ordered chain of intervals that together cover [start, end] with no gaps
 * (each next interval must already be vacant at or before where the previous
 * one's coverage ends), preferring the fewest possible seat changes.
 *
 * Returns { chain, coveredUpTo, complete }. If `complete` is false, `chain`
 * is the best partial coverage found and `coveredUpTo` is the route-index it
 * reaches -- callers must not present this as full coverage.
 */
function coverJourney(intervals, start, end) {
  const candidates = intervals.filter((iv) => iv.toIdx > start && iv.fromIdx < end);
  const chain = [];
  const used = new Set();
  let covered = start;

  for (;;) {
    if (covered >= end) break;
    let best = null;
    for (const iv of candidates) {
      if (used.has(iv)) continue;
      if (iv.fromIdx <= covered && iv.toIdx > covered) {
        if (!best || iv.toIdx > best.toIdx) best = iv;
      }
    }
    if (!best) break;
    chain.push(best);
    used.add(best);
    covered = best.toIdx;
  }

  return { chain, coveredUpTo: covered, complete: covered >= end };
}

module.exports = { coverJourney };
