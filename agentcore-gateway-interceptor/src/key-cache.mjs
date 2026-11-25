/**
 * Keeps the API key for `ttlMs`. After the TTL, returns the cached key at once and reads the key again in the
 * background, so a slow or failed read does not block a call. `drop` discards the key and any read in flight.
 * @param {{ read: () => Promise<string>, ttlMs: number, now?: () => number }} options
 */
export function createKeyCache({ read, ttlMs, now = Date.now }) {
  let cached;
  let refreshing;
  let generation = 0;

  const load = async () => {
    const started = generation;
    const t = now();
    const key = await read();
    if (started === generation) cached = { key, expiresAt: t + ttlMs };
    return key;
  };

  return {
    async get() {
      if (!cached) return load();
      if (cached.expiresAt <= now() && !refreshing) {
        const refresh = load()
          .catch(() => {})
          .finally(() => {
            if (refreshing === refresh) refreshing = undefined;
          });
        refreshing = refresh;
      }
      return cached.key;
    },
    drop() {
      cached = undefined;
      refreshing = undefined;
      generation += 1;
    },
  };
}
