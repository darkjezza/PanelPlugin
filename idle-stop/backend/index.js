/**
 * Idle Stop — stop a game server once its last player leaves, plus player
 * administration (list, kick, ban, ban list, welcome).
 *
 * The panel does not expose player-join/leave events to plugins, so this
 * plugin polls a player source on a schedule:
 *
 *   - A2S query   (Source/CS2/GoldSrc) — player count and names, no password
 *   - Source RCON (Minecraft Java, custom) — status/list output parsing
 *
 * Confirmed-empty servers are stopped after a grace period. Query failures
 * never stop a server and never kick or ban anyone.
 *
 * Routes: /api/plugins/idle-stop/...
 */

import { a2sPlayerCount, a2sPlayers } from './a2s.js';
import { noCommand } from './nocmd.js';
import { rconExec } from './rcon.js';
import { redactSettings, resolveSettings } from './presets.js';
import {
  buildBan,
  buildBroadcastCommands,
  buildKick,
  buildUnban,
  buildWelcomeCommands,
  normalizeMinutes,
  parseBans,
  parsePlayers,
  playerKey,
  renderMessage,
  styleFor,
  usesRcon,
} from './game.js';

const SETTINGS_COLLECTION = 'idle_stop_servers';
const BANS_COLLECTION = 'idle_stop_bans';

const SERVER_SELECT = {
  id: true,
  name: true,
  uuid: true,
  status: true,
  nodeId: true,
  primaryIp: true,
  primaryPort: true,
  startupCommand: true,
  environment: true,
};

const ALLOWED_OVERRIDES = new Set([
  'enabled',
  'gamePreset',
  'graceSeconds',
  'emptyThreshold',
  'minServerUptimeSeconds',
  'checkIntervalSeconds',
  'stopMethod',
  'stopCommand',
  'stopRetrySeconds',
  'playerSource',
  'playerCommand',
  'playerRegex',
  'playerListCommand',
  'banListCommand',
  'rosterJoinRegex',
  'rosterLeaveRegex',
  'queryHost',
  'queryPort',
  'rconHost',
  'rconPort',
  'rconPortOffset',
  'rconDefaultPort',
  'rconPassword',
  'welcomeEnabled',
  'welcomeMessage',
  'welcomeOnExisting',
  'welcomeConsole',
  'welcomeJoinRegex',
  'defaultBanMinutes',
  'defaultBanReason',
  'note',
]);

// ValheimRcon has shipped under both config file names.
const VALHEIM_RCON_CFGS = [
  'BepInEx/config/rg.tristan.rcon.cfg',
  'BepInEx/config/org.tristan.rcon.cfg',
];
const PALWORLD_CONFIG_PATHS = [
  'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini',
  'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
];
const ZOMBOID_CONFIG_PATHS = [
  'Zomboid/Server/servertest.ini',
];
const RC_CONFIG_PATHS = [
  'server.properties',
  'server.cfg',
  'cstrike/server.cfg',
  'csgo/cfg/server.cfg',
  'tf/cfg/server.cfg',
  ...VALHEIM_RCON_CFGS,
  ...PALWORLD_CONFIG_PATHS,
  ...ZOMBOID_CONFIG_PATHS,
];
// File-tunnel requests can take up to 60s each; bound discovery hard and cache
// the result so a user-facing request never hangs into a proxy timeout.
const RC_DISCOVERY_TTL_MS = 5 * 60 * 1000;
// Recheck quickly after a miss so a fixed config is picked up within a minute.
const RC_DISCOVERY_MISS_TTL_MS = 60 * 1000;
const RC_DISCOVERY_TIMEOUT_MS = 8000;

const isValheimRconCfg = (path) => VALHEIM_RCON_CFGS.includes(path);

/** Config files most likely to hold the RCON password, in priority order. */
function configPathsFor(preset) {
  const rest = RC_CONFIG_PATHS.filter(
    (p) => !isValheimRconCfg(p) && !PALWORLD_CONFIG_PATHS.includes(p) && !ZOMBOID_CONFIG_PATHS.includes(p),
  );
  if (preset === 'valheim') return [...VALHEIM_RCON_CFGS, ...rest];
  if (preset === 'palworld') return [...PALWORLD_CONFIG_PATHS, ...rest];
  if (preset === 'project-zomboid') return [...ZOMBOID_CONFIG_PATHS, ...rest];
  if (preset === 'minecraft-java') return ['server.properties', ...rest.filter((p) => p !== 'server.properties')];
  return [...rest];
}
const PROBE_TIMEOUT_MS = 15000;
const rconPasswordCache = new Map();
const MAX_WELCOMES_PER_TICK = 20;

let ticking = false;
let loopTimer = null;
let disposed = false;

// Live console subscriptions (serverId -> { unsubscribe, touch }) so welcomes
// can fire on the join line instead of waiting for the next poll.
const consoleSubs = new Map();
const serverCache = new Map();
const settingsCache = new Map();

// Valheim has no query/RCON, so its roster is built from live console lines.
// serverId -> Map(steamid -> { steamid, name, since }) and the set of servers
// whose roster has been authoritative since their last observed start.
const rosterCache = new Map();
const rosterSeen = new Set();
// One in-flight console request/response capture per server (e.g. `banned`).
const consoleCaptures = new Map();
// Live diagnostics surfaced through GET /servers/:id (in-memory only).
const runtimeInfo = new Map();

function touchRuntime(serverId, patch) {
  runtimeInfo.set(serverId, { ...(runtimeInfo.get(serverId) || {}), ...patch });
}

// De-dup window between the console and poll welcome paths. Short enough that
// leaving and rejoining welcomes the player again, long enough to stop the two
// paths double-welcoming one join.
const WELCOME_DEDUP_MS = 60 * 1000;

function recentlyWelcomed(welcomed, name) {
  if (!name) return false;
  const at = welcomed && welcomed[String(name).toLowerCase()];
  return Boolean(at && Date.now() - at < WELCOME_DEDUP_MS);
}

function pruneWelcomed(welcomed) {
  const now = Date.now();
  const out = {};
  for (const [key, at] of Object.entries(welcomed || {})) {
    if (now - at < WELCOME_DEDUP_MS * 2) out[key] = at;
  }
  return out;
}

// ---------------------------------------------------------------- config ---

function readGlobalConfig(ctx) {
  const get = (key, fallback) => {
    const value = ctx.getConfig(key);
    return value === undefined || value === null ? fallback : value;
  };
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: get('enabled', true) !== false,
    autoManage: get('autoManage', false) === true,
    gamePreset: get('gamePreset', 'auto'),
    graceSeconds: num(get('graceSeconds', 300), 300),
    emptyThreshold: num(get('emptyThreshold', 0), 0),
    minServerUptimeSeconds: num(get('minServerUptimeSeconds', 180), 180),
    checkIntervalSeconds: num(get('checkIntervalSeconds', 30), 30),
    stopMethod: get('stopMethod', 'console'),
    stopCommand: get('stopCommand', ''),
    stopRetrySeconds: num(get('stopRetrySeconds', 120), 120),
    playerSource: get('playerSource', 'auto'),
    playerCommand: get('playerCommand', ''),
    playerRegex: get('playerRegex', ''),
    playerListCommand: get('playerListCommand', ''),
    banListCommand: get('banListCommand', ''),
    rosterJoinRegex: get('rosterJoinRegex', ''),
    rosterLeaveRegex: get('rosterLeaveRegex', ''),
    queryHost: get('queryHost', ''),
    queryPort: num(get('queryPort', 0), 0),
    rconHost: get('rconHost', ''),
    rconPort: num(get('rconPort', 0), 0),
    rconPassword: get('rconPassword', ''),
    welcomeEnabled: get('welcomeEnabled', true) === true,
    welcomeMessage: get('welcomeMessage', 'Welcome, {player}!'),
    welcomeOnExisting: get('welcomeOnExisting', false) === true,
    welcomeConsole: get('welcomeConsole', true) === true,
    welcomeJoinRegex: get('welcomeJoinRegex', ''),
    defaultBanMinutes: num(get('defaultBanMinutes', 0), 0),
    defaultBanReason: get('defaultBanReason', ''),
  };
}

function isManaged(global, per) {
  if (!global.enabled) return false;
  if (per && per.enabled === false) return false;
  if (per && per.enabled === true) return true;
  return global.autoManage === true;
}

// ----------------------------------------------------------------- state ---

async function readState(ctx, serverId) {
  return (await ctx.getStorage(`state:${serverId}`)) || {};
}

async function writeState(ctx, serverId, patch) {
  const next = { ...(await readState(ctx, serverId)), ...patch };
  await ctx.setStorage(`state:${serverId}`, next);
  return next;
}

/**
 * Forget everything this plugin learned about a server's current session:
 * player roster, welcomed players, idle timers and last errors. Ban records
 * are not touched.
 */
async function clearServerSession(ctx, serverId) {
  rosterCache.set(serverId, new Map());
  const state = await readState(ctx, serverId);
  await writeState(ctx, serverId, {
    roster: {},
    rosterSeen: state.rosterSeen === true,
    welcomed: {},
    knownPlayers: [],
    idleSince: null,
    firstSeenRunning: null,
    lastCheckAt: 0,
    lastCount: null,
    lastCountAt: null,
    lastError: null,
    lastErrorAt: null,
    lastWelcomeAt: null,
  });
}

async function loadOverrides(ctx) {
  const docs = await ctx.collection(SETTINGS_COLLECTION).find({});
  const map = new Map();
  for (const doc of docs || []) {
    if (doc && doc.serverId) map.set(doc.serverId, doc);
  }
  return map;
}

function emit(ctx, event, payload) {
  try {
    ctx.emit(event, payload);
  } catch (err) {
    ctx.logger.debug({ err: err?.message, event }, 'idle-stop emit failed');
  }
}

// ------------------------------------------------------------- endpoints ---

function parseHostPort(value) {
  const raw = String(value || '').trim();
  if (!raw) return { host: '', port: null };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    const host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : NaN;
    return { host, port: Number.isInteger(port) && port > 0 ? port : null };
  }
  const parts = raw.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { host: parts[0], port: Number(parts[1]) };
  }
  return { host: raw, port: null };
}

function normalizeHost(host) {
  const h = String(host || '').trim();
  if (!h || h === '0.0.0.0' || h === '::' || h === '::0') return '';
  return h;
}

function resolveEndpoint(configuredHost, configuredPort, server) {
  const parsed = parseHostPort(configuredHost);
  const host = normalizeHost(parsed.host) || normalizeHost(server.primaryIp);
  const port = Number(configuredPort) || parsed.port || Number(server.primaryPort) || 0;
  return { host, port: Number.isInteger(port) ? port : 0 };
}

function stripFormatting(text) {
  return String(text || '')
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .replace(/\u001b\[[0-9;]*m/g, '');
}

function extractCount(text, regex) {
  if (!regex) throw new Error('no player regex configured for RCON counting');
  let re;
  try {
    re = new RegExp(regex, 'i');
  } catch (err) {
    throw new Error(`invalid player regex: ${err.message}`);
  }
  const match = text.match(re);
  if (!match) throw new Error('player regex did not match the RCON output');
  const raw = match[1] !== undefined ? match[1] : match[0];
  const count = Number(String(raw).replace(/[^0-9-]/g, ''));
  if (!Number.isFinite(count)) throw new Error('player regex did not yield a number');
  return count;
}

function parseServerCfgPassword(text) {
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');
    const match = line.match(/^\s*rcon_password\s+(?:"([^"]*)"|(\S+))\s*$/i);
    if (match) {
      const value = (match[1] ?? match[2] ?? '').trim();
      if (value) return value;
    }
  }
  return null;
}

function parsePropertiesPassword(text) {
  for (const rawLine of String(text || '').split('\n')) {
    const match = rawLine.match(/^\s*rcon\.password\s*=\s*(.*)$/i);
    if (match) {
      const value = match[1].trim();
      if (value) return value;
    }
  }
  return null;
}

/** ValheimRcon BepInEx config: a single Port/Password pair in any section. */
function parseBepInExRconConfig(text) {
  let password = null;
  let port = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (key === 'password' && value) password = value;
    if (key === 'port') {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) port = n;
    }
  }
  return { password, port };
}

/** Palworld PalWorldSettings.ini: AdminPassword / RCONPort. */
function parsePalworldConfig(text) {
  let password = null;
  let port = null;
  const pw = String(text || '').match(/AdminPassword\s*=\s*"([^"]*)"/i);
  if (pw && pw[1]) password = pw[1];
  const pt = String(text || '').match(/RCONPort\s*=\s*(\d+)/i);
  if (pt) {
    const n = Number(pt[1]);
    if (n > 0) port = n;
  }
  return { password, port };
}

/** Project Zomboid server .ini: RCONPassword / RCONPort. */
function parseZomboidConfig(text) {
  let password = null;
  let port = null;
  const pw = String(text || '').match(/^\s*RCONPassword\s*=\s*(.+)$/mi);
  if (pw && pw[1].trim()) password = pw[1].trim();
  const pt = String(text || '').match(/^\s*RCONPort\s*=\s*(\d+)/mi);
  if (pt) {
    const n = Number(pt[1]);
    if (n > 0) port = n;
  }
  return { password, port };
}

/**
 * Find the RCON password (and, for ValheimRcon, the configured port) from the
 * server's config files. Cached and hard-bounded so it never blocks a request.
 * Returns { password, port }.
 */
async function discoverRcon(ctx, server, preset) {
  const cached = rconPasswordCache.get(server.id);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const empty = { password: null, port: null };
  if (!ctx.fileTunnel || typeof ctx.fileTunnel.queueRequest !== 'function') {
    rconPasswordCache.set(server.id, { value: empty, expiresAt: Date.now() + RC_DISCOVERY_MISS_TTL_MS });
    return empty;
  }

  // Ask for every candidate at once and resolve as soon as one yields a
  // password, so a slow or missing file never blocks the one that matters.
  const scan = () =>
    new Promise((resolve) => {
      const paths = configPathsFor(preset);
      const found = { password: null, port: null };
      let pending = paths.length;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(found);
      };
      if (pending === 0) {
        finish();
        return;
      }
      for (const path of paths) {
        (async () => {
          try {
            const res = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, path);
            if (res?.success && res.body) {
              const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
              const apply = (cfg) => {
                if (cfg.port && !found.port) found.port = cfg.port;
                if (cfg.password && !found.password) {
                  found.password = cfg.password;
                  finish();
                  return true;
                }
                return false;
              };
              if (isValheimRconCfg(path)) {
                if (apply(parseBepInExRconConfig(text))) return;
              } else if (PALWORLD_CONFIG_PATHS.includes(path)) {
                if (apply(parsePalworldConfig(text))) return;
              } else if (ZOMBOID_CONFIG_PATHS.includes(path)) {
                if (apply(parseZomboidConfig(text))) return;
              } else {
                const password = path.endsWith('.properties') ? parsePropertiesPassword(text) : parseServerCfgPassword(text);
                if (password && !found.password) {
                  found.password = password;
                  finish();
                  return;
                }
              }
            }
          } catch {
            /* ignore this candidate */
          }
          pending -= 1;
          if (pending === 0) finish();
        })();
      }
    });

  let value = empty;
  try {
    value = await Promise.race([
      scan(),
      new Promise((resolve) => setTimeout(() => resolve(empty), RC_DISCOVERY_TIMEOUT_MS)),
    ]);
  } catch {
    value = empty;
  }
  const ttl = value.password ? RC_DISCOVERY_TTL_MS : RC_DISCOVERY_MISS_TTL_MS;
  rconPasswordCache.set(server.id, { value, expiresAt: Date.now() + ttl });
  return value;
}

async function resolveRcon(ctx, server, settings) {
  const parsed = parseHostPort(settings.rconHost);
  const host = normalizeHost(parsed.host) || normalizeHost(server.primaryIp);
  const configuredPort = Number(settings.rconPort) || parsed.port || 0;
  let password = settings.rconPassword || '';

  let discovered = { password: null, port: null };
  if (!password || !configuredPort) {
    discovered = await discoverRcon(ctx, server, settings.preset);
    if (!password) password = discovered.password || '';
  }

  const offset = Number(settings.rconPortOffset) || 0;
  const port = configuredPort || discovered.port || Number(settings.rconDefaultPort) || Number(server.primaryPort) + offset || 0;
  if (!host || !port) {
    throw new Error('RCON needs a reachable host and port (set rconHost/rconPort; Valheim RCON default is game port + 2)');
  }
  if (!password) {
    throw new Error("no RCON password: set it on this server's Idle Stop tab, or use a non-empty Password in BepInEx/config/<mod>.cfg (Valheim) / server.properties (Minecraft)");
  }
  return { host, port, password };
}

async function rcon(ctx, server, settings, command) {
  const conn = await resolveRcon(ctx, server, settings);
  const { output } = await rconExec({ host: conn.host, port: conn.port, password: conn.password, command });
  return stripFormatting(output);
}

async function countPlayers(ctx, server, settings) {
  if (settings.playerSource === 'a2s') {
    const { host, port } = resolveEndpoint(settings.queryHost, settings.queryPort, server);
    if (!host || !port) throw new Error('A2S query needs a reachable host and port (set queryHost/queryPort)');
    const info = await a2sPlayerCount({ host, port });
    return { count: info.players, maxPlayers: info.maxPlayers, source: 'a2s', output: `${info.name || ''} ${info.map || ''}`.trim() };
  }
  if (settings.playerSource === 'rcon') {
    const command = settings.playerCommand || 'list';
    const output = await rcon(ctx, server, settings, command);
    return { count: extractCount(output, settings.playerRegex), source: 'rcon', output: output.slice(0, 2000) };
  }
  throw new Error(`unsupported player source: ${settings.playerSource}`);
}

/**
 * Probe players for a server. Prefers a list (names/IDs); falls back to a
 * bare count when the list is unavailable. Never mixes failure into a stop.
 */
async function probePlayers(ctx, server, settings) {
  const style = styleFor(settings.preset);

  // If the operator forced A2S, never touch RCON for the player list.
  if (settings.playerSource === 'a2s') {
    if (style === 'source') {
      const { host, port } = resolveEndpoint(settings.queryHost, settings.queryPort, server);
      if (!host || !port) {
        return { mode: 'count', players: [], count: 0, source: 'a2s', output: null, listError: 'A2S query needs a reachable host and port (set queryHost/queryPort)' };
      }
      // A2S_INFO carries the authoritative player count; A2S_PLAYER may not
      // expose names at all (e.g. Nuclear Option returns empty names).
      let infoCount = null;
      try {
        infoCount = (await a2sPlayerCount({ host, port })).players;
      } catch {
        /* ignore */
      }
      let names = [];
      try {
        names = (await a2sPlayers({ host, port }))
          .map((p) => String(p.name || '').replace(/\u00a7[0-9a-fk-or]/gi, '').trim())
          .filter(Boolean);
      } catch {
        /* ignore */
      }
      if (names.length) {
        return { mode: 'list', players: names.map((name) => ({ name })), count: Math.max(infoCount ?? 0, names.length), source: 'a2s', output: null, listError: null };
      }
      return { mode: 'count', players: [], count: infoCount ?? 0, source: 'a2s', output: null, listError: null };
    }
    const res = await countPlayers(ctx, server, settings);
    return { mode: 'count', players: [], count: res.count, source: res.source, output: res.output || null, listError: null };
  }

  if (style === 'nuclear') {
    try {
      const { host, port } = nuclearEndpoint(server, settings);
      if (!host || !port) throw new Error('Nuclear Option remote commands need a reachable host and port (set rconHost/rconPort; default 7779)');
      const res = await noCommand({ host, port, name: 'get-player-list', args: [] });
      const list = res.body && Array.isArray(res.body.Players) ? res.body.Players : [];
      const players = list
        .map((p) => ({ steamid: String(p.steamId || '').trim(), name: String(p.steamId || '').trim(), faction: p.faction || null }))
        .filter((p) => p.steamid);
      return { mode: 'list', players, count: players.length, source: 'nuclear', output: null, listError: null };
    } catch (err) {
      return { mode: 'count', players: [], count: 0, source: 'nuclear', output: null, listError: err?.message || String(err) };
    }
  }

  if (style === 'valheim') {
    // Prefer the ValheimRcon mod's RCON player list (names + SteamIDs).
    try {
      const output = await rcon(ctx, server, settings, settings.playerListCommand || 'players');
      const players = parsePlayers('valheim', output);
      return { mode: 'list', players, count: players.length, source: 'rcon', output: output.slice(0, 4000), listError: null, authoritative: true };
    } catch (err) {
      // No RCON (mod missing or disabled): fall back to the console roster.
      const map = await ensureRosterLoaded(ctx, server.id);
      const players = [...map.values()].map((p) => ({ steamid: p.steamid, name: p.name || null }));
      return {
        mode: 'list',
        players,
        count: players.length,
        source: 'console',
        output: null,
        listError: err.message,
        authoritative: rosterSeen.has(server.id),
      };
    }
  }

  try {
    if (settings.playerListCommand) {
      const output = await rcon(ctx, server, settings, settings.playerListCommand);
      const players = parsePlayers(style, output);
      return { mode: 'list', players, count: players.length, source: 'rcon', output: output.slice(0, 4000), listError: null };
    }
  } catch (err) {
    if (style !== 'source') {
      const res = await countPlayers(ctx, server, settings);
      return { mode: 'count', players: [], count: res.count, source: res.source, output: res.output || null, listError: err.message };
    }
    // Source: fall through to the A2S player list / count below.
    const listError = err.message;
    try {
      const { host, port } = resolveEndpoint(settings.queryHost, settings.queryPort, server);
      if (!host || !port) throw new Error('no reachable A2S endpoint');
      const players = (await a2sPlayers({ host, port }))
        .map((p) => ({ name: String(p.name || '').replace(/\u00a7[0-9a-fk-or]/gi, '').trim() }))
        .filter((p) => p.name);
      return { mode: 'list', players, count: players.length, source: 'a2s', output: null, listError };
    } catch (a2sErr) {
      const res = await countPlayers(ctx, server, settings);
      return { mode: 'count', players: [], count: res.count, source: res.source, output: res.output || null, listError: `${listError}; ${a2sErr.message}` };
    }
  }

  if (style === 'source') {
    try {
      const { host, port } = resolveEndpoint(settings.queryHost, settings.queryPort, server);
      if (!host || !port) throw new Error('no reachable A2S endpoint');
      const players = (await a2sPlayers({ host, port }))
        .map((p) => ({ name: String(p.name || '').replace(/\u00a7[0-9a-fk-or]/gi, '').trim() }))
        .filter((p) => p.name);
      return { mode: 'list', players, count: players.length, source: 'a2s', output: null, listError: null };
    } catch (err) {
      const res = await countPlayers(ctx, server, settings);
      return { mode: 'count', players: [], count: res.count, source: res.source, output: res.output || null, listError: err.message };
    }
  }

  const res = await countPlayers(ctx, server, settings);
  return { mode: 'count', players: [], count: res.count, source: res.source, output: res.output || null, listError: null };
}

/** probePlayers with a hard cap so an HTTP route cannot hang into a proxy 502. */
async function probePlayersQuick(ctx, server, settings) {
  return Promise.race([
    probePlayers(ctx, server, settings),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('player probe timed out — check that queryHost/rconHost is reachable from the panel')), PROBE_TIMEOUT_MS),
    ),
  ]);
}

// ----------------------------------------------------------------- stops ---

async function sendConsoleCommand(ctx, server, command) {
  const gateway = ctx.wsGateway;
  if (!gateway || typeof gateway.sendToAgent !== 'function') throw new Error('console gateway unavailable');
  const data = command.endsWith('\n') ? command : `${command}\n`;
  const ok = await gateway.sendToAgent(server.nodeId, {
    type: 'console_input',
    serverId: server.id,
    serverUuid: server.uuid,
    data,
  });
  if (!ok) throw new Error('agent is offline; command was not delivered');
}

/**
 * Deliver a game command using the transport the game supports: ValheimRcon
 * executes commands over RCON, while Source/GoldSrc/Minecraft use the
 * container console (stdin). Returns any RCON output.
 */
async function sendGameCommand(ctx, server, settings, command) {
  if (usesRcon(settings.preset)) {
    const output = await rcon(ctx, server, settings, command);
    // These RCON servers reply "Unknown command <x>" rather than failing.
    if (/unknown command/i.test(output)) {
      throw new Error(`RCON rejected "${command}": ${output.trim().slice(0, 120)}`);
    }
    return output;
  }
  await sendConsoleCommand(ctx, server, command);
  return null;
}

function nuclearEndpoint(server, settings) {
  const parsed = parseHostPort(settings.rconHost);
  const host = normalizeHost(parsed.host) || normalizeHost(server.primaryIp);
  const port = Number(settings.rconPort) || parsed.port || Number(settings.rconDefaultPort) || 7779;
  return { host, port };
}

/** Send one Nuclear Option remote command; returns the response body as text. */
async function sendNuclear(ctx, server, settings, name, args = []) {
  const { host, port } = nuclearEndpoint(server, settings);
  if (!host || !port) {
    throw new Error('Nuclear Option remote commands need a reachable host and port (set rconHost/rconPort; default 7779)');
  }
  const res = await noCommand({ host, port, name, args });
  return res.raw || `ok(${res.status})`;
}

async function sendAgentStop(ctx, server) {
  const gateway = ctx.wsGateway;
  if (!gateway || typeof gateway.sendToAgent !== 'function') throw new Error('console gateway unavailable');
  const ok = await gateway.sendToAgent(server.nodeId, {
    type: 'stop_server',
    serverId: server.id,
    serverUuid: server.uuid,
  });
  if (!ok) throw new Error('agent is offline; stop request was not delivered');
}

async function performStop(ctx, server, settings, playerCount) {
  if (settings.stopMethod === 'agent') {
    await sendAgentStop(ctx, server);
  } else {
    if (!settings.stopCommand) throw new Error('no stop command configured');
    await sendGameCommand(ctx, server, settings, settings.stopCommand);
  }
  await writeState(ctx, server.id, { stopIssuedAt: Date.now(), lastStopAt: Date.now(), idleSince: null });
  ctx.logger.info({ serverId: server.id, playerCount, method: settings.stopMethod }, 'idle-stop stopped an empty server');
  emit(ctx, 'idle-stop:stopped', { serverId: server.id, playerCount, method: settings.stopMethod });
}

// ---------------------------------------------------------------- welcome ---

async function sendWelcome(ctx, server, settings, player) {
  if (styleFor(settings.preset) === 'nuclear') {
    const text = renderMessage(settings.welcomeMessage, { player: player.name, server: server.name });
    if (text) await sendNuclear(ctx, server, settings, 'send-chat-message', [text]);
    await writeState(ctx, server.id, { lastWelcomeAt: Date.now() });
    emit(ctx, 'idle-stop:welcomed', { serverId: server.id, player: player.name });
    return;
  }
  const commands = buildWelcomeCommands(settings.preset, player.name, settings.welcomeMessage, server.name);
  for (const command of commands) await sendGameCommand(ctx, server, settings, command);
  await writeState(ctx, server.id, { lastWelcomeAt: Date.now() });
  emit(ctx, 'idle-stop:welcomed', { serverId: server.id, player: player.name });
}

/**
 * Send a welcome for a name detected on the live console. Deduped against the
 * poll-based path so the same join is never welcomed twice.
 */
async function welcomeFromConsole(ctx, serverId, name, settings) {
  const server = serverCache.get(serverId);
  if (!server || server.status !== 'running') return;
  const state = await readState(ctx, serverId);
  const welcomed = state.welcomed || {};
  if (recentlyWelcomed(welcomed, name)) return;
  try {
    const commands = buildWelcomeCommands(settings.preset, name, settings.welcomeMessage, server.name);
    for (const command of commands) await sendGameCommand(ctx, server, settings, command);
    welcomed[String(name).toLowerCase()] = Date.now();
    await writeState(ctx, serverId, { welcomed: pruneWelcomed(welcomed), lastWelcomeAt: Date.now() });
    touchRuntime(serverId, { lastWelcomePlayer: name, lastWelcomeError: null });
    emit(ctx, 'idle-stop:welcomed', { serverId, player: name });
  } catch (err) {
    touchRuntime(serverId, { lastWelcomeError: err?.message || String(err) });
    ctx.logger.warn({ err: err?.message, serverId, player: name }, 'idle-stop console welcome failed');
  }
}

/** Handle one live console event pushed by the gateway. Must never throw. */
function onConsoleOutput(ctx, serverId, dataJson) {
  const settings = settingsCache.get(serverId);
  if (!settings) return;
  let payload;
  try {
    payload = JSON.parse(typeof dataJson === 'string' ? dataJson : '');
  } catch {
    return;
  }
  const text = payload && typeof payload.data === 'string' ? payload.data : '';
  if (!text) return;
  touchRuntime(serverId, { lastConsoleAt: Date.now() });
  const lines = text.split(/\r?\n/).filter(Boolean);

  const capture = consoleCaptures.get(serverId);
  if (capture && !capture.settled) {
    for (const line of lines) capture.lines.push(line);
    clearTimeout(capture.quiet);
    capture.quiet = setTimeout(capture.finish, 1000);
  }

  if (styleFor(settings.preset) === 'valheim') {
    updateRosterFromLines(ctx, serverId, settings, lines).catch(() => {});
  }

  if (!settings.welcomeEnabled || !settings.welcomeConsole || !settings.welcomeJoinRegex) return;
  const re = compile(settings.welcomeJoinRegex);
  if (!re) return;
  const seen = new Set();
  const isValheim = styleFor(settings.preset) === 'valheim';
  for (const line of lines) {
    const match = line.match(re);
    if (!match || !match[1]) continue;
    const value = String(match[1]).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    touchRuntime(serverId, { lastJoinAt: Date.now(), lastJoinValue: value });
    if (isValheim) {
      welcomeValheimBySteamId(ctx, serverId, value, settings).catch(() => {});
    } else {
      welcomeFromConsole(ctx, serverId, value, settings).catch(() => {});
    }
  }
}

/**
 * Valheim's console join line only carries a SteamID; wait briefly for the
 * player to appear in the RCON list, then welcome with their name.
 */
async function welcomeValheimBySteamId(ctx, serverId, steamid, settings) {
  const server = serverCache.get(serverId);
  if (!server || server.status !== 'running') return;
  let name = null;
  for (let attempt = 0; attempt < 6 && !name; attempt += 1) {
    try {
      const output = await rcon(ctx, server, settings, settings.playerListCommand || 'players');
      const found = parsePlayers('valheim', output).find((p) => p.steamid === steamid);
      if (found && found.name) name = found.name;
    } catch {
      /* retry */
    }
    if (!name) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (name) {
    touchRuntime(serverId, { lastResolvedName: name, lastResolveError: null });
    await welcomeFromConsole(ctx, serverId, name, settings);
  } else {
    touchRuntime(serverId, { lastResolveError: `name unresolved for ${steamid}` });
    ctx.logger.debug({ serverId, steamid }, 'idle-stop Valheim join name unresolved; poll fallback will handle it');
  }
}

function ensureConsoleSub(ctx, serverId) {
  const gateway = ctx.wsGateway;
  if (!gateway || typeof gateway.addSseSubscriber !== 'function') return;
  if (consoleSubs.has(serverId)) return;
  try {
    const handle = gateway.addSseSubscriber(serverId, (event, data) => {
      if (event !== 'console_output') return;
      try {
        onConsoleOutput(ctx, serverId, data);
      } catch {
        /* console handling must never break the data path */
      }
    });
    consoleSubs.set(serverId, handle);
  } catch (err) {
    ctx.logger.debug({ err: err?.message, serverId }, 'idle-stop console subscribe failed');
  }
}

function clearConsoleSubs() {
  for (const [, handle] of consoleSubs) {
    try {
      handle.unsubscribe?.();
    } catch {
      /* already gone */
    }
  }
  consoleSubs.clear();
  serverCache.clear();
  settingsCache.clear();
  rosterCache.clear();
  rosterSeen.clear();
  for (const [, capture] of consoleCaptures) {
    try {
      capture.finish?.();
    } catch {
      /* already settled */
    }
  }
  consoleCaptures.clear();
}

// ------------------------------------------------------- Valheim roster ---

async function ensureRosterLoaded(ctx, serverId) {
  if (rosterCache.has(serverId)) return rosterCache.get(serverId);
  const state = await readState(ctx, serverId);
  const map = new Map();
  for (const [id, value] of Object.entries(state.roster || {})) map.set(id, value);
  rosterCache.set(serverId, map);
  if (state.rosterSeen) rosterSeen.add(serverId);
  return map;
}

async function persistRoster(ctx, serverId) {
  const map = rosterCache.get(serverId) || new Map();
  await writeState(ctx, serverId, {
    roster: Object.fromEntries(map),
    rosterSeen: rosterSeen.has(serverId),
  });
}

function compile(text) {
  try {
    return text ? new RegExp(text) : null;
  } catch {
    return null;
  }
}

async function updateRosterFromLines(ctx, serverId, settings, lines) {
  const map = await ensureRosterLoaded(ctx, serverId);
  const joinRe = compile(settings.rosterJoinRegex);
  const leaveRe = compile(settings.rosterLeaveRegex);
  let changed = false;
  const left = [];
  for (const line of lines) {
    if (joinRe) {
      const match = line.match(joinRe);
      if (match && match[1]) {
        map.set(match[1], { steamid: match[1], name: null, since: Date.now() });
        changed = true;
        continue;
      }
    }
    if (leaveRe) {
      const match = line.match(leaveRe);
      if (match && match[1] && map.has(match[1])) {
        map.delete(match[1]);
        left.push(match[1]);
        changed = true;
      }
    }
  }
  if (changed) await persistRoster(ctx, serverId);
  // Forget leavers so the poll path welcomes them again when they rejoin,
  // even if they reconnect between polls.
  if (left.length) {
    const state = await readState(ctx, serverId);
    const known = Array.isArray(state.knownPlayers) ? state.knownPlayers : [];
    const filtered = known.filter((key) => !left.includes(key));
    if (filtered.length !== known.length) await writeState(ctx, serverId, { knownPlayers: filtered });
  }
}

/** Collect console lines for a short window after a command (e.g. `banned`). */
function captureConsole(serverId, { timeoutMs = 3500, quietMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const entry = { lines: [], settled: false };
    const finish = () => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.quiet);
      clearTimeout(entry.hard);
      if (consoleCaptures.get(serverId) === entry) consoleCaptures.delete(serverId);
      resolve(entry.lines.join('\n'));
    };
    entry.finish = finish;
    entry.quiet = setTimeout(finish, quietMs);
    entry.hard = setTimeout(finish, timeoutMs);
    consoleCaptures.set(serverId, entry);
  });
}

// ------------------------------------------------------------ check loop ---

async function checkServer(ctx, server, global, per, now, force) {
  const settings = resolveSettings(global, server, per);
  const managed = isManaged(global, per);
  // Welcome and player tracking run even for servers that are not auto-managed.
  if (!managed && !settings.welcomeEnabled) return;

  if (server.status !== 'running') {
    const state = await readState(ctx, server.id);
    if (state.knownPlayers?.length || state.idleSince) {
      await writeState(ctx, server.id, { knownPlayers: [], idleSince: null });
    }
    return;
  }

  const state = await readState(ctx, server.id);

  // Auto-stop guards only apply to managed servers.
  if (managed) {
    if (state.stopIssuedAt && now - state.stopIssuedAt < settings.stopRetrySeconds * 1000) return;
    let startedAt = state.startedAt;
    if (!startedAt) {
      startedAt = state.firstSeenRunning || now;
      if (!state.firstSeenRunning) await writeState(ctx, server.id, { firstSeenRunning: now });
    }
    if (settings.minServerUptimeSeconds > 0 && now - startedAt < settings.minServerUptimeSeconds * 1000) return;
  }

  if (!force && state.lastCheckAt && now - state.lastCheckAt < settings.checkIntervalSeconds * 1000) return;
  await writeState(ctx, server.id, { lastCheckAt: now });

  let probe;
  try {
    probe = await probePlayers(ctx, server, settings);
  } catch (err) {
    const message = err?.message || String(err);
    await writeState(ctx, server.id, { lastError: message, lastErrorAt: now });
    throw err;
  }

  await writeState(ctx, server.id, {
    lastCount: probe.count,
    lastCountAt: now,
    lastSource: probe.source,
    lastListError: probe.listError || null,
    lastError: null,
  });

  // Welcome players who joined since the previous poll. This is the fallback
  // for when the live console path is unavailable or missed a line.
  if (probe.mode === 'list' && settings.welcomeEnabled && probe.players.length) {
    const keys = probe.players.map(playerKey).filter(Boolean);
    const known = Array.isArray(state.knownPlayers) ? state.knownPlayers : null;
    const knownSet = new Set(known || []);
    const welcomed = { ...(state.welcomed || {}) };
    let sent = 0;
    for (const player of probe.players) {
      const key = playerKey(player);
      if (known && knownSet.has(key)) continue;
      if (!known && !settings.welcomeOnExisting) continue;
      if (recentlyWelcomed(welcomed, player.name)) continue;
      if (sent >= MAX_WELCOMES_PER_TICK) break;
      try {
        await sendWelcome(ctx, server, settings, player);
        if (player.name) welcomed[String(player.name).toLowerCase()] = Date.now();
        sent += 1;
      } catch (err) {
        ctx.logger.warn({ err: err?.message, serverId: server.id, player: player.name }, 'idle-stop welcome failed');
        break;
      }
    }
    await writeState(ctx, server.id, { knownPlayers: keys, welcomed: pruneWelcomed(welcomed) });
  }

  if (!managed) {
    if (state.idleSince) await writeState(ctx, server.id, { idleSince: null });
    return;
  }

  if (probe.count <= settings.emptyThreshold) {
    if (probe.authoritative === false) {
      // The roster is not known to be complete (Valheim before an observed
      // start). Never stop a server on unknown data.
      if (state.idleSince) await writeState(ctx, server.id, { idleSince: null });
      return;
    }
    if (!state.idleSince) {
      await writeState(ctx, server.id, { idleSince: now });
      emit(ctx, 'idle-stop:empty', { serverId: server.id, playerCount: probe.count, since: new Date(now).toISOString() });
      return;
    }
    if (now - state.idleSince >= settings.graceSeconds * 1000) {
      await performStop(ctx, server, settings, probe.count);
    }
    return;
  }

  if (state.idleSince) await writeState(ctx, server.id, { idleSince: null });
}

async function tick(ctx, force = false) {
  if (ticking || disposed) return;
  ticking = true;
  try {
    if (ctx.getConfig('enabled') === false) {
      clearConsoleSubs();
      return;
    }
    const global = readGlobalConfig(ctx);
    if (!global.enabled) {
      clearConsoleSubs();
      return;
    }

    const servers = await ctx.db.servers.findMany({ select: SERVER_SELECT, orderBy: { name: 'asc' } });
    const overrides = await loadOverrides(ctx);
    const now = Date.now();

    // Refresh the cache used by the live-console path, then keep exactly the
    // running servers that want on-join welcomes subscribed.
    serverCache.clear();
    settingsCache.clear();
    const gateway = ctx.wsGateway;
    const canConsole = gateway && typeof gateway.addSseSubscriber === 'function';
    const activeConsole = new Set();
    for (const server of servers) {
      const per = overrides.get(server.id) || {};
      const settings = resolveSettings(global, server, per);
      serverCache.set(server.id, server);
      settingsCache.set(server.id, settings);
      const wantsRoster = styleFor(settings.preset) === 'valheim';
      if (wantsRoster) {
        try {
          await ensureRosterLoaded(ctx, server.id);
        } catch {
          /* leave the cache empty; roster is non-authoritative until start */
        }
      }
      if (canConsole && server.status === 'running' && (wantsRoster || (settings.welcomeEnabled && settings.welcomeConsole && settings.welcomeJoinRegex))) {
        activeConsole.add(server.id);
        ensureConsoleSub(ctx, server.id);
      }
    }
    for (const [id, handle] of consoleSubs) {
      if (!activeConsole.has(id)) {
        try {
          handle.unsubscribe?.();
        } catch {
          /* already gone */
        }
        consoleSubs.delete(id);
      } else {
        try {
          handle.touch?.();
        } catch {
          /* already gone */
        }
      }
    }

    for (const server of servers) {
      try {
        await checkServer(ctx, server, global, overrides.get(server.id) || {}, now, force);
      } catch (err) {
        ctx.logger.warn({ err: err?.message, serverId: server.id }, 'idle-stop server check failed');
      }
    }
  } catch (err) {
    ctx.logger.warn({ err: err?.message }, 'idle-stop tick failed');
  } finally {
    ticking = false;
  }
}

function startLoop(ctx) {
  stopLoop();
  disposed = false;
  const seconds = Math.max(15, Number(ctx.getConfig('checkIntervalSeconds')) || 30);
  loopTimer = setInterval(() => {
    tick(ctx).catch((err) => ctx.logger.warn({ err: err?.message }, 'idle-stop tick failed'));
  }, seconds * 1000);
  if (typeof loopTimer.unref === 'function') loopTimer.unref();
  ctx.logger.info({ seconds }, 'idle-stop loop started');
}

function stopLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
}

// --------------------------------------------------------------- helpers ---

async function findServer(ctx, id) {
  return ctx.db.servers.findUnique({ where: { id }, select: SERVER_SELECT });
}

function sanitizeOverrides(body) {
  const patch = {};
  if (!body || typeof body !== 'object') return patch;
  for (const key of Object.keys(body)) {
    if (ALLOWED_OVERRIDES.has(key)) patch[key] = body[key];
  }
  return patch;
}

function banTargetLabel(record) {
  return record.name || record.steamid || record.target || `#${record.userid}`;
}

// --------------------------------------------------------------- routes ---

function guard(handler) {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      const status = err?.statusCode === 403 ? 403 : 500;
      return reply.status(status).send({ success: false, error: err?.message || 'idle-stop error' });
    }
  };
}

export default {
  async onLoad(ctx) {
    ctx.logger.info('Idle Stop loaded');
    const readHandler = guard;
    const writeHandler = guard;

    ctx.registerRoute({
      method: 'GET',
      url: '/servers',
      preHandler: ctx.requirePermission?.('server.read'),
      handler: readHandler(async () => {
        const servers = await ctx.db.servers.findMany({ select: SERVER_SELECT, orderBy: { name: 'asc' } });
        const overrides = await loadOverrides(ctx);
        const global = readGlobalConfig(ctx);
        const list = [];
        for (const server of servers) {
          const per = overrides.get(server.id) || {};
          const state = await readState(ctx, server.id);
          list.push({
            id: server.id,
            name: server.name,
            status: server.status,
            managed: isManaged(global, per),
            settings: redactSettings(resolveSettings(global, server, per)),
            state: {
              lastCount: state.lastCount ?? null,
              lastCountAt: state.lastCountAt ?? null,
              lastSource: state.lastSource ?? null,
              idleSince: state.idleSince ?? null,
              lastStopAt: state.lastStopAt ?? null,
              lastError: state.lastError ?? null,
              lastErrorAt: state.lastErrorAt ?? null,
            },
          });
        }
        return { success: true, count: list.length, servers: list };
      }),
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id',
      preHandler: ctx.requirePermission?.('server.read'),
      handler: readHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const per = overrides.get(server.id) || {};
        const global = readGlobalConfig(ctx);
        const state = await readState(ctx, server.id);
        return {
          success: true,
          server: {
            id: server.id,
            name: server.name,
            status: server.status,
            managed: isManaged(global, per),
            override: { ...per, rconPassword: undefined, rconPasswordSet: Boolean(per.rconPassword) },
            settings: redactSettings(resolveSettings(global, server, per)),
            state,
            runtime: runtimeInfo.get(server.id) || null,
          },
        };
      }),
    });

    ctx.registerRoute({
      method: 'PUT',
      url: '/servers/:id',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });

        const patch = sanitizeOverrides(request.body);
        if (Object.keys(patch).length === 0) {
          return reply.status(400).send({ success: false, error: 'no allowed settings supplied' });
        }

        const collection = ctx.collection(SETTINGS_COLLECTION);
        const existing = await collection.findOne({ serverId: server.id });
        if (existing) await collection.update({ serverId: server.id }, { $set: patch });
        else await collection.insert({ serverId: server.id, ...patch });

        const per = { ...(existing || {}), ...patch };
        ctx.logger.info({ serverId: server.id, keys: Object.keys(patch) }, 'idle-stop settings updated');
        return { success: true, serverId: server.id, override: { ...per, rconPassword: undefined, rconPasswordSet: Boolean(per.rconPassword) } };
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/test',
      preHandler: ctx.requirePermission?.('server.read'),
      handler: readHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        try {
          if (server.status !== 'running') {
            return { success: false, serverId: server.id, error: `server is not running (${server.status})` };
          }
          const probe = await probePlayersQuick(ctx, server, settings);
          return {
            success: true,
            serverId: server.id,
            preset: settings.preset,
            mode: probe.mode,
            authoritative: probe.authoritative !== false,
            source: probe.source,
            players: probe.players.map((p) => ({ name: p.name || '', userid: p.userid || null, steamid: p.steamid || null })),
            count: probe.count,
            output: probe.output || null,
            listError: probe.listError || null,
          };
        } catch (err) {
          return { success: false, serverId: server.id, error: err?.message || String(err) };
        }
      }),
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/players',
      preHandler: ctx.requirePermission?.('server.read'),
      handler: readHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        try {
          if (server.status !== 'running') {
            return { success: false, serverId: server.id, error: `server is not running (${server.status})` };
          }
          const probe = await probePlayersQuick(ctx, server, settings);
          return {
            success: true,
            serverId: server.id,
            preset: settings.preset,
            mode: probe.mode,
            authoritative: probe.authoritative !== false,
            source: probe.source,
            count: probe.count,
            players: probe.players.map((p) => ({ name: p.name || '', userid: p.userid || null, steamid: p.steamid || null })),
            listError: probe.listError || null,
          };
        } catch (err) {
          return { success: false, serverId: server.id, error: err?.message || String(err) };
        }
      }),
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/rcon-config',
      preHandler: ctx.requirePermission?.('server.read'),
      handler: readHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        const hasTunnel = Boolean(ctx.fileTunnel && typeof ctx.fileTunnel.queueRequest === 'function');

        const check = (path) => {
          const task = (async () => {
            try {
              const res = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, path);
              if (!res?.success || !res.body) return { path, found: false };
              const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
              if (isValheimRconCfg(path)) {
                const cfg = parseBepInExRconConfig(text);
                return { path, found: true, passwordFound: Boolean(cfg.password), port: cfg.port ?? null };
              }
              const password = path.endsWith('.properties') ? parsePropertiesPassword(text) : parseServerCfgPassword(text);
              return { path, found: true, passwordFound: Boolean(password) };
            } catch (err) {
              return { path, found: false, error: err?.message || String(err) };
            }
          })();
          return Promise.race([
            task,
            new Promise((resolve) => setTimeout(() => resolve({ path, found: false, error: 'timeout' }), 6000)),
          ]);
        };

        const paths = hasTunnel ? await Promise.all(configPathsFor(settings.preset).map(check)) : [];
        let rconTest = { ok: false, error: hasTunnel ? null : 'file tunnel unavailable' };
        try {
          const command = settings.playerListCommand || 'players';
          const output = await rcon(ctx, server, settings, command);
          rconTest = { ok: true, command, output: output.slice(0, 400) };
        } catch (err) {
          rconTest = { ok: false, command: settings.playerListCommand || 'players', error: err?.message || String(err) };
        }

        return {
          success: true,
          serverId: server.id,
          preset: settings.preset,
          fileTunnel: hasTunnel,
          passwordConfigured: Boolean(settings.rconPassword),
          rconPortSetting: settings.rconPort,
          rconPortOffset: settings.rconPortOffset,
          primaryPort: server.primaryPort,
          primaryIp: server.primaryIp,
          paths,
          rconTest,
        };
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/kick',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const body = request.body || {};
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        const player = {
          name: body.name || null,
          userid: body.userid || null,
          steamid: body.steamid || null,
        };
        try {
          if (styleFor(settings.preset) === 'nuclear') {
            if (!player.steamid) throw new Error('Nuclear Option kick needs a SteamID');
            await sendNuclear(ctx, server, settings, 'kick-player', [player.steamid]);
            emit(ctx, 'idle-stop:kicked', { serverId: server.id, target: player.steamid, reason: null });
            return { success: true, serverId: server.id, command: `kick-player ${player.steamid}` };
          }
          const command = buildKick(settings.preset, player, body.reason);
          await sendGameCommand(ctx, server, settings, command);
          emit(ctx, 'idle-stop:kicked', { serverId: server.id, target: player.name || player.steamid || player.userid, reason: body.reason || null });
          return { success: true, serverId: server.id, command };
        } catch (err) {
          return reply.status(400).send({ success: false, serverId: server.id, error: err?.message || String(err) });
        }
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/ban',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const body = request.body || {};
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        const player = { name: body.name || null, userid: body.userid || null, steamid: body.steamid || null };
        const minutes = normalizeMinutes(body.minutes, settings.defaultBanMinutes);
        const reason = body.reason || settings.defaultBanReason || '';
        try {
          let command;
          if (styleFor(settings.preset) === 'nuclear') {
            if (!player.steamid) throw new Error('Nuclear Option ban needs a SteamID');
            await sendNuclear(ctx, server, settings, 'banlist-add', [player.steamid, reason || '']);
            command = `banlist-add ${player.steamid}`;
          } else {
            command = buildBan(settings.preset, player, minutes, reason);
            await sendGameCommand(ctx, server, settings, command);
          }
          const record = {
            serverId: server.id,
            name: player.name || null,
            userid: player.userid || null,
            steamid: player.steamid || null,
            target: banTargetLabel(player),
            reason: reason || null,
            minutes,
            createdBy: ctx.getUserId?.(request) || null,
            createdAt: new Date().toISOString(),
            expiresAt: minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null,
          };
          await ctx.collection(BANS_COLLECTION).insert(record);
          emit(ctx, 'idle-stop:banned', { serverId: server.id, target: record.target, minutes });
          return { success: true, serverId: server.id, command, ban: record };
        } catch (err) {
          return reply.status(400).send({ success: false, serverId: server.id, error: err?.message || String(err) });
        }
      }),
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/servers/:id/bans',
      preHandler: ctx.requirePermission?.('server.read'),
      handler: readHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        const local = (await ctx.collection(BANS_COLLECTION).find({ serverId: server.id }, { sort: { createdAt: -1 } })) || [];

        let remote = { ok: false, bans: [], error: null };
        try {
          if (settings.banListCommand) {
            const style = styleFor(settings.preset);
            const output = await rcon(ctx, server, settings, settings.banListCommand);
            remote = { ok: true, bans: parseBans(style, output), error: null };
          } else if (styleFor(settings.preset) === 'nuclear' && ctx.fileTunnel) {
            // Nuclear Option keeps bans in ban_list.txt (one SteamID per line).
            const res = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, 'ban_list.txt');
            if (res?.success && res.body) {
              const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
              const bans = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((t) => ({ target: t }));
              remote = { ok: true, bans, error: null };
            } else {
              remote = { ok: false, bans: [], error: 'ban_list.txt not found' };
            }
          } else {
            remote = { ok: false, bans: [], error: 'no ban list command configured' };
          }
        } catch (err) {
          remote = { ok: false, bans: [], error: err?.message || String(err) };
        }

        return { success: true, serverId: server.id, local, remote };
      }),
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/servers/:id/bans/:banId',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const record = await ctx.collection(BANS_COLLECTION).findOne({ _id: request.params.banId });
        if (!record) return reply.status(404).send({ success: false, error: 'ban not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        try {
          let command;
          if (styleFor(settings.preset) === 'nuclear') {
            const steamid = record.steamid || record.target;
            await sendNuclear(ctx, server, settings, 'banlist-remove', [steamid]);
            command = `banlist-remove ${steamid}`;
          } else {
            command = buildUnban(settings.preset, record);
            await sendGameCommand(ctx, server, settings, command);
          }
          await ctx.collection(BANS_COLLECTION).delete({ _id: request.params.banId });
          emit(ctx, 'idle-stop:unbanned', { serverId: server.id, target: record.target });
          return { success: true, serverId: server.id, command };
        } catch (err) {
          return reply.status(400).send({ success: false, serverId: server.id, error: err?.message || String(err) });
        }
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/bans/clear',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const existing = (await ctx.collection(BANS_COLLECTION).find({ serverId: server.id })) || [];
        for (const record of existing) await ctx.collection(BANS_COLLECTION).delete({ _id: record._id });
        emit(ctx, 'idle-stop:bans-cleared', { serverId: server.id, count: existing.length });
        return { success: true, serverId: server.id, cleared: existing.length };
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/nuclear',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const body = request.body || {};
        if (String(body.confirm || '') !== 'NUKE') {
          return reply.status(400).send({ success: false, error: "confirmation required: send { \"confirm\": \"NUKE\" }" });
        }
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        const result = { unbanned: 0, cleared: 0, errors: [] };
        const style = styleFor(settings.preset);

        // 1. Best-effort removal of remote bans.
        try {
          if (settings.banListCommand) {
            const output = await rcon(ctx, server, settings, settings.banListCommand);
            for (const ban of parseBans(style, output)) {
              try {
                if (style === 'source') await sendGameCommand(ctx, server, settings, `removeid ${ban.target}`);
                else if (style === 'minecraft') await sendGameCommand(ctx, server, settings, `pardon ${ban.target}`);
                else await sendGameCommand(ctx, server, settings, `unban ${ban.target}`);
                result.unbanned += 1;
              } catch (err) {
                result.errors.push(`unban ${ban.target}: ${err.message}`);
              }
            }
          }
        } catch (err) {
          result.errors.push(`ban list: ${err.message}`);
        }

        // 2. Clear local ban records and the whole session.
        const existing = (await ctx.collection(BANS_COLLECTION).find({ serverId: server.id })) || [];
        for (const record of existing) await ctx.collection(BANS_COLLECTION).delete({ _id: record._id });
        result.cleared = existing.length;
        await clearServerSession(ctx, server.id);
        result.sessionCleared = true;

        emit(ctx, 'idle-stop:nuclear', { serverId: server.id, unbanned: result.unbanned });
        ctx.logger.warn({ serverId: server.id, ...result }, 'idle-stop nuclear reset performed');
        return { success: true, serverId: server.id, result };
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/clear-session',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        await clearServerSession(ctx, server.id);
        emit(ctx, 'idle-stop:session-cleared', { serverId: server.id });
        ctx.logger.info({ serverId: server.id }, 'idle-stop session cleared');
        return { success: true, serverId: server.id, message: 'session cleared' };
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/stop',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await findServer(ctx, request.params.id);
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        const state = await readState(ctx, server.id);
        try {
          await performStop(ctx, server, settings, typeof state.lastCount === 'number' ? state.lastCount : 0);
          return { success: true, serverId: server.id, method: settings.stopMethod };
        } catch (err) {
          return { success: false, serverId: server.id, error: err?.message || String(err) };
        }
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/welcome/broadcast',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const body = request.body || {};
        const global = readGlobalConfig(ctx);
        const overrides = await loadOverrides(ctx);
        let servers = await ctx.db.servers.findMany({ select: SERVER_SELECT, orderBy: { name: 'asc' } });
        if (body.serverId) servers = servers.filter((s) => s.id === body.serverId);

        const sent = [];
        const errors = [];
        for (const server of servers) {
          if (server.status !== 'running') continue;
          const settings = resolveSettings(global, server, overrides.get(server.id) || {});
          const message = body.message || settings.welcomeMessage;
          try {
            if (styleFor(settings.preset) === 'nuclear') {
              const text = renderMessage(message, { server: server.name });
              if (text) await sendNuclear(ctx, server, settings, 'send-chat-message', [text]);
            } else {
              for (const command of buildBroadcastCommands(settings.preset, message, server.name)) {
                await sendGameCommand(ctx, server, settings, command);
              }
            }
            sent.push(server.id);
          } catch (err) {
            errors.push(`${server.name}: ${err.message}`);
          }
        }
        return { success: true, sent, errors };
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/tick',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async () => {
        await tick(ctx, true);
        return { success: true, message: 'check cycle finished' };
      }),
    });
  },

  async onEnable(ctx) {
    ctx.logger.info('Idle Stop enabled');

    ctx.on('server:started', async (data) => {
      if (!data?.serverId) return;
      if (data.status !== 'running' && data.status !== 'starting') return;
      try {
        // A fresh start means the console roster is empty and now authoritative
        // for this session (Valheim builds its player list from console lines).
        rosterCache.set(data.serverId, new Map());
        rosterSeen.add(data.serverId);
        await writeState(ctx, data.serverId, {
          startedAt: Date.now(),
          firstSeenRunning: Date.now(),
          idleSince: null,
          stopIssuedAt: null,
          knownPlayers: [],
          roster: {},
          rosterSeen: true,
        });
      } catch (err) {
        ctx.logger.debug({ err: err?.message }, 'idle-stop start event failed');
      }
    });

    ctx.on('server:stopped', async (data) => {
      if (!data?.serverId) return;
      if (data.status !== 'stopped' && data.status !== 'stopping') return;
      try {
        rosterCache.set(data.serverId, new Map());
        rosterSeen.delete(data.serverId);
        await writeState(ctx, data.serverId, {
          startedAt: null,
          idleSince: null,
          stopIssuedAt: null,
          knownPlayers: [],
          roster: {},
          rosterSeen: false,
        });
      } catch (err) {
        ctx.logger.debug({ err: err?.message }, 'idle-stop stop event failed');
      }
    });

    startLoop(ctx);
  },

  async onDisable(ctx) {
    ctx.logger.info('Idle Stop disabled');
    disposed = true;
    stopLoop();
    clearConsoleSubs();
  },

  async onUnload(ctx) {
    ctx.logger.info('Idle Stop unloaded');
    disposed = true;
    stopLoop();
    clearConsoleSubs();
  },
};
