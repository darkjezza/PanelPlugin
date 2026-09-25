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
  'queryHost',
  'queryPort',
  'rconHost',
  'rconPort',
  'rconPassword',
  'welcomeEnabled',
  'welcomeMessage',
  'welcomeOnExisting',
  'defaultBanMinutes',
  'defaultBanReason',
  'note',
]);

const RC_CONFIG_PATHS = ['server.properties', 'server.cfg', 'cstrike/server.cfg', 'csgo/cfg/server.cfg', 'tf/cfg/server.cfg'];
const MAX_WELCOMES_PER_TICK = 20;
const MAX_KICKS_PER_ACTION = 50;

let ticking = false;
let loopTimer = null;
let disposed = false;

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
    queryHost: get('queryHost', ''),
    queryPort: num(get('queryPort', 0), 0),
    rconHost: get('rconHost', ''),
    rconPort: num(get('rconPort', 0), 0),
    rconPassword: get('rconPassword', ''),
    welcomeEnabled: get('welcomeEnabled', false) === true,
    welcomeMessage: get('welcomeMessage', 'Welcome, {player}!'),
    welcomeOnExisting: get('welcomeOnExisting', false) === true,
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

async function discoverRconPassword(ctx, server) {
  if (!ctx.fileTunnel || typeof ctx.fileTunnel.queueRequest !== 'function') return null;
  for (const path of RC_CONFIG_PATHS) {
    try {
      const res = await ctx.fileTunnel.queueRequest(server.nodeId, 'download', server.uuid, path);
      if (res?.success && res.body) {
        const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
        const found = path.endsWith('.properties') ? parsePropertiesPassword(text) : parseServerCfgPassword(text);
        if (found) return found;
      }
    } catch {
      /* try the next candidate path */
    }
  }
  return null;
}

async function resolveRcon(ctx, server, settings) {
  const { host, port } = resolveEndpoint(settings.rconHost, settings.rconPort, server);
  if (!host || !port) throw new Error('RCON needs a reachable host and port (set rconHost/rconPort)');
  const password = settings.rconPassword || (await discoverRconPassword(ctx, server));
  if (!password) throw new Error('no RCON password configured or found in server.properties/server.cfg');
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

  // Welcome players who joined since the previous poll.
  if (probe.mode === 'list' && settings.welcomeEnabled && probe.players.length) {
    const keys = probe.players.map(playerKey).filter(Boolean);
    const known = Array.isArray(state.knownPlayers) ? state.knownPlayers : null;
    const knownSet = new Set(known || []);
    let sent = 0;
    for (const player of probe.players) {
      if (known && knownSet.has(playerKey(player))) continue;
      if (!known && !settings.welcomeOnExisting) continue;
      if (sent >= MAX_WELCOMES_PER_TICK) break;
      try {
        await sendWelcome(ctx, server, settings, player);
        sent += 1;
      } catch (err) {
        ctx.logger.warn({ err: err?.message, serverId: server.id, player: player.name }, 'idle-stop welcome failed');
        break;
      }
    }
    await writeState(ctx, server.id, { knownPlayers: keys });
  }

  if (probe.count <= settings.emptyThreshold) {
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
    if (ctx.getConfig('enabled') === false) return;
    const global = readGlobalConfig(ctx);
    if (!global.enabled) return;

    const servers = await ctx.db.servers.findMany({ select: SERVER_SELECT, orderBy: { name: 'asc' } });
    const overrides = await loadOverrides(ctx);
    const now = Date.now();

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
          const probe = await probePlayers(ctx, server, settings);
          return {
            success: true,
            serverId: server.id,
            preset: settings.preset,
            mode: probe.mode,
            source: probe.source,
            players: probe.players.map((p) => ({ name: p.name || '', userid: p.userid || null, steamid: p.steamid || null })),
            count: probe.count,
            output: probe.output || null,
            listError: probe.listError || null,
          };
        } catch (err) {
          return reply.status(502).send({ success: false, serverId: server.id, error: err?.message || String(err) });
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
          const probe = await probePlayers(ctx, server, settings);
          return {
            success: true,
            serverId: server.id,
            preset: settings.preset,
            mode: probe.mode,
            source: probe.source,
            count: probe.count,
            players: probe.players.map((p) => ({ name: p.name || '', userid: p.userid || null, steamid: p.steamid || null })),
            listError: probe.listError || null,
          };
        } catch (err) {
          return reply.status(502).send({ success: false, serverId: server.id, error: err?.message || String(err) });
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
            const output = await rcon(ctx, server, settings, settings.banListCommand);
            remote = { ok: true, bans: parseBans(styleFor(settings.preset), output), error: null };
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
          const probe = await probePlayers(ctx, server, settings);
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
          return reply.status(502).send({ success: false, serverId: server.id, error: err?.message || String(err) });
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
        await writeState(ctx, data.serverId, {
          startedAt: Date.now(),
          firstSeenRunning: Date.now(),
          idleSince: null,
          stopIssuedAt: null,
          knownPlayers: [],
        });
      } catch (err) {
        ctx.logger.debug({ err: err?.message }, 'idle-stop start event failed');
      }
    });

    ctx.on('server:stopped', async (data) => {
      if (!data?.serverId) return;
      if (data.status !== 'stopped' && data.status !== 'stopping') return;
      try {
        await writeState(ctx, data.serverId, { startedAt: null, idleSince: null, stopIssuedAt: null, knownPlayers: [] });
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
  },

  async onUnload(ctx) {
    ctx.logger.info('Idle Stop unloaded');
    disposed = true;
    stopLoop();
  },
};
