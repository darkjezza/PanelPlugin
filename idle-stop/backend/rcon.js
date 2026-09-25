/**
 * Idle Stop — Source RCON client over TCP.
 *
 * Implements the Source RCON protocol used by Minecraft (vanilla/Paper via
 * enable-rcon), modern Source servers and most other games:
 *
 *   packet = int32 size | int32 id | int32 type | body\0 + \0
 *   size   = length of (id + type + body + 2 null bytes)
 *
 * Types: 3 = auth, 2 = auth response / exec command, 0 = response value.
 *
 * Pure Node (node:net), no dependencies.
 */

import net from 'node:net';

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_RESPONSE_VALUE = 0;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const QUIET_MS = 250;

function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(String(body ?? ''), 'utf8');
  const size = 4 + 4 + bodyBuf.length + 2;
  const packet = Buffer.allocUnsafe(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuf.copy(packet, 12);
  packet.writeUInt8(0, 12 + bodyBuf.length);
  packet.writeUInt8(0, 13 + bodyBuf.length);
  return packet;
}

/**
 * Run one RCON command and resolve with { output } — the concatenated text
 * the server sent back. Rejects on auth failure, socket error or timeout.
 */
export function rconExec({ host, port, password, command, timeoutMs = 6000 }) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('RCON host is required'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error('RCON port is invalid'));
    if (password === undefined || password === null || String(password) === '') {
      return reject(new Error('RCON password is required'));
    }
    const cleanCommand = String(command ?? '').trim();
    if (!cleanCommand) return reject(new Error('RCON command is required'));

    let settled = false;
    let buffer = Buffer.alloc(0);
    let output = '';
    let authPending = true;
    let quietTimer = null;

    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);

    const hardTimer = setTimeout(() => fail(new Error(`RCON timeout contacting ${host}:${port}`)), timeoutMs);

    function cleanup() {
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      socket.removeAllListeners();
      socket.destroy();
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ output });
    }

    function armQuiet() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(done, QUIET_MS);
    }

    socket.on('error', fail);
    socket.on('close', () => {
      if (!settled && output) done();
    });
    socket.on('connect', () => {
      socket.write(encodePacket(1, SERVERDATA_AUTH, password));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let offset = 0;

      while (buffer.length - offset >= 4) {
        const size = buffer.readInt32LE(offset);
        if (size < 10 || size > MAX_PACKET_BYTES) {
          fail(new Error('invalid RCON packet from server'));
          return;
        }
        if (buffer.length - offset - 4 < size) break;

        const id = buffer.readInt32LE(offset + 4);
        const type = buffer.readInt32LE(offset + 8);
        const body = buffer.toString('utf8', offset + 12, offset + 4 + size - 2);
        offset += 4 + size;

        if (authPending) {
          if (id === -1) {
            fail(new Error('RCON authentication failed (wrong password)'));
            return;
          }
          authPending = false;
          socket.write(encodePacket(2, SERVERDATA_EXECCOMMAND, cleanCommand));
          continue;
        }

        output += body;
        if (type === SERVERDATA_RESPONSE_VALUE || type === SERVERDATA_AUTH_RESPONSE) armQuiet();
      }

      buffer = buffer.subarray(offset);
    });
  });
}
