const { fetchJsonWithRetry } = require('./httpRetry');
const ntesStations = require('./ntesStations');

const AUTOSUGGEST_URL = 'https://cttrainsapi.confirmtkt.com/api/v2/trains/stations/auto-suggestion';

/**
 * Live station search via confirmtkt's public autosuggest API. Used instead of
 * a bundled static station list because those (e.g. the CC0 datameet/railways
 * dataset) are years stale -- they still show renamed/superseded codes like
 * BCT for Mumbai Central instead of the current MMCT, or Mughal Sarai/Allahabad
 * instead of their current names/codes (DDU/PRYJ). confirmtkt's list is kept
 * current because it's used for real bookings.
 *
 * Falls back to NTES's own autocomplete (lib/ntesStations.js) if confirmtkt's
 * endpoint is down, since that's been observed to have extended flaky periods.
 */
async function confirmtktSearch(query, limit) {
  const params = new URLSearchParams({
    searchString: query.trim(),
    sourceStnCode: '',
    popularStnListLimit: String(Math.max(limit, 1)),
    preferredStnListLimit: '6', // confirmtkt's API 500s if this is 0; 6 matches their own frontend
    channel: 'mwebd',
    language: 'EN',
  });

  const json = await fetchJsonWithRetry(`${AUTOSUGGEST_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRCTCVacancyTool/1.0)' },
  });
  const list = json?.data?.stationList || [];

  const seenCodes = new Set();
  const out = [];
  for (const s of list) {
    if (!s.stationCode || /all stations/i.test(s.stationName || '')) continue;
    if (seenCodes.has(s.stationCode)) continue;
    seenCodes.add(s.stationCode);
    out.push({ code: s.stationCode, name: s.stationName, city: s.city || null, state: s.state || null });
    if (out.length >= limit) break;
  }
  return out;
}

async function search(query, limit = 15) {
  if (!query || query.trim().length < 2) return [];
  try {
    return await confirmtktSearch(query, limit);
  } catch (err) {
    try {
      return await ntesStations.search(query, limit);
    } catch {
      throw new Error(`station search failed: ${err.message}`);
    }
  }
}

async function getByCode(code) {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  const results = await search(normalized, 10);
  const match = results.find((s) => s.code === normalized);
  if (match) return match;
  // Some valid codes (e.g. very short/rare ones) may not surface in the
  // fuzzy search results above -- fall back to NTES's exact lookup.
  try {
    return await ntesStations.getByCode(normalized);
  } catch {
    return null;
  }
}

module.exports = { search, getByCode };
