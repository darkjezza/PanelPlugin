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
import { rconExec } from './rcon.js';
import { redactSettings, resolveSettings } from './presets.js';
import {
  buildBan,
  buildBroadcast,
  buildKick,
  buildUnban,
  buildWelcome,
  normalizeMinutes,
  parseBans,
  parsePlayers,
  playerKey,
  styleFor,
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

const RC_CONFIG_PATHS = [
  'server.properties',
  'server.cfg',
  'cstrike/server.cfg',
  'csgo/cfg/server.cfg',
  'tf/cfg/server.cfg',
  'BepInEx/config/org.tristan.rcon.cfg', // ValheimRcon mod
];
// File-tunnel requests can take up to 60s each; bound discovery hard and cache
// the result so a user-facing request never hangs into a proxy timeout.
const RC_DISCOVERY_TTL_MS = 5 * 60 * 1000;
const RC_DISCOVERY_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 15000;
const rconPasswordCache = new Map();
const MAX_WELCOMES_PER_TICK = 20;
const MAX_KICKS_PER_ACTION = 50;

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

const WELCOME_DEDUP_MS = 5 * 60 * 1000;

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
    welcomeEnabled: get('welcomeEnabled', false) === true,
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

/** ValheimRcon BepInEx config: [1. Rcon] Port / Password. */
function parseBepInExRconConfig(text) {
  let section = '';
  let password = null;
  let port = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (section && !/rcon/i.test(section)) continue;
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

/**
 * Find the RCON password (and, for ValheimRcon, the configured port) from the
 * server's config files. Cached and hard-bounded so it never blocks a request.
 * Returns { password, port }.
 */
async function discoverRcon(ctx, server) {
  const cached = rconPasswordCache.get(server.id);
  if (cached && Date.now() - cached.at < RC_DISCOVERY_TTL_MS) return cached.value;
  const empty = { password: null, port: null };
  if (!ctx.fileTunnel || typeof ctx.fileTunnel.queueRequest !== 'function') {
    rconPasswordCache.set(server.id, { value: empty, at: Date.now() });
    return empty;
  }

  const scan = async () => {
    const found = { password: null, port: null };
    for (const path of RC_CONFIG_PATHS) {
      try {
        const res = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, path);
        if (!res?.success || !res.body) continue;
        const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
        if (path.endsWith('org.tristan.rcon.cfg')) {
          const cfg = parseBepInExRconConfig(text);
          if (cfg.port) found.port = cfg.port;
          if (cfg.password) {
            found.password = cfg.password;
            return found;
          }
          continue;
        }
        const password = path.endsWith('.properties') ? parsePropertiesPassword(text) : parseServerCfgPassword(text);
        if (password) {
          found.password = password;
          return found;
        }
      } catch {
        /* try the next candidate path */
      }
    }
    return found;
  };

  let value = empty;
  try {
    value = await Promise.race([
      scan(),
      new Promise((resolve) => setTimeout(() => resolve(empty), RC_DISCOVERY_TIMEOUT_MS)),
    ]);
  } catch {
    value = empty;
  }
  rconPasswordCache.set(server.id, { value, at: Date.now() });
  return value;
}

async function resolveRcon(ctx, server, settings) {
  const parsed = parseHostPort(settings.rconHost);
  const host = normalizeHost(parsed.host) || normalizeHost(server.primaryIp);
  const configuredPort = Number(settings.rconPort) || parsed.port || 0;
  let password = settings.rconPassword || '';

  let discovered = { password: null, port: null };
  if (!password || !configuredPort) {
    discovered = await discoverRcon(ctx, server);
    if (!password) password = discovered.password || '';
  }

  const offset = Number(settings.rconPortOffset) || 0;
  const port = configuredPort || discovered.port || Number(server.primaryPort) + offset || 0;
  if (!host || !port) {
    throw new Error('RCON needs a reachable host and port (set rconHost/rconPort; Valheim RCON default is game port + 2)');
  }
  if (!password) {
    throw new Error('no RCON password configured or found (Valheim: BepInEx/config/org.tristan.rcon.cfg)');
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
    await sendConsoleCommand(ctx, server, settings.stopCommand);
  }
  await writeState(ctx, server.id, { stopIssuedAt: Date.now(), lastStopAt: Date.now(), idleSince: null });
  ctx.logger.info({ serverId: server.id, playerCount, method: settings.stopMethod }, 'idle-stop stopped an empty server');
  emit(ctx, 'idle-stop:stopped', { serverId: server.id, playerCount, method: settings.stopMethod });
}

// ---------------------------------------------------------------- welcome ---

async function sendWelcome(ctx, server, settings, player) {
  const command = buildWelcome(settings.preset, player.name, settings.welcomeMessage, server.name);
  await sendConsoleCommand(ctx, server, command);
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
    const command = buildWelcome(settings.preset, name, settings.welcomeMessage, server.name);
    await sendConsoleCommand(ctx, server, command);
    welcomed[String(name).toLowerCase()] = Date.now();
    await writeState(ctx, serverId, { welcomed: pruneWelcomed(welcomed), lastWelcomeAt: Date.now() });
    emit(ctx, 'idle-stop:welcomed', { serverId, player: name });
  } catch (err) {
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
  for (const line of lines) {
    const match = line.match(re);
    if (!match || !match[1]) continue;
    const name = String(match[1]).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    welcomeFromConsole(ctx, serverId, name, settings).catch(() => {});
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
        changed = true;
      }
    }
  }
  if (changed) await persistRoster(ctx, serverId);
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
  const managed = isManaged(global, per);
  if (!managed) return;

  if (server.status !== 'running') {
    const state = await readState(ctx, server.id);
    if (state.knownPlayers?.length || state.idleSince) {
      await writeState(ctx, server.id, { knownPlayers: [], idleSince: null });
    }
    return;
  }

  const settings = resolveSettings(global, server, per);
  const state = await readState(ctx, server.id);

  if (state.stopIssuedAt && now - state.stopIssuedAt < settings.stopRetrySeconds * 1000) return;

  let startedAt = state.startedAt;
  if (!startedAt) {
    startedAt = state.firstSeenRunning || now;
    if (!state.firstSeenRunning) await writeState(ctx, server.id, { firstSeenRunning: now });
  }
  if (settings.minServerUptimeSeconds > 0 && now - startedAt < settings.minServerUptimeSeconds * 1000) return;

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
          const command = buildKick(settings.preset, player, body.reason);
          await sendConsoleCommand(ctx, server, command);
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
          const command = buildBan(settings.preset, player, minutes, reason);
          await sendConsoleCommand(ctx, server, command);
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
            if (style === 'valheim') {
              const capture = captureConsole(server.id);
              await sendConsoleCommand(ctx, server, settings.banListCommand);
              const output = await capture;
              remote = { ok: true, bans: parseBans('valheim', output), error: null, raw: output.slice(0, 2000) };
            } else {
              const output = await rcon(ctx, server, settings, settings.banListCommand);
              remote = { ok: true, bans: parseBans(style, output), error: null };
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
          const command = buildUnban(settings.preset, record);
          await sendConsoleCommand(ctx, server, command);
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
        const result = { kicked: 0, unbanned: 0, cleared: 0, errors: [] };
        const style = styleFor(settings.preset);

        // 1. Kick everyone currently online.
        try {
          if (server.status !== 'running') {
            return { success: false, serverId: server.id, error: `server is not running (${server.status})` };
          }
          const probe = await probePlayersQuick(ctx, server, settings);
          for (const player of probe.players.slice(0, MAX_KICKS_PER_ACTION)) {
            try {
              await sendConsoleCommand(ctx, server, buildKick(settings.preset, player, 'Server reset'));
              result.kicked += 1;
            } catch (err) {
              result.errors.push(`kick ${player.name}: ${err.message}`);
            }
          }
        } catch (err) {
          result.errors.push(`player list: ${err.message}`);
        }

        // 2. Best-effort removal of remote bans.
        try {
          if (settings.banListCommand) {
            const output = await rcon(ctx, server, settings, settings.banListCommand);
            for (const ban of parseBans(style, output)) {
              try {
                if (style === 'source') await sendConsoleCommand(ctx, server, `removeid ${ban.target}`);
                else await sendConsoleCommand(ctx, server, `pardon ${ban.target}`);
                result.unbanned += 1;
              } catch (err) {
                result.errors.push(`unban ${ban.target}: ${err.message}`);
              }
            }
          }
        } catch (err) {
          result.errors.push(`ban list: ${err.message}`);
        }

        // 3. Clear local ban records and player memory.
        const existing = (await ctx.collection(BANS_COLLECTION).find({ serverId: server.id })) || [];
        for (const record of existing) await ctx.collection(BANS_COLLECTION).delete({ _id: record._id });
        result.cleared = existing.length;
        await writeState(ctx, server.id, { knownPlayers: [], idleSince: null, lastWelcomeAt: null });

        emit(ctx, 'idle-stop:nuclear', { serverId: server.id, kicked: result.kicked, unbanned: result.unbanned });
        ctx.logger.warn({ serverId: server.id, ...result }, 'idle-stop nuclear reset performed');
        return { success: true, serverId: server.id, result };
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
            await sendConsoleCommand(ctx, server, buildBroadcast(settings.preset, message, server.name));
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
