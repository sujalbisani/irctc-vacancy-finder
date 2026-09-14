const { fetchJsonWithRetry } = require('./httpRetry');
const { TTLCache } = require('./cache');
const ntesStations = require('./ntesStations');

const AUTOSUGGEST_URL = 'https://cttrainsapi.confirmtkt.com/api/v2/trains/stations/auto-suggestion';

// Station names/codes barely change -- cache search results aggressively so
// repeated or overlapping queries (retyping, switching between From/To,
// multiple users searching the same station) skip the network entirely.
const searchCache = new TTLCache();
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Collapses identical concurrent requests (e.g. React StrictMode's double
// effect invocation) into a single outbound call.
const inFlight = new Map();

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

  // This is a live-typing autocomplete -- a slow/failed attempt should fall
  // through to NTES quickly rather than burn multiple seconds retrying with
  // backoff (unlike the chart/train-search calls, which are worth waiting on).
  const json = await fetchJsonWithRetry(
    `${AUTOSUGGEST_URL}?${params.toString()}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRCTCVacancyTool/1.0)' } },
    { retries: 1, backoffMs: 250 }
  );
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

  const key = `${query.trim().toLowerCase()}|${limit}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const results = await confirmtktSearch(query, limit);
      searchCache.set(key, results, SEARCH_CACHE_TTL_MS);
      return results;
    } catch (err) {
      try {
        const results = await ntesStations.search(query, limit);
        searchCache.set(key, results, SEARCH_CACHE_TTL_MS);
        return results;
      } catch {
        throw new Error(`station search failed: ${err.message}`);
      }
    }
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
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
