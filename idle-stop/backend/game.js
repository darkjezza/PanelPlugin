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
  return 'custom';
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
  throw new Error('ban is not supported for this game preset');
}

export function buildUnban(preset, target) {
  const style = styleFor(preset);
  if (style === 'source') {
    if (!target.steamid) throw new Error('a SteamID is required to remove a Source/GoldSrc ban');
    return `removeid ${normalizeSteamId(target.steamid)}`;
  }
  if (style === 'minecraft') return `pardon ${cleanName(target.name || target.target)}`;
  throw new Error('unban is not supported for this game preset');
}

export function buildWelcome(preset, playerName, message, serverName = '') {
  const text = cleanMessage(applyVars(message, { player: playerName, server: serverName }));
  if (!text) throw new Error('welcome message is empty after sanitizing');
  const style = styleFor(preset);
  if (style === 'minecraft') return `tell ${cleanName(playerName)} ${text}`;
  return `say ${text}`;
}

export function buildBroadcast(preset, message, serverName = '') {
  const text = cleanMessage(applyVars(message, { server: serverName }));
  if (!text) throw new Error('message is empty after sanitizing');
  return `say ${text}`;
}

/** Stable identity key for diffing player lists between polls. */
export function playerKey(player) {
  if (player.steamid) return player.steamid;
  if (player.userid) return `#${player.userid}`;
  return String(player.name || '').toLowerCase();
}
