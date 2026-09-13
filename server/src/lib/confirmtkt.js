const { fetchJsonWithRetry } = require('./httpRetry');

const SEARCH_URL = 'https://cttrainsapi.confirmtkt.com/api/v1/trains/search';

function toDDMMYYYY(dateStr /* YYYY-MM-DD */) {
  const [y, m, d] = dateStr.split('-');
  return `${d}-${m}-${y}`;
}

/** 0 = Monday .. 6 = Sunday, matching IRCTC/NTES running-days string convention. */
function dayIndexMonFirst(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const jsDay = d.getDay(); // 0 = Sunday .. 6 = Saturday
  return (jsDay + 6) % 7;
}

/**
 * Find candidate trains between two stations for a given date, using
 * confirmtkt.com's public train-search API (no login/CAPTCHA). This is used
 * only for discovering which trains connect the two stations, running days,
 * and rough timings -- never for vacancy numbers, which always come from the
 * official IRCTC chart tool.
 */
async function trainsBetweenStations(fromCode, toCode, dateStr) {
  const params = new URLSearchParams({
    sourceStationCode: fromCode,
    destinationStationCode: toCode,
    dateOfJourney: toDDMMYYYY(dateStr),
    addAvailabilityCache: 'true',
    excludeMultiTicketAlternates: 'true',
    excludeBoostAlternates: 'true',
    sortBy: 'DEFAULT',
    enableNearby: 'false',
  });

  const json = await fetchJsonWithRetry(`${SEARCH_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRCTCVacancyTool/1.0)' },
  }).catch((err) => {
    throw new Error(`confirmtkt search failed: ${err.message}`);
  });
  const list = json?.data?.trainList || [];
  const dow = dayIndexMonFirst(dateStr);

  const seen = new Set();
  const out = [];
  for (const t of list) {
    // Strict match only -- reject any nearby/alternate-station substitution.
    if (t.fromStnCode !== fromCode || t.toStnCode !== toCode) continue;
    if (seen.has(t.trainNumber)) continue;
    seen.add(t.trainNumber);

    const runsOnRequestedDate = (t.runningDays || '').charAt(dow) === '1';
    out.push({
      trainNumber: t.trainNumber,
      trainName: (t.trainName || '').trim(),
      fromStationCode: t.fromStnCode,
      fromStationName: t.fromStnName,
      toStationCode: t.toStnCode,
      toStationName: t.toStnName,
      departureTime: t.departureTime,
      arrivalTime: t.arrivalTime,
      durationMinutes: t.duration,
      distanceKm: t.distance,
      runningDays: t.runningDays,
      runsOnRequestedDate,
      classes: t.avlClasses || [],
    });
  }
  return out;
}

module.exports = { trainsBetweenStations, toDDMMYYYY, dayIndexMonFirst };
