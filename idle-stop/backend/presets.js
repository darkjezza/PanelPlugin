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
    playerListCommand: 'list',
    banListCommand: 'banlist',
    stopMethod: 'console',
    stopCommand: 'stop',
    welcomeJoinRegex: '([A-Za-z0-9_.]{1,32}) joined the game',
  },
  source: {
    playerSource: 'a2s',
    playerCommand: '',
    playerRegex: '',
    playerListCommand: 'status',
    banListCommand: 'listid',
    stopMethod: 'console',
    stopCommand: 'quit',
    welcomeJoinRegex: '"([^"]{1,64})<\\d+><[^>]*><>" entered the game',
  },
  goldsrc: {
    playerSource: 'a2s',
    playerCommand: '',
    playerRegex: '',
    playerListCommand: 'status',
    banListCommand: 'listid',
    stopMethod: 'console',
    stopCommand: 'quit',
    welcomeJoinRegex: '"([^"]{1,64})<\\d+><[^>]*><>" entered the game',
  },
  // Requires the ValheimRcon mod (Source-RCON over TCP). Without it the
  // plugin falls back to the console roster below.
  valheim: {
    playerSource: 'rcon',
    playerCommand: 'players',
    playerRegex: 'Online (\\d+)',
    playerListCommand: 'players',
    banListCommand: 'banlist',
    stopMethod: 'agent',
    stopCommand: '',
    // ValheimRcon 1.6.2 defaults to a fixed port 2458 (not game port + 2).
    rconPortOffset: 0,
    rconDefaultPort: 2458,
    // Console join line gives a SteamID; the name is resolved over RCON.
    welcomeJoinRegex: 'Got connection SteamID (\\d+)',
    rosterJoinRegex: 'Got connection SteamID (\\d+)',
    rosterLeaveRegex: 'Closing socket (\\d+)',
  },
  palworld: {
    playerSource: 'rcon',
    playerCommand: 'ShowPlayers',
    playerRegex: '',
    playerListCommand: 'ShowPlayers',
    banListCommand: '',
    stopMethod: 'agent',
    stopCommand: '',
    rconPortOffset: 0,
    rconDefaultPort: 25575,
  },
  'project-zomboid': {
    playerSource: 'rcon',
    playerCommand: 'players',
    playerRegex: 'Players connected \\((\\d+)\\)',
    playerListCommand: 'players',
    banListCommand: '',
    stopMethod: 'agent',
    stopCommand: '',
    rconPortOffset: 0,
    rconDefaultPort: 27015,
  },
  'nuclear-option': {
    // Nuclear Option JSON-over-TCP remote commands (`-ServerRemoteCommands`).
    playerSource: 'nuclear',
    playerCommand: 'get-player-list',
    playerRegex: '',
    playerListCommand: 'get-player-list',
    banListCommand: '',
    stopMethod: 'agent',
    stopCommand: '',
    rconPortOffset: 0,
    rconDefaultPort: 7779,
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

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true';
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
  if (/(valheim)/.test(haystack)) {
    return 'valheim';
  }
  if (/(palworld|palserver)/.test(haystack)) {
    return 'palworld';
  }
  if (/(zomboid|pzserver|project-?zomboid)/.test(haystack)) {
    return 'project-zomboid';
  }
  if (/(nuclearoption|nuclear-option|nuclear_option)/.test(haystack)) {
    return 'nuclear-option';
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
  const playerCommand = pick('playerCommand', '');
  const playerRegex = pick('playerRegex', '');
  if (playerSource === 'auto') {
    playerSource = playerCommand && playerRegex ? 'rcon' : preset.playerSource || 'a2s';
  }

  return {
    preset: presetName,
    graceSeconds: Math.max(0, toNumber(pick('graceSeconds', 300), 300)),
    emptyThreshold: Math.max(0, toNumber(pick('emptyThreshold', 0), 0)),
    minServerUptimeSeconds: Math.max(0, toNumber(pick('minServerUptimeSeconds', 180), 180)),
    checkIntervalSeconds: Math.max(15, toNumber(pick('checkIntervalSeconds', 30), 30)),
    stopMethod: pick('stopMethod', 'console'),
    stopCommand: String(pick('stopCommand', preset.stopCommand || '') || '').trim(),
    stopRetrySeconds: Math.max(0, toNumber(pick('stopRetrySeconds', 120), 120)),
    playerSource,
    playerCommand: String(playerCommand || '').trim(),
    playerRegex: String(playerRegex || '').trim(),
    playerListCommand: String(pick('playerListCommand', '') || '').trim(),
    banListCommand: String(pick('banListCommand', '') || '').trim(),
    rosterJoinRegex: String(pick('rosterJoinRegex', '') || ''),
    rosterLeaveRegex: String(pick('rosterLeaveRegex', '') || ''),
    queryHost: String(pick('queryHost', '') || '').trim(),
    queryPort: Math.max(0, toNumber(pick('queryPort', 0), 0)),
    rconHost: String(pick('rconHost', '') || '').trim(),
    rconPort: Math.max(0, toNumber(pick('rconPort', 0), 0)),
    // 0 means "no offset", so it must not shadow the preset's value.
    rconPortOffset: Math.max(0, toNumber(firstSet(per.rconPortOffset || undefined, global.rconPortOffset || undefined, preset.rconPortOffset), 0)),
    rconDefaultPort: Math.max(0, toNumber(firstSet(per.rconDefaultPort || undefined, preset.rconDefaultPort), 0)),
    rconPassword: String(firstSet(per.rconPassword, global.rconPassword) || ''),
    welcomeEnabled: toBool(pick('welcomeEnabled', false), false),
    welcomeMessage: String(pick('welcomeMessage', 'Welcome, {player}!') || ''),
    welcomeOnExisting: toBool(pick('welcomeOnExisting', false), false),
    welcomeConsole: toBool(pick('welcomeConsole', true), true),
    welcomeJoinRegex: String(pick('welcomeJoinRegex', '') || ''),
    defaultBanMinutes: Math.max(0, toNumber(pick('defaultBanMinutes', 0), 0)),
    defaultBanReason: String(pick('defaultBanReason', '') || '').trim(),
  };
}

/** Remove secret material before echoing settings back to an API caller. */
export function redactSettings(settings) {
  const { rconPassword, ...rest } = settings;
  return { ...rest, rconPasswordSet: Boolean(rconPassword) };
}
