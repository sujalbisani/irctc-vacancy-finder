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

// IRCTC's online-charts date picker is not an advance-reservation calendar --
// it's for reading charts that are already, or about to be, prepared. Probed
// directly against the live picker across a wide offset range: day-offsets
// -1, 0 and +1 from today are selectable (covers overnight journeys whose
// chart is still relevant a day either side); everything outside that gets
// silently rejected by IRCTC's own picker (snaps back, no `disabled`
// attribute -- it doesn't even fail loudly on their end). Reject out-of-
// window dates here, before spending a browser/tunnel round-trip on a search
// IRCTC will refuse anyway.
function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
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

  // confirmtkt candidates already carry a trainName; a direct train-number
  // lookup doesn't, so fall back to the name IRCTC's own page showed us.
  const trainName = train.trainName || chart.trainDisplayName || `Train ${train.trainNumber}`;

  if (!routeIndex.has(toCode)) {
    return {
      ...train,
      trainName,
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

  return { ...train, trainName, chartStatus: 'ok', chartMeta: chart.chartMeta, usableVacancies, splitOptions, partialCoverageOnly };
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
  if (date < yesterdayISO() || date > tomorrowISO()) {
    return res.status(400).json({
      error: 'date_out_of_range',
      message: "IRCTC's online-charts tool only covers yesterday, today, or tomorrow's journeys -- it can't look up far-future advance reservation dates.",
    });
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

// Direct train-number lookup: skips confirmtkt route discovery entirely for
// someone who already knows which train they're checking (e.g. it's already
// on their ticket, or confirmtkt's route search doesn't surface it for some
// reason). Reuses the exact same job/poll machinery and coverage logic as the
// station-to-station search above -- just a single-train "candidate list".
const TRAIN_NUMBER_RE = /^\d{3,6}$/;

router.post('/train', rateLimit, async (req, res) => {
  const trainNumber = String(req.body.trainNumber || req.query.trainNumber || '').trim();
  const fromCode = String(req.body.from || req.query.from || '').trim().toUpperCase();
  const toCode = String(req.body.to || req.query.to || '').trim().toUpperCase();
  const date = String(req.body.date || req.query.date || '').trim();

  if (!trainNumber || !fromCode || !toCode || !date) {
    return res.status(400).json({ error: 'missing_params', message: 'trainNumber, from, to and date are required.' });
  }
  if (!TRAIN_NUMBER_RE.test(trainNumber)) {
    return res.status(400).json({ error: 'invalid_train_number', message: 'Train number should be numeric, e.g. 12952.' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'invalid_date', message: 'date must be in YYYY-MM-DD format.' });
  }
  if (date < yesterdayISO() || date > tomorrowISO()) {
    return res.status(400).json({
      error: 'date_out_of_range',
      message: "IRCTC's online-charts tool only covers yesterday, today, or tomorrow's journeys -- it can't look up far-future advance reservation dates.",
    });
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

  const toCheck = [{ trainNumber, trainName: null, fromStationCode: fromCode, toStationCode: toCode }];

  const job = createJob({
    query: { from: fromStation, to: toStation, date, trainNumber },
    totalCandidates: 1,
    toCheck: 1,
    checked: 0,
    trains: [],
    trainsNotRunningOnDate: [],
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
