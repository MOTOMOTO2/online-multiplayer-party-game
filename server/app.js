/**
 * HTTP + WebSocket server.
 *
 * Exported as a factory so tests can boot a real server on an ephemeral port,
 * connect real WebSocket clients and play a real game (see test/e2e.test.js).
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { RoomManager } from './lib/rooms.js';
import { createStaticHandler } from './lib/static.js';
import { cleanName } from './lib/text.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

const LIMITS = {
  /** Largest accepted frame. A lie is <= 60 chars, so this is generous. */
  maxPayload: 4096,
  /** Simple token bucket: messages allowed per window before we hang up. */
  msgsPerWindow: 60,
  windowMs: 10_000,
  /** Proxy-friendly keepalive. Fly's edge idles out silent sockets. */
  heartbeatMs: 25_000,
};

export function createGameServer({ gameOptions = {}, roomConfig = {}, publicDir = PUBLIC_DIR } = {}) {
  const rooms = new RoomManager({ gameOptions, config: roomConfig });
  const serveStatic = createStaticHandler(publicDir);

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime(), ...rooms.stats() }));
      return;
    }
    serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: LIMITS.maxPayload });

  wss.on('connection', (ws) => {
    const ctx = { room: null, playerId: null, count: 0, windowStart: Date.now(), alive: true };
    ws.ctx = ctx;

    ws.on('pong', () => {
      ctx.alive = true;
    });

    const fail = (code, message) => ws.send(JSON.stringify({ t: 'error', code, message }));

    ws.on('message', (raw) => {
      // Rate limit before doing any work.
      const now = Date.now();
      if (now - ctx.windowStart > LIMITS.windowMs) {
        ctx.windowStart = now;
        ctx.count = 0;
      }
      ctx.count += 1;
      if (ctx.count > LIMITS.msgsPerWindow) {
        ws.close(4029, 'slow down');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        fail('bad_json', 'Could not read that message.');
        return;
      }
      if (!msg || typeof msg.t !== 'string') {
        fail('bad_msg', 'Malformed message.');
        return;
      }

      handle(ws, ctx, msg, { rooms, fail });
    });

    ws.on('close', () => {
      const room = ctx.room;
      if (!room || !ctx.playerId) return;
      // Keep the seat (and the score) so a refresh or a dropped phone can
      // resume; just mark them offline.
      room.detach(ctx.playerId);
      room.game.setConnected(ctx.playerId, false);
      const player = room.game.players.get(ctx.playerId);
      if (player) room.broadcast({ t: 'note', text: `${player.name} went offline` });
      room.broadcastState();
    });

    ws.on('error', () => ws.terminate());
  });

  // Reap sockets that stopped answering (dead phones, sleeping laptops).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.ctx && ws.ctx.alive === false) {
        ws.terminate();
        continue;
      }
      if (ws.ctx) ws.ctx.alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, LIMITS.heartbeatMs);
  heartbeat.unref?.();

  rooms.start();

  return {
    server,
    wss,
    rooms,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      clearInterval(heartbeat);
      rooms.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Route one validated message. Kept separate so the flow reads top to bottom. */
function handle(ws, ctx, msg, { rooms, fail }) {
  const seated = () => {
    if (!ctx.room || !ctx.playerId) {
      fail('not_in_room', 'Join a room first.');
      return null;
    }
    return ctx.room;
  };

  /** Apply an engine result: broadcast on success, report the reason on failure. */
  const apply = (room, result) => {
    if (result?.ok) room.broadcastState();
    else fail(result?.code ?? 'rejected', result?.message ?? 'That did not work.');
  };

  switch (msg.t) {
    case 'ping':
      ws.send(JSON.stringify({ t: 'pong' }));
      return;

    case 'create': {
      if (ctx.room) {
        fail('already_in_room', 'Leave your current room first.');
        return;
      }
      const room = rooms.create();
      if (!room) {
        fail('no_capacity', 'The server is at capacity - try again shortly.');
        return;
      }
      seat(ws, ctx, room, msg.name, { fail });
      return;
    }

    case 'join': {
      if (ctx.room) {
        fail('already_in_room', 'Leave your current room first.');
        return;
      }
      const room = rooms.get(msg.code);
      if (!room) {
        fail('no_room', 'No room with that code. Check the letters and try again.');
        return;
      }
      seat(ws, ctx, room, msg.name, { fail });
      return;
    }

    case 'resume': {
      const room = rooms.get(msg.code);
      if (!room) {
        fail('no_room', 'That room has closed.');
        return;
      }
      const playerId = String(msg.playerId ?? '');
      if (!room.game.players.has(playerId) || !room.verify(playerId, msg.token)) {
        fail('bad_resume', 'Could not get you back into that game.');
        return;
      }
      ctx.room = room;
      ctx.playerId = playerId;
      room.attach(playerId, ws);
      room.game.setConnected(playerId, true);
      const player = room.game.players.get(playerId);
      ws.send(
        JSON.stringify({
          t: 'joined',
          room: room.code,
          playerId,
          token: room.tokens.get(playerId),
          name: player.name,
          resumed: true,
        }),
      );
      ws.send(JSON.stringify({ t: 'chatHistory', entries: room.chat }));
      room.broadcast({ t: 'note', text: `${player.name} is back` }, { except: playerId });
      room.broadcastState();
      return;
    }

    case 'start': {
      const room = seated();
      if (room) apply(room, room.game.startGame(ctx.playerId));
      return;
    }

    case 'rounds': {
      const room = seated();
      if (room) apply(room, room.game.setRounds(ctx.playerId, Number(msg.n)));
      return;
    }

    case 'lie': {
      const room = seated();
      if (room) apply(room, room.game.submitLie(ctx.playerId, msg.text));
      return;
    }

    case 'guess': {
      const room = seated();
      if (room) apply(room, room.game.submitGuess(ctx.playerId, String(msg.optionId ?? '')));
      return;
    }

    case 'skip': {
      const room = seated();
      if (room) apply(room, room.game.skip(ctx.playerId));
      return;
    }

    case 'again': {
      const room = seated();
      if (room) apply(room, room.game.playAgain(ctx.playerId));
      return;
    }

    case 'chat': {
      const room = seated();
      if (!room) return;
      const entry = room.addChat(ctx.playerId, msg.text);
      if (entry) room.broadcast({ t: 'chat', entry });
      return;
    }

    case 'leave': {
      const room = seated();
      if (!room) return;
      const player = room.game.players.get(ctx.playerId);
      room.detach(ctx.playerId);
      room.game.removePlayer(ctx.playerId);
      room.tokens.delete(ctx.playerId);
      if (player) room.broadcast({ t: 'note', text: `${player.name} left` });
      room.broadcastState();
      ctx.room = null;
      ctx.playerId = null;
      ws.send(JSON.stringify({ t: 'left' }));
      return;
    }

    default:
      fail('unknown', `Unknown action "${msg.t}".`);
  }
}

/** Shared tail of `create` and `join`. */
function seat(ws, ctx, room, rawName, { fail }) {
  const playerId = `pl_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const result = room.game.addPlayer(playerId, cleanName(rawName));
  if (!result.ok) {
    fail(result.code, result.message);
    return;
  }

  ctx.room = room;
  ctx.playerId = playerId;
  const token = room.issueToken(playerId);
  room.attach(playerId, ws);

  ws.send(
    JSON.stringify({
      t: 'joined',
      room: room.code,
      playerId,
      token,
      name: result.name,
      waiting: Boolean(result.waiting),
    }),
  );
  ws.send(JSON.stringify({ t: 'chatHistory', entries: room.chat }));
  room.broadcast({ t: 'note', text: `${result.name} joined` }, { except: playerId });
  room.broadcastState();
}
