const { fetchJsonWithRetry } = require('./httpRetry');

const NTES_AUTOCOMPLETE_URL = 'http://www.indianrail.gov.in/enquiry/FetchAutoComplete';
const CACHE_TTL_MS = 60 * 60 * 1000; // station list changes rarely; refetch hourly

let cache = null; // { list: [{code, name}], fetchedAt }

/**
 * Fallback station source for when confirmtkt's autosuggest API is down:
 * NTES's own (non-CAPTCHA) autocomplete endpoint, which returns the full
 * station roster as "NAME - CODE" strings in one shot. Not used as the
 * primary source because it still lists some superseded codes alongside
 * current ones (e.g. both "MUMBAI CENTRAL - BCT" and "- MMCT"); IRCTC's own
 * chart route data is the final arbiter of which code actually matches a
 * given train, so a stale code here just falls through as a route mismatch
 * rather than silently misleading anyone.
 */
async function loadAll() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.list;
  }
  const raw = await fetchJsonWithRetry(
    `${NTES_AUTOCOMPLETE_URL}?_=${Date.now()}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRCTCVacancyTool/1.0)' } },
    { retries: 2, backoffMs: 500 }
  );

  const list = [];
  for (const entry of raw) {
    const idx = entry.lastIndexOf(' - ');
    if (idx === -1) continue;
    const name = entry.slice(0, idx).trim();
    const code = entry.slice(idx + 3).trim();
    if (name && code) list.push({ code, name });
  }

  cache = { list, fetchedAt: Date.now() };
  return list;
}

async function search(query, limit = 15) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim().toUpperCase();
  const list = await loadAll();

  const starts = [];
  const contains = [];
  for (const s of list) {
    if (s.code === q) return [s];
    if (s.code.startsWith(q) || s.name.toUpperCase().startsWith(q)) starts.push(s);
    else if (s.name.toUpperCase().includes(q)) contains.push(s);
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

async function getByCode(code) {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  const list = await loadAll();
  return list.find((s) => s.code === normalized) || null;
}

module.exports = { search, getByCode };
