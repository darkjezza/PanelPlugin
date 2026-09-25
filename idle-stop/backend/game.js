/**
 * Idle Stop — game console builders and parsers.
 *
 * Pure functions, no ctx. Commands are built from strict allowlisted shapes
 * and every user-supplied value is sanitized before it reaches the server, so
 * a player name or reason cannot chain extra console commands.
 *
 * Styles:
 *   'source'    — Source / GoldSrc (status, kick, banid, removeid, listid)
 *   'minecraft' — Minecraft Java (list, kick, ban, pardon, banlist)
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const SHELL_META = /[;`|&$<>\\]/;

export const SteamIdRe = /^(STEAM_[0-5]:[01]:\d+|VALVE_[0-5]:[01]:\d+|\[U:1:\d+\])$/;

export function styleFor(preset) {
  if (preset === 'minecraft-java') return 'minecraft';
  if (preset === 'source' || preset === 'goldsrc') return 'source';
  if (preset === 'valheim') return 'valheim';
  if (preset === 'palworld') return 'palworld';
  if (preset === 'project-zomboid') return 'zomboid';
  if (preset === 'nuclear-option') return 'nuclear';
  return 'custom';
}

/** Rendered, sanitized message text (used by transports that take raw text). */
export function renderMessage(message, vars = {}) {
  return cleanMessage(applyVars(message, vars));
}

/** Games whose commands must go over RCON (no usable stdin console). */
export function usesRcon(preset) {
  const style = styleFor(preset);
  return style === 'valheim' || style === 'palworld' || style === 'zomboid';
}

/** Valheim targets are a 17-digit SteamID or a player name. */
export function normalizeValheimTarget(value) {
  const raw = String(value ?? '').trim();
  if (/^\d{10,20}$/.test(raw)) return raw;
  return cleanName(raw, 32);
}

export function cleanName(name, max = 32) {
  const value = String(name ?? '').replace(CONTROL_CHARS, ' ').trim();
  if (!value) throw new Error('player name is required');
  if (value.length > max) throw new Error(`player name exceeds ${max} characters`);
  if (SHELL_META.test(value) || value.includes('"')) throw new Error('player name contains disallowed characters');
  return value;
}

export function cleanReason(reason, max = 100) {
  const value = String(reason ?? '').replace(CONTROL_CHARS, ' ').replace(SHELL_META, ' ').replace(/"/g, '').trim();
  if (value.length > max) return value.slice(0, max);
  return value;
}

export function cleanMessage(message, max = 200) {
  const value = String(message ?? '').replace(CONTROL_CHARS, ' ').replace(SHELL_META, ' ').replace(/"/g, '').trim();
  if (!value) return '';
  return value.length > max ? value.slice(0, max) : value;
}

export function normalizeSteamId(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!SteamIdRe.test(raw)) throw new Error('invalid SteamID (expected STEAM_X:Y:Z or [U:1:N])');
  if (raw === 'STEAM_ID_PENDING') throw new Error('SteamID is still pending for this player');
  return raw;
}

export function normalizeUserid(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!/^\d{1,6}$/.test(raw)) throw new Error('userid must be numeric');
  return raw;
}

export function normalizeMinutes(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 525600) throw new Error('minutes must be between 0 (permanent) and 525600');
  return Math.floor(n);
}

export function applyVars(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? String(vars[key]) : ''));
}

/** Parse a status/list reply into [{ name, userid?, steamid? }]. */
export function parsePlayers(style, output) {
  const text = String(output ?? '');
  if (style === 'minecraft') {
    const match = text.match(/players online:?\s*(.*)$/im);
    const raw = match ? match[1] : '';
    return raw
      .split(',')
      .map((s) => s.replace(/\u00a7[0-9a-fk-or]/gi, '').trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }

  if (style === 'valheim') {
    // ValheimRcon `players`: "<name> Steam ID:<id> Position: ... Zone: ..."
    const players = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^(.*?)\s*Steam ID:(\d{5,20})/i);
      if (match && match[1].trim()) players.push({ name: match[1].trim(), steamid: match[2] });
    }
    return players;
  }

  if (style === 'palworld') {
    // PalworldRcon `ShowPlayers`: "name,playeruid,steamid" header then rows.
    const players = [];
    for (const line of text.split('\n')) {
      const value = line.trim();
      if (!value || /^name\s*,\s*playeruid\s*,\s*steamid/i.test(value)) continue;
      const parts = value.split(',');
      if (parts.length < 3) continue;
      const name = parts[0].trim();
      if (!name) continue;
      players.push({ name, steamid: parts[2].trim() || null });
    }
    return players;
  }

  if (style === 'zomboid') {
    // Project Zomboid `players`: "Players connected (N):" then "-Name" lines.
    const players = [];
    for (const line of text.split('\n')) {
      const value = line.trim().replace(/^[-*]\s*/, '');
      if (!value || /^players connected/i.test(value)) continue;
      players.push({ name: value });
    }
    return players;
  }

  const players = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*#\s*(\d+)\s+"([^"]*)"\s+(\S+)(.*)$/);
    if (!match) continue;
    const rest = `${match[3]} ${match[4]}`;
    const idMatch = rest.match(/(STEAM_[0-9]:[01]:\d+|VALVE_[0-9]:[01]:\d+|\[U:1:\d+\])/);
    players.push({ userid: match[1], name: match[2], steamid: idMatch ? idMatch[1] : null });
  }
  return players;
}

/** Parse a listid/banlist reply into [{ target }]. */
export function parseBans(style, output) {
  const text = String(output ?? '');
  const bans = [];
  if (style === 'minecraft') {
    for (const line of text.split('\n')) {
      const value = line.replace(/\u00a7[0-9a-fk-or]/gi, '').trim();
      if (!value) continue;
      if (/^there (are|is)\b/i.test(value)) continue;
      if (/^banned players:?$/i.test(value)) continue;
      bans.push({ target: value });
    }
    return bans;
  }
  if (style === 'valheim') {
    for (const line of text.split('\n')) {
      const value = line.trim();
      if (!value) continue;
      if (/^banned/i.test(value)) continue;
      const id = value.match(/\b(\d{17})\b/);
      bans.push({ target: id ? id[1] : value });
    }
    return bans;
  }
  for (const line of text.split('\n')) {
    const matches = line.match(/(STEAM_[0-9]:[01]:\d+|VALVE_[0-9]:[01]:\d+)/g);
    if (matches) for (const target of matches) bans.push({ target });
  }
  return bans;
}

export function buildKick(preset, player, reason) {
  const style = styleFor(preset);
  if (style === 'source') {
    if (player.userid) return `kick "#${normalizeUserid(player.userid)}"`;
    if (!player.name) throw new Error('kick needs a player name or userid');
    return `kick "${cleanName(player.name)}"`;
  }
  if (style === 'minecraft') {
    const name = cleanName(player.name);
    const cleaned = cleanReason(reason);
    return cleaned ? `kick ${name} ${cleaned}` : `kick ${name}`;
  }
  if (style === 'valheim') {
    const target = player.steamid ? normalizeValheimTarget(player.steamid) : normalizeValheimTarget(player.name);
    return `kick ${target}`;
  }
  if (style === 'palworld') {
    if (!player.steamid) throw new Error('Palworld kick needs a SteamID');
    return `KickPlayer ${normalizeValheimTarget(player.steamid)}`;
  }
  if (style === 'zomboid') {
    if (!player.name) throw new Error('Project Zomboid kick needs a player name');
    return `kickuser ${cleanName(player.name)}`;
  }
  throw new Error('kick is not supported for this game preset');
}

export function buildBan(preset, player, minutes, reason) {
  const style = styleFor(preset);
  if (style === 'source') {
    if (!player.steamid) throw new Error('this game bans by SteamID, but the player has no SteamID');
    return `banid ${normalizeMinutes(minutes)} ${normalizeSteamId(player.steamid)} kick`;
  }
  if (style === 'minecraft') {
    const name = cleanName(player.name);
    const cleaned = cleanReason(reason);
    return cleaned ? `ban ${name} ${cleaned}` : `ban ${name}`;
  }
  if (style === 'valheim') {
    // ValheimRcon 1.6.2 only ships `ban` (accepts a player name or SteamID);
    // `banSteamId` exists only in newer builds, so do not use it here.
    const target = player.steamid ? normalizeValheimTarget(player.steamid) : normalizeValheimTarget(player.name);
    return `ban ${target}`;
  }
  if (style === 'palworld') {
    if (!player.steamid) throw new Error('Palworld ban needs a SteamID');
    return `BanPlayer ${normalizeValheimTarget(player.steamid)}`;
  }
  if (style === 'zomboid') {
    if (!player.name) throw new Error('Project Zomboid ban needs a player name');
    return `banuser ${cleanName(player.name)}`;
  }
  throw new Error('ban is not supported for this game preset');
}

export function buildUnban(preset, target) {
  const style = styleFor(preset);
  if (style === 'source') {
    if (!target.steamid) throw new Error('a SteamID is required to remove a Source/GoldSrc ban');
    return `removeid ${normalizeSteamId(target.steamid)}`;
  }
  if (style === 'minecraft') return `pardon ${cleanName(target.name || target.target)}`;
  if (style === 'valheim') return `unban ${normalizeValheimTarget(target.steamid || target.name || target.target)}`;
  if (style === 'palworld') return `UnBanPlayer ${normalizeValheimTarget(target.steamid || target.name || target.target)}`;
  if (style === 'zomboid') return `unbanuser ${cleanName(target.name || target.target)}`;
  throw new Error('unban is not supported for this game preset');
}

export function buildWelcome(preset, playerName, message, serverName = '') {
  const text = cleanMessage(applyVars(message, { player: playerName, server: serverName }));
  if (!text) throw new Error('welcome message is empty after sanitizing');
  const style = styleFor(preset);
  if (style === 'minecraft') return `tell ${cleanName(playerName)} ${text}`;
  // ValheimRcon: `say` is a proximity shout that a just-spawned player may miss;
  // `showMessage` is a center-screen message delivered to everyone.
  if (style === 'valheim') return `showMessage ${text}`;
  if (style === 'palworld') return `Broadcast ${text}`;
  if (style === 'zomboid') return `servermsg "${text}"`;
  return `say ${text}`;
}

export function buildBroadcast(preset, message, serverName = '') {
  const text = cleanMessage(applyVars(message, { server: serverName }));
  if (!text) throw new Error('message is empty after sanitizing');
  const style = styleFor(preset);
  if (style === 'palworld') return `Broadcast ${text}`;
  if (style === 'zomboid') return `servermsg "${text}"`;
  if (style === 'valheim') return `showMessage ${text}`;
  return `say ${text}`;
}

/**
 * Welcome as one or more commands. Valheim gets both a centre-screen message
 * and a chat shout, because delivery across Valheim builds is inconsistent.
 */
export function buildWelcomeCommands(preset, playerName, message, serverName = '') {
  const text = cleanMessage(applyVars(message, { player: playerName, server: serverName }));
  if (!text) throw new Error('welcome message is empty after sanitizing');
  const style = styleFor(preset);
  if (style === 'minecraft') return [`tell ${cleanName(playerName)} ${text}`];
  if (style === 'valheim') return [`showMessage ${text}`, `say ${text}`];
  if (style === 'palworld') return [`Broadcast ${text}`];
  if (style === 'zomboid') return [`servermsg "${text}"`];
  return [`say ${text}`];
}

/** Broadcast as one or more commands (Valheim gets showMessage + say). */
export function buildBroadcastCommands(preset, message, serverName = '') {
  const text = cleanMessage(applyVars(message, { server: serverName }));
  if (!text) throw new Error('message is empty after sanitizing');
  const style = styleFor(preset);
  if (style === 'palworld') return [`Broadcast ${text}`];
  if (style === 'zomboid') return [`servermsg "${text}"`];
  if (style === 'valheim') return [`showMessage ${text}`, `say ${text}`];
  return [`say ${text}`];
}

/** Stable identity key for diffing player lists between polls. */
export function playerKey(player) {
  if (player.steamid) return player.steamid;
  if (player.userid) return `#${player.userid}`;
  return String(player.name || '').toLowerCase();
}
