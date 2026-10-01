/**
 * Rooms: the transport-facing wrapper around the pure game engine.
 *
 * A Room owns one Game plus the live sockets attached to it. State is kept in
 * memory in a single process, which is why the deploy runs exactly one machine
 * (see fly.toml / README). Rooms are ephemeral by design - a party game does
 * not need to outlive the party.
 */

import { randomUUID } from 'node:crypto';
import { Game } from './game.js';
import { clean } from './text.js';

/** Ambiguous characters (I/O/0/1/L) are excluded so codes are easy to read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;

export const ROOM_DEFAULTS = {
  tickMs: 250,
  /** Drop a room this long after its last connected socket leaves. */
  idleGraceMs: 15 * 60 * 1000,
  maxChatLen: 140,
  chatHistory: 50,
  maxRooms: 500,
};

export class Room {
  constructor(code, { gameOptions = {}, now = () => Date.now() } = {}) {
    this.code = code;
    this.now = now;
    this.game = new Game({ now, ...gameOptions });
    /** @type {Map<string, import('ws').WebSocket>} playerId -> socket */
    this.sockets = new Map();
    /** @type {Map<string, string>} playerId -> reconnect token */
    this.tokens = new Map();
    this.chat = [];
    this.emptySince = now();
  }

  get connectionCount() {
    return this.sockets.size;
  }

  /** Send one message to one player. */
  sendTo(playerId, payload) {
    const ws = this.sockets.get(playerId);
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // A dead socket will surface via the 'close' handler; nothing to do here.
    }
  }

  /** Push each player their own redacted view of the game. */
  broadcastState() {
    for (const playerId of this.sockets.keys()) {
      this.sendTo(playerId, { t: 'state', room: this.code, state: this.game.viewFor(playerId) });
    }
  }

  broadcast(payload, { except } = {}) {
    for (const playerId of this.sockets.keys()) {
      if (playerId !== except) this.sendTo(playerId, payload);
    }
  }

  attach(playerId, ws) {
    const previous = this.sockets.get(playerId);
    this.sockets.set(playerId, ws);
    this.emptySince = null;
    // Reconnected from a new device/tab: retire the stale socket.
    if (previous && previous !== ws && previous.readyState === 1) {
      try {
        previous.send(JSON.stringify({ t: 'replaced' }));
        previous.close(4001, 'replaced');
      } catch {
        /* ignore */
      }
    }
  }

  detach(playerId) {
    this.sockets.delete(playerId);
    if (this.sockets.size === 0) this.emptySince = this.now();
  }

  issueToken(playerId) {
    const token = randomUUID();
    this.tokens.set(playerId, token);
    return token;
  }

  verify(playerId, token) {
    return Boolean(token) && this.tokens.get(playerId) === token;
  }

  addChat(playerId, rawText) {
    const player = this.game.players.get(playerId);
    const text = clean(rawText, ROOM_DEFAULTS.maxChatLen);
    if (!player || text.length === 0) return null;
    const entry = { from: player.name, text, at: this.now() };
    this.chat.push(entry);
    if (this.chat.length > ROOM_DEFAULTS.chatHistory) this.chat.shift();
    return entry;
  }
}

export class RoomManager {
  constructor({ now = () => Date.now(), gameOptions = {}, config = {} } = {}) {
    this.cfg = { ...ROOM_DEFAULTS, ...config };
    this.now = now;
    this.gameOptions = gameOptions;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.timer = null;
  }

  generateCode() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely with 279k codes, but never hand back a collision.
    return null;
  }

  create() {
    if (this.rooms.size >= this.cfg.maxRooms) return null;
    const code = this.generateCode();
    if (!code) return null;
    const room = new Room(code, { gameOptions: this.gameOptions, now: this.now });
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').toUpperCase().trim()) ?? null;
  }

  /**
   * Drive every room's clock, broadcasting only when a phase actually changed,
   * and reap rooms nobody has been connected to for a while.
   */
  tick() {
    for (const [code, room] of this.rooms) {
      const before = `${room.game.phase}:${room.game.round}`;
      if (room.game.tick() || `${room.game.phase}:${room.game.round}` !== before) {
        room.broadcastState();
      }
      if (room.sockets.size === 0 && room.emptySince !== null) {
        if (this.now() - room.emptySince > this.cfg.idleGraceMs) this.rooms.delete(code);
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats() {
    let connections = 0;
    let activeGames = 0;
    for (const room of this.rooms.values()) {
      connections += room.connectionCount;
      if (room.game.phase !== 'lobby') activeGames += 1;
    }
    return { rooms: this.rooms.size, connections, activeGames };
  }
}
