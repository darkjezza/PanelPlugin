/**
 * Idle Stop — A2S (Source/GoldSrc server query) player counter.
 *
 * Pure Node (node:dgram), no dependencies. Sends an A2S_INFO request and
 * reads the online player count straight out of the reply, so no RCON
 * password is needed for Source, CS2, GoldSrc, TF2 and friends.
 *
 * Replies handled:
 *   'I' (0x49) — modern Source layout
 *   'm' (0x6d) — GoldSrc layout
 *   'A' (0x41) — challenge; the request is resent with the 4-byte challenge
 */

import dgram from 'node:dgram';

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQUEST = 0x54;
const RESPONSE_INFO = 0x49; // 'I'
const RESPONSE_INFO_GOLDSRC = 0x6d; // 'm'
const RESPONSE_CHALLENGE = 0x41; // 'A'
const PLAYER_REQUEST = 0x55;
const RESPONSE_PLAYER = 0x44; // 'D'
const INFO_PAYLOAD = Buffer.concat([HEADER, Buffer.from([INFO_REQUEST]), Buffer.from('Source Engine Query\0', 'ascii')]);

function sendQuery(host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`A2S timeout contacting ${host}:${port}`)), timeoutMs);
    socket.once('message', (msg) => finish(null, msg));
    socket.once('error', (err) => finish(err));
    socket.send(payload, port, host, (err) => {
      if (err) finish(err);
    });
  });
}

function readCString(buf, offset) {
  let end = buf.indexOf(0, offset);
  if (end === -1) end = buf.length;
  return [buf.toString('utf8', offset, end), end + 1];
}

/** Parse an A2S_INFO reply buffer into { players, maxPlayers, name, map }. */
export function parseA2SInfo(buf) {
  if (buf.length < 5 || buf[0] !== 0xff || buf[1] !== 0xff || buf[2] !== 0xff || buf[3] !== 0xff) {
    throw new Error('invalid A2S response header');
  }
  const type = buf[4];
  let o = 5;

  if (type === RESPONSE_INFO) {
    o += 1; // protocol version
    const [name, o1] = readCString(buf, o);
    const [map, o2] = readCString(buf, o1);
    const [, o3] = readCString(buf, o2); // folder
    const [, o4] = readCString(buf, o3); // game
    o = o4 + 2; // app id
    return { players: buf[o] ?? 0, maxPlayers: buf[o + 1] ?? 0, name, map };
  }

  if (type === RESPONSE_INFO_GOLDSRC) {
    const [, o1] = readCString(buf, o); // address
    const [name, o2] = readCString(buf, o1);
    const [map, o3] = readCString(buf, o2);
    const [, o4] = readCString(buf, o3); // folder
    const [, o5] = readCString(buf, o4); // game
    o = o5;
    return { players: buf[o] ?? 0, maxPlayers: buf[o + 1] ?? 0, name, map };
  }

  throw new Error(`unexpected A2S response type 0x${Number(type).toString(16)}`);
}

/** Query a Source/GoldSrc server and return { players, maxPlayers, name, map }. */
export async function a2sPlayerCount({ host, port, timeoutMs = 3000 }) {
  if (!host) throw new Error('A2S host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A2S port is invalid');

  let reply = await sendQuery(host, port, INFO_PAYLOAD, timeoutMs);
  if (reply.length >= 5 && reply[4] === RESPONSE_CHALLENGE) {
    const challenge = reply.subarray(5, 9);
    reply = await sendQuery(host, port, Buffer.concat([INFO_PAYLOAD, challenge]), timeoutMs);
  }
  return parseA2SInfo(reply);
}

/** Parse an A2S_PLAYER reply buffer into [{ name, score, duration }]. */
export function parseA2SPlayers(buf) {
  if (buf.length < 6 || buf[4] !== RESPONSE_PLAYER) {
    throw new Error(`unexpected A2S_PLAYER response type 0x${Number(buf[4] ?? 0).toString(16)}`);
  }
  const count = buf[5];
  let o = 6;
  const players = [];
  for (let i = 0; i < count && o < buf.length; i += 1) {
    o += 1; // player index
    let end = buf.indexOf(0, o);
    if (end === -1) end = buf.length;
    const name = buf.toString('utf8', o, end);
    o = end + 1;
    let score = null;
    let duration = null;
    if (o + 8 <= buf.length) {
      score = buf.readInt32LE(o);
      duration = buf.readFloatLE(o + 4);
      o += 8;
    }
    players.push({ name, score, duration });
  }
  return players;
}

/** Query a Source/GoldSrc server and return [{ name, score, duration }]. */
export async function a2sPlayers({ host, port, timeoutMs = 3000 }) {
  if (!host) throw new Error('A2S host is required');
  const challengeReq = Buffer.concat([HEADER, Buffer.from([PLAYER_REQUEST, 0xff, 0xff, 0xff, 0xff])]);
  const challengeReply = await sendQuery(host, port, challengeReq, timeoutMs);
  if (!(challengeReply.length >= 9 && challengeReply[4] === RESPONSE_CHALLENGE)) {
    throw new Error('A2S_PLAYER challenge was not returned');
  }
  const challenge = challengeReply.subarray(5, 9);
  const reply = await sendQuery(host, port, Buffer.concat([HEADER, Buffer.from([PLAYER_REQUEST]), challenge]), timeoutMs);
  return parseA2SPlayers(reply);
}
