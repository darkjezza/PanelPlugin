/**
 * Idle Stop — stop a game server once its last player leaves.
 *
 * The panel does not expose player-join/leave events to plugins, so this
 * plugin polls a player-count source on a schedule:
 *
 *   - A2S query  (Source, CS2, GoldSrc, TF2, ...) — no password needed
 *   - Source RCON (Minecraft Java, custom games) — command + regex
 *
 * When a managed server reports at or below the empty threshold for longer
 * than the grace period, the plugin sends the game's stop command (or asks
 * the node agent to stop the container). Query failures never stop a server.
 *
 * Routes: /api/plugins/idle-stop/...
 */

import { a2sPlayerCount } from './a2s.js';
import { rconExec } from './rcon.js';
import { redactSettings, resolveSettings } from './presets.js';

const COLLECTION = 'idle_stop_servers';
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
  'queryHost',
  'queryPort',
  'rconHost',
  'rconPort',
  'rconPassword',
  'note',
]);

const RC_CONFIG_PATHS = ['server.properties', 'server.cfg', 'cstrike/server.cfg', 'csgo/cfg/server.cfg', 'tf/cfg/server.cfg'];

let ticking = false;

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
    checkIntervalSeconds: num(get('checkIntervalSeconds', 60), 60),
    stopMethod: get('stopMethod', 'console'),
    stopCommand: get('stopCommand', ''),
    stopRetrySeconds: num(get('stopRetrySeconds', 120), 120),
    playerSource: get('playerSource', 'auto'),
    playerCommand: get('playerCommand', ''),
    playerRegex: get('playerRegex', ''),
    queryHost: get('queryHost', ''),
    queryPort: num(get('queryPort', 0), 0),
    rconHost: get('rconHost', ''),
    rconPort: num(get('rconPort', 0), 0),
    rconPassword: get('rconPassword', ''),
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
  const docs = await ctx.collection(COLLECTION).find({});
  const map = new Map();
  for (const doc of docs || []) {
    if (doc && doc.serverId) map.set(doc.serverId, doc);
  }
  return map;
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

async function countPlayers(ctx, server, settings) {
  if (settings.playerSource === 'a2s') {
    const { host, port } = resolveEndpoint(settings.queryHost, settings.queryPort, server);
    if (!host || !port) throw new Error('A2S query needs a reachable host and port (set queryHost/queryPort)');
    const info = await a2sPlayerCount({ host, port });
    return { count: info.players, maxPlayers: info.maxPlayers, source: 'a2s', output: `${info.name || ''} ${info.map || ''}`.trim() };
  }

  if (settings.playerSource === 'rcon') {
    const { host, port } = resolveEndpoint(settings.rconHost, settings.rconPort, server);
    if (!host || !port) throw new Error('RCON needs a reachable host and port (set rconHost/rconPort)');
    const password = settings.rconPassword || (await discoverRconPassword(ctx, server));
    if (!password) throw new Error('no RCON password configured or found in server.properties/server.cfg');
    const { output } = await rconExec({ host, port, password, command: settings.playerCommand || 'list' });
    const clean = stripFormatting(output);
    return { count: extractCount(clean, settings.playerRegex), source: 'rcon', output: clean.slice(0, 2000) };
  }

  throw new Error(`unsupported player source: ${settings.playerSource}`);
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
  if (!ok) throw new Error('agent is offline; stop command was not delivered');
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
  ctx.logger.info(
    { serverId: server.id, playerCount, method: settings.stopMethod },
    'idle-stop stopped an empty server',
  );
  emit(ctx, 'idle-stop:stopped', {
    serverId: server.id,
    playerCount,
    method: settings.stopMethod,
  });
}

function emit(ctx, event, payload) {
  try {
    if (typeof ctx.emitTyped === 'function') ctx.emitTyped(event, payload);
    else ctx.emit(event, payload);
  } catch (err) {
    ctx.logger.debug({ err: err?.message, event }, 'idle-stop emit failed');
  }
}

// ------------------------------------------------------------ check loop ---

async function checkServer(ctx, server, global, per, now) {
  if (!isManaged(global, per)) return;
  if (server.status !== 'running') return;

  const settings = resolveSettings(global, server, per);
  const state = await readState(ctx, server.id);

  if (state.stopIssuedAt && now - state.stopIssuedAt < settings.stopRetrySeconds * 1000) return;

  let startedAt = state.startedAt;
  if (!startedAt) {
    startedAt = state.firstSeenRunning || now;
    if (!state.firstSeenRunning) await writeState(ctx, server.id, { firstSeenRunning: now });
  }
  if (settings.minServerUptimeSeconds > 0 && now - startedAt < settings.minServerUptimeSeconds * 1000) return;

  if (state.lastCheckAt && now - state.lastCheckAt < settings.checkIntervalSeconds * 1000) return;
  await writeState(ctx, server.id, { lastCheckAt: now });

  let result;
  try {
    result = await countPlayers(ctx, server, settings);
  } catch (err) {
    const message = err?.message || String(err);
    await writeState(ctx, server.id, { lastError: message, lastErrorAt: now });
    throw err;
  }

  await writeState(ctx, server.id, {
    lastCount: result.count,
    lastCountAt: now,
    lastSource: result.source,
    lastError: null,
  });

  if (result.count <= settings.emptyThreshold) {
    if (!state.idleSince) {
      await writeState(ctx, server.id, { idleSince: now });
      emit(ctx, 'idle-stop:empty', {
        serverId: server.id,
        playerCount: result.count,
        since: new Date(now).toISOString(),
      });
      return;
    }
    if (now - state.idleSince >= settings.graceSeconds * 1000) {
      await performStop(ctx, server, settings, result.count);
    }
    return;
  }

  if (state.idleSince) await writeState(ctx, server.id, { idleSince: null });
}

async function tick(ctx) {
  if (ticking) return;
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
        await checkServer(ctx, server, global, overrides.get(server.id) || {}, now);
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

function sanitizeOverrides(body) {
  const patch = {};
  if (!body || typeof body !== 'object') return patch;
  for (const key of Object.keys(body)) {
    if (ALLOWED_OVERRIDES.has(key)) patch[key] = body[key];
  }
  return patch;
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
            overridden: Boolean(per.enabled !== undefined),
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
        const server = await ctx.db.servers.findUnique({ where: { id: request.params.id }, select: SERVER_SELECT });
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
        const server = await ctx.db.servers.findUnique({ where: { id: request.params.id }, select: SERVER_SELECT });
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });

        const patch = sanitizeOverrides(request.body);
        if (Object.keys(patch).length === 0) {
          return reply.status(400).send({ success: false, error: 'no allowed settings supplied' });
        }

        const collection = ctx.collection(COLLECTION);
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
        const server = await ctx.db.servers.findUnique({ where: { id: request.params.id }, select: SERVER_SELECT });
        if (!server) return reply.status(404).send({ success: false, error: 'server not found' });
        const overrides = await loadOverrides(ctx);
        const settings = resolveSettings(readGlobalConfig(ctx), server, overrides.get(server.id) || {});
        try {
          const result = await countPlayers(ctx, server, settings);
          return {
            success: true,
            serverId: server.id,
            preset: settings.preset,
            source: result.source,
            players: result.count,
            maxPlayers: result.maxPlayers ?? null,
            output: result.output || null,
          };
        } catch (err) {
          return reply.status(502).send({ success: false, serverId: server.id, error: err?.message || String(err) });
        }
      }),
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/servers/:id/stop',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async (request, reply) => {
        const server = await ctx.db.servers.findUnique({ where: { id: request.params.id }, select: SERVER_SELECT });
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
      url: '/tick',
      preHandler: ctx.requirePermission?.('server.write'),
      handler: writeHandler(async () => {
        await tick(ctx);
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
        });
      } catch (err) {
        ctx.logger.debug({ err: err?.message }, 'idle-stop start event failed');
      }
    });

    ctx.on('server:stopped', async (data) => {
      if (!data?.serverId) return;
      if (data.status !== 'stopped' && data.status !== 'stopping') return;
      try {
        await writeState(ctx, data.serverId, {
          startedAt: null,
          idleSince: null,
          stopIssuedAt: null,
        });
      } catch (err) {
        ctx.logger.debug({ err: err?.message }, 'idle-stop stop event failed');
      }
    });

    ctx.scheduleTask('* * * * *', () => tick(ctx));
    tick(ctx).catch((err) => ctx.logger.warn({ err: err?.message }, 'idle-stop initial tick failed'));
  },

  async onDisable(ctx) {
    ctx.logger.info('Idle Stop disabled');
  },

  async onUnload(ctx) {
    ctx.logger.info('Idle Stop unloaded');
  },
};
