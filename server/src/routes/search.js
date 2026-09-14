const express = require('express');
const stations = require('../lib/stations');
const confirmtkt = require('../lib/confirmtkt');
const irctcChart = require('../lib/irctcChart');
const { buildRouteIndex } = require('../lib/overlap');
const { coverJourney } = require('../lib/coverage');
const { TTLCache } = require('../lib/cache');
const { createJob, getJob, updateJob } = require('../lib/jobs');

const router = express.Router();
const chartCache = new TTLCache();
const CHART_CACHE_TTL_MS = 90 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// No artificial cap by default -- every direct train candidate gets checked.
// MAX_TRAIN_LIMIT is just a sanity ceiling against pathological input, not a
// practical limit for real routes.
const MAX_TRAIN_LIMIT = 200;

// Each search drives a real browser through IRCTC via a single phone's
// mobile-data tunnel -- a script (or an impatient double-click) hammering
// this endpoint can exhaust that shared, limited resource for everyone.
// One new search per IP per window is plenty for genuine use.
const RATE_LIMIT_WINDOW_MS = 20 * 1000;
const rateLimitCache = new TTLCache();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimitCache.get(ip)) {
    return res
      .status(429)
      .json({ error: 'rate_limited', message: 'Please wait a few seconds before starting another search.' });
  }
  rateLimitCache.set(ip, true, RATE_LIMIT_WINDOW_MS);
  next();
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function getChartCached(trainNumber, date, boardingCode) {
  const key = `${trainNumber}|${date}|${boardingCode}`;
  const cached = chartCache.get(key);
  if (cached) return cached;
  const result = await irctcChart.fetchChart(trainNumber, date, boardingCode);
  chartCache.set(key, result, CHART_CACHE_TTL_MS);
  return result;
}

/** Checks one train's chart and computes usable/split/partial vacancy options for the requested segment. */
async function checkTrain(train, fromCode, toCode, date) {
  const chart = await getChartCached(train.trainNumber, date, fromCode);
  const routeIndex = buildRouteIndex(chart.routeCodes);

  if (!routeIndex.has(toCode)) {
    return {
      ...train,
      chartStatus: 'route_mismatch',
      message: 'IRCTC route data for this train does not include the requested destination station.',
    };
  }

  const uf = routeIndex.get(fromCode);
  const ut = routeIndex.get(toCode);

  const usableVacancies = [];
  const splitOptions = [];
  const partialCoverageOnly = [];

  for (const cls of chart.classes) {
    const rowsWithIdx = cls.rows
      .map((row) => ({ row, fromIdx: routeIndex.get(row.fromStationCode), toIdx: routeIndex.get(row.toStationCode) }))
      .filter((r) => r.fromIdx !== undefined && r.toIdx !== undefined && r.fromIdx < r.toIdx);

    const fullCoverageRows = rowsWithIdx.filter((r) => r.fromIdx <= uf && r.toIdx >= ut);

    if (fullCoverageRows.length > 0) {
      for (const { row } of fullCoverageRows) {
        usableVacancies.push({
          class: cls.code,
          classLabel: cls.label,
          coach: row.coach,
          berthNo: row.berthNo,
          berthType: row.berthType,
          cabin: row.cabin,
          cabinNo: row.cabinNo,
          vacantFrom: row.fromStationText,
          vacantUntil: row.toStationText,
        });
      }
      continue;
    }

    const { chain, coveredUpTo, complete } = coverJourney(rowsWithIdx, uf, ut);
    if (chain.length > 1 && complete) {
      splitOptions.push({
        class: cls.code,
        classLabel: cls.label,
        seatChanges: chain.length - 1,
        segments: chain.map(({ row }) => ({
          coach: row.coach,
          berthNo: row.berthNo,
          berthType: row.berthType,
          cabin: row.cabin,
          cabinNo: row.cabinNo,
          vacantFrom: row.fromStationText,
          vacantUntil: row.toStationText,
        })),
      });
    } else if (chain.length > 0) {
      const lastLeg = chain[chain.length - 1].row;
      partialCoverageOnly.push({
        class: cls.code,
        classLabel: cls.label,
        reachedStationCode: chart.routeCodes[coveredUpTo] || null,
        reachedStationName: lastLeg.toStationText,
        stationsShortOfDestination: Math.max(ut - coveredUpTo, 0),
        seatChanges: chain.length - 1,
        segments: chain.map(({ row }) => ({
          coach: row.coach,
          berthNo: row.berthNo,
          berthType: row.berthType,
          cabin: row.cabin,
          cabinNo: row.cabinNo,
          vacantFrom: row.fromStationText,
          vacantUntil: row.toStationText,
        })),
      });
    }
  }

  return { ...train, chartStatus: 'ok', chartMeta: chart.chartMeta, usableVacancies, splitOptions, partialCoverageOnly };
}

async function runSearchJob(job, fromCode, toCode, date, toCheck) {
  for (const train of toCheck) {
    try {
      const result = await checkTrain(train, fromCode, toCode, date);
      job.trains.push(result);
    } catch (err) {
      job.trains.push({ ...train, chartStatus: 'unavailable', errorCode: err.code || 'UNKNOWN', message: err.message });
    }
    updateJob(job.id, { checked: job.trains.length });
  }
  updateJob(job.id, { status: 'done' });
}

router.post('/', rateLimit, async (req, res) => {
  const fromCode = String(req.body.from || req.query.from || '').trim().toUpperCase();
  const toCode = String(req.body.to || req.query.to || '').trim().toUpperCase();
  const date = String(req.body.date || req.query.date || '').trim();
  const requestedLimit = Number(req.body.limit || req.query.limit);
  const limit = Math.min(requestedLimit > 0 ? requestedLimit : MAX_TRAIN_LIMIT, MAX_TRAIN_LIMIT);

  if (!fromCode || !toCode || !date) {
    return res.status(400).json({ error: 'missing_params', message: 'from, to and date are required.' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'invalid_date', message: 'date must be in YYYY-MM-DD format.' });
  }
  if (date < todayISO()) {
    return res.status(400).json({ error: 'date_in_past', message: 'Journey date cannot be in the past.' });
  }

  let fromStation;
  let toStation;
  try {
    fromStation = await stations.getByCode(fromCode);
    toStation = await stations.getByCode(toCode);
  } catch (err) {
    return res.status(502).json({ error: 'station_lookup_failed', message: err.message });
  }
  if (!fromStation) {
    return res.status(400).json({ error: 'invalid_station', field: 'from', message: `Unknown station code: ${fromCode}` });
  }
  if (!toStation) {
    return res.status(400).json({ error: 'invalid_station', field: 'to', message: `Unknown station code: ${toCode}` });
  }
  if (fromCode === toCode) {
    return res.status(400).json({ error: 'same_station', message: 'From and To stations must be different.' });
  }

  let candidates;
  try {
    candidates = await confirmtkt.trainsBetweenStations(fromCode, toCode, date);
  } catch (err) {
    return res.status(502).json({ error: 'train_search_failed', message: err.message });
  }

  const runningTrains = candidates.filter((t) => t.runsOnRequestedDate);
  const notRunningTrains = candidates.filter((t) => !t.runsOnRequestedDate);
  const toCheck = runningTrains.slice(0, limit);

  const job = createJob({
    query: { from: fromStation, to: toStation, date },
    totalCandidates: candidates.length,
    toCheck: toCheck.length,
    checked: 0,
    trains: [],
    trainsNotRunningOnDate: notRunningTrains,
  });

  runSearchJob(job, fromCode, toCode, date, toCheck).catch((err) => {
    updateJob(job.id, { status: 'error', error: err.message });
  });

  res.status(202).json({ jobId: job.id });
});

router.get('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'job_not_found', message: 'Unknown or expired search job.' });
  }
  res.json(job);
});

module.exports = router;
