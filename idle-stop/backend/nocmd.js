/**
 * Idle Stop — Nuclear Option remote command client.
 *
 * Nuclear Option's dedicated server exposes a TCP command interface when
 * started with `-ServerRemoteCommands [port]` (default 7779):
 *
 *   request  = int32 length (LE) | UTF-8 JSON { name, arguments }
 *   response = int32 status (LE) | int32 length (LE) | UTF-8 JSON (optional)
 *
 * Status 2000 = success; 4xxx client error; 5xxx server error.
 * Pure Node (node:net), no dependencies.
 */

import net from 'node:net';

const SUCCESS = 2000;
const MAX_BYTES = 8 * 1024 * 1024;

export function noCommand({ host, port, name, args = [], timeoutMs = 6000, requireResponse = false }) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('Nuclear Option command host is required'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error('Nuclear Option command port is invalid'));
    if (!name) return reject(new Error('Nuclear Option command name is required'));

    let settled = false;
    let buffer = Buffer.alloc(0);

    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);

    // Some Nuclear Option builds execute a command but never write a response
    // and just close the socket. Unless a response is required, count that as
    // "delivered" instead of an error.
    function noResponse(reason) {
      if (requireResponse) return fail(new Error(`Nuclear Option command "${name}" ${reason}`));
      done({ status: null, body: null, raw: '', closed: true });
    }

    const timer = setTimeout(() => noResponse('timed out'), timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function done(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    socket.on('error', fail);
    socket.on('close', () => {
      if (!settled) noResponse('closed before responding');
    });
    socket.on('connect', () => {
      const json = Buffer.from(JSON.stringify({ name, arguments: args.map(String) }), 'utf8');
      const prefix = Buffer.alloc(4);
      prefix.writeInt32LE(json.length, 0);
      socket.write(Buffer.concat([prefix, json]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;
      const status = buffer.readInt32LE(0);
      const length = buffer.readInt32LE(4);
      if (length < 0 || length > MAX_BYTES) return fail(new Error('invalid Nuclear Option response length'));
      if (buffer.length < 8 + length) return;

      const raw = length > 0 ? buffer.toString('utf8', 8, 8 + length) : '';
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }

      if (status !== SUCCESS) {
        return fail(new Error(`Nuclear Option command "${name}" failed (${status}): ${raw.slice(0, 160)}`));
      }
      done({ status, body, raw });
    });
  });
}
