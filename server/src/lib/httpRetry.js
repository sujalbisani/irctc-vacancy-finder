/** confirmtkt's public API occasionally 500s transiently; retry a couple of times before giving up. */
async function fetchJsonWithRetry(url, options = {}, { retries = 4, backoffMs = 700 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = { fetchJsonWithRetry };
