/**
 * Idle Stop — Steam persona-name lookup.
 *
 * Resolves SteamID64s to display names with the Steam Web API
 * (ISteamUser/GetPlayerSummaries), batched (100 per call) and cached so we
 * don't hammer the API on every poll. Requires a Steam Web API key:
 * https://steamcommunity.com/dev/apikey
 *
 * Pure Node (global fetch), no dependencies.
 */

const NAME_TTL_MS = 10 * 60 * 1000;
const MISS_TTL_MS = 2 * 60 * 1000;
const cache = new Map(); // steamid -> { name, at, ttl }

function isValidSteamId(id) {
  return /^\d{17}$/.test(String(id || ''));
}

/**
 * @param {string[]} steamids
 * @param {string} apiKey
 * @returns {Promise<Record<string, string>>} map of steamid -> persona name
 */
export async function resolveSteamNames(steamids, apiKey) {
  const result = {};
  if (!apiKey) return result;
  const ids = [...new Set((steamids || []).map(String).filter(isValidSteamId))];
  if (!ids.length) return result;

  const now = Date.now();
  const need = [];
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && now - hit.at < hit.ttl) {
      if (hit.name) result[id] = hit.name;
      continue;
    }
    need.push(id);
  }

  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    try {
      const url =
        'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=' +
        encodeURIComponent(apiKey) +
        '&steamids=' +
        batch.join(',');
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const json = await res.json().catch(() => null);
      const players = (json && json.response && json.response.players) || [];
      const got = new Map(players.map((p) => [String(p.steamid), p.personaname]));
      for (const id of batch) {
        const name = got.get(id) || null;
        cache.set(id, { name, at: Date.now(), ttl: name ? NAME_TTL_MS : MISS_TTL_MS });
        if (name) result[id] = name;
      }
    } catch {
      /* leave this batch unresolved; names fall back to the SteamID */
    }
  }

  // Keep the cache from growing without bound.
  if (cache.size > 5000) {
    for (const [id, hit] of cache) {
      if (now - hit.at > NAME_TTL_MS) cache.delete(id);
    }
  }
  return result;
}
