/**
 * Idle Stop — game presets and settings resolution.
 *
 * Precedence for every value: per-server override → global plugin config →
 * game preset default. Pure functions, no ctx, so they are easy to reason
 * about and test.
 */

export const PRESETS = {
  'minecraft-java': {
    playerSource: 'rcon',
    playerCommand: 'list',
    playerRegex: 'There are (\\d+) of a max',
    stopMethod: 'console',
    stopCommand: 'stop',
  },
  source: {
    playerSource: 'a2s',
    playerCommand: '',
    playerRegex: '',
    stopMethod: 'console',
    stopCommand: 'quit',
  },
  goldsrc: {
    playerSource: 'a2s',
    playerCommand: '',
    playerRegex: '',
    stopMethod: 'console',
    stopCommand: 'quit',
  },
  custom: {},
};

function firstSet(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Guess a preset from the server's startup command and environment. */
export function detectPreset(server) {
  let env = '';
  try {
    env = typeof server.environment === 'string' ? server.environment : JSON.stringify(server.environment || {});
  } catch {
    env = '';
  }
  const haystack = `${server.startupCommand || ''} ${env}`.toLowerCase();

  if (/(paper|purpur|spigot|bukkit|fabric|forge|minecraft|server\.jar|\.jar)/.test(haystack)) {
    return 'minecraft-java';
  }
  if (/(srcds|cs2|csgo|counter-strike|tf2|gmod|source)/.test(haystack)) {
    return 'source';
  }
  if (/(hlds|goldsrc|cstrike|cs1\.6|cs16|valve)/.test(haystack)) {
    return 'goldsrc';
  }
  return null;
}

/**
 * Resolve effective settings for one server.
 * @param {object} global resolved global config (see readGlobalConfig)
 * @param {object} server panel server row
 * @param {object} per    per-server override document (may be empty)
 */
export function resolveSettings(global, server, per = {}) {
  let presetName = firstSet(per.gamePreset, global.gamePreset === 'auto' ? undefined : global.gamePreset, detectPreset(server), 'custom');
  if (!PRESETS[presetName]) presetName = 'custom';
  const preset = PRESETS[presetName] || {};

  const pick = (key, fallback) => {
    const value = firstSet(per[key], global[key], preset[key]);
    return value === undefined ? fallback : value;
  };

  let playerSource = pick('playerSource', 'auto');
  let playerCommand = pick('playerCommand', '');
  const playerRegex = pick('playerRegex', '');
  if (playerSource === 'auto') {
    playerSource = playerCommand && playerRegex ? 'rcon' : preset.playerSource || 'a2s';
  }

  return {
    preset: presetName,
    graceSeconds: Math.max(0, toNumber(pick('graceSeconds', 300), 300)),
    emptyThreshold: Math.max(0, toNumber(pick('emptyThreshold', 0), 0)),
    minServerUptimeSeconds: Math.max(0, toNumber(pick('minServerUptimeSeconds', 180), 180)),
    checkIntervalSeconds: Math.max(30, toNumber(pick('checkIntervalSeconds', 60), 60)),
    stopMethod: pick('stopMethod', 'console'),
    stopCommand: String(pick('stopCommand', preset.stopCommand || '') || '').trim(),
    stopRetrySeconds: Math.max(0, toNumber(pick('stopRetrySeconds', 120), 120)),
    playerSource,
    playerCommand: String(playerCommand || '').trim(),
    playerRegex: String(playerRegex || '').trim(),
    queryHost: String(pick('queryHost', '') || '').trim(),
    queryPort: Math.max(0, toNumber(pick('queryPort', 0), 0)),
    rconHost: String(pick('rconHost', '') || '').trim(),
    rconPort: Math.max(0, toNumber(pick('rconPort', 0), 0)),
    rconPassword: String(firstSet(per.rconPassword, global.rconPassword) || ''),
  };
}

/** Remove secret material before echoing settings back to an API caller. */
export function redactSettings(settings) {
  const { rconPassword, ...rest } = settings;
  return { ...rest, rconPasswordSet: Boolean(rconPassword) };
}
