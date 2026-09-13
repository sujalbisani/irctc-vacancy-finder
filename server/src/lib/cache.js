class TTLCache {
  constructor() {
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }
}

module.exports = { TTLCache };
