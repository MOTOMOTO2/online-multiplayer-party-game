/**
 * Bluffalo game engine.
 *
 * This module is pure logic: no sockets, no timers, no I/O. The caller owns the
 * clock (`now`) and drives deadlines by calling `tick()`. That keeps the rules
 * fully testable without waiting on real time, and keeps the transport layer
 * (server/lib/room.js) free of game rules.
 *
 * Phase machine:
 *
 *   lobby --start--> lie --(all in | timeout)--> guess --(all in | timeout)-->
 *   reveal --(timeout | host)--> lie (next round) ... --> final --again--> lobby
 */

import { PROMPT_BANK, LAZY_LIES } from './prompts.js';
import { normalize, cleanName, uniqueName, clean } from './text.js';

export const PHASE = {
  LOBBY: 'lobby',
  LIE: 'lie',
  GUESS: 'guess',
  REVEAL: 'reveal',
  FINAL: 'final',
};

export const DEFAULTS = {
  lieMs: 60_000,
  guessMs: 45_000,
  revealMs: 20_000,
  totalRounds: 5,
  minPlayers: 2,
  maxPlayers: 10,
  maxNameLen: 16,
  maxLieLen: 60,
  truthPoints: 1000,
  bluffPoints: 500,
  allowedRounds: [3, 5, 8],
};

const ok = (extra = {}) => ({ ok: true, ...extra });
const err = (code, message) => ({ ok: false, code, message });

export class Game {
  constructor({ prompts = PROMPT_BANK, rng = Math.random, now = () => Date.now(), config = {} } = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this.prompts = prompts;
    this.rng = rng;
    this.now = now;

    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.hostId = null;

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.totalRounds = this.cfg.totalRounds;

    this.prompt = null;
    /** @type {Map<string, {text: string, auto: boolean}>} */
    this.lies = new Map();
    /** @type {Array<{id: string, text: string, kind: 'truth'|'lie', authorId: string|null}>} */
    this.options = [];
    /** @type {Map<string, string>} playerId -> optionId */
    this.guesses = new Map();
    this.deadline = null;
    this.phaseMs = null;
    this.reveal = null;
    this.usedPromptIds = new Set();
  }

  // ---------------------------------------------------------------- players

  /**
   * Seat a new player. Players who arrive mid-round sit out until the next
   * round so they can't be scored on a prompt they never saw.
   */
  addPlayer(id, rawName) {
    if (this.players.has(id)) return err('exists', 'You are already in this room.');
    if (this.players.size >= this.cfg.maxPlayers) {
      return err('full', `This room is full (${this.cfg.maxPlayers} players max).`);
    }

    const base = cleanName(rawName, this.cfg.maxNameLen);
    const name = uniqueName(base, [...this.players.values()].map((p) => p.name));
    const playing = this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINAL;

    this.players.set(id, {
      id,
      name,
      score: 0,
      connected: true,
      // Active from the next round if a round is already underway.
      activeFrom: playing ? this.round + 1 : 1,
      roundPts: 0,
      joinedAt: this.now(),
    });

    if (!this.hostId) this.hostId = id;
    return ok({ name, waiting: playing });
  }

  removePlayer(id) {
    const existed = this.players.delete(id);
    this.lies.delete(id);
    this.guesses.delete(id);
    if (existed && this.hostId === id) this.migrateHost();
    return existed;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return false;
    p.connected = connected;
    if (!connected && this.hostId === id) this.migrateHost();
    return true;
  }

  /** Hand the host badge to the longest-standing connected player. */
  migrateHost() {
    const candidates = [...this.players.values()]
      .filter((p) => p.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    this.hostId = candidates.length ? candidates[0].id : null;
  }

  /** Players eligible to act in the current round. */
  activePlayers() {
    return [...this.players.values()].filter((p) => p.activeFrom <= this.round);
  }

  /** Active players we are actually waiting on (disconnected ones can't act). */
  pendingPlayers() {
    return this.activePlayers().filter((p) => p.connected);
  }

  // ------------------------------------------------------------ round flow

  setRounds(byId, n) {
    if (byId !== this.hostId) return err('not_host', 'Only the host can change the round count.');
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINAL) {
      return err('bad_phase', 'You can only change rounds between games.');
    }
    if (!this.cfg.allowedRounds.includes(n)) return err('bad_rounds', 'Pick 3, 5 or 8 rounds.');
    this.totalRounds = n;
    return ok();
  }

  startGame(byId) {
    if (byId !== this.hostId) return err('not_host', 'Only the host can start the game.');
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINAL) {
      return err('bad_phase', 'The game is already running.');
    }
    const ready = [...this.players.values()].filter((p) => p.connected);
    if (ready.length < this.cfg.minPlayers) {
      return err('need_players', `You need at least ${this.cfg.minPlayers} players to start.`);
    }

    for (const p of this.players.values()) {
      p.score = 0;
      p.roundPts = 0;
      p.activeFrom = 1;
    }
    this.round = 0;
    this.reveal = null;
    this.beginRound();
    return ok();
  }

  beginRound() {
    this.round += 1;
    if (this.round > this.totalRounds) return this.finish();

    this.prompt = this.pickPrompt();
    this.lies.clear();
    this.guesses.clear();
    this.options = [];
    this.reveal = null;
    for (const p of this.players.values()) p.roundPts = 0;

    this.enterPhase(PHASE.LIE, this.cfg.lieMs);

    // Degenerate case: everyone left mid-game. Park in the final screen rather
    // than spinning through empty rounds.
    if (this.pendingPlayers().length === 0) this.closeLiePhase();
    return ok();
  }

  pickPrompt() {
    let pool = this.prompts.filter((p) => !this.usedPromptIds.has(p.id));
    if (pool.length === 0) {
      this.usedPromptIds.clear();
      pool = this.prompts;
    }
    const choice = pool[Math.floor(this.rng() * pool.length)];
    this.usedPromptIds.add(choice.id);
    return choice;
  }

  enterPhase(phase, durationMs) {
    this.phase = phase;
    this.phaseMs = durationMs ?? null;
    this.deadline = durationMs ? this.now() + durationMs : null;
  }

  finish() {
    this.phase = PHASE.FINAL;
    this.deadline = null;
    this.phaseMs = null;
    this.round = this.totalRounds;
    return ok();
  }

  // ------------------------------------------------------------- lie phase

  submitLie(id, rawText) {
    if (this.phase !== PHASE.LIE) return err('bad_phase', 'Not accepting lies right now.');
    const player = this.players.get(id);
    if (!player) return err('no_player', 'You are not in this room.');
    if (player.activeFrom > this.round) {
      return err('waiting', 'You join in at the next round - sit tight!');
    }
    if (this.lies.has(id)) return err('already', 'You already submitted a lie this round.');

    const text = clean(rawText, this.cfg.maxLieLen);
    if (normalize(text).length === 0) return err('empty', 'Type something first!');

    if (normalize(text) === normalize(this.prompt.answer)) {
      return err('is_truth', "Spooky - that's the actual truth! Make something up instead.");
    }
    for (const [otherId, lie] of this.lies) {
      if (otherId !== id && normalize(lie.text) === normalize(text)) {
        return err('duplicate', 'Someone already used that lie. Try another!');
      }
    }

    this.lies.set(id, { text, auto: false });
    if (this.pendingPlayers().every((p) => this.lies.has(p.id))) this.closeLiePhase();
    return ok();
  }

  /** Fill in for anyone who didn't answer, then build the shuffled options. */
  closeLiePhase() {
    for (const p of this.activePlayers()) {
      if (!this.lies.has(p.id)) this.lies.set(p.id, { text: this.pickLazyLie(), auto: true });
    }

    const options = [
      { text: this.prompt.answer, kind: 'truth', authorId: null },
      ...[...this.lies.entries()].map(([authorId, lie]) => ({
        text: lie.text,
        kind: 'lie',
        authorId,
        auto: lie.auto,
      })),
    ];
    // Ids are assigned *after* shuffling and carry no meaning. If the truth
    // were always id "truth" (or always index 0), anyone reading the socket
    // payload in devtools could win every round.
    this.options = this.shuffle(options).map((o, i) => ({ ...o, id: `o${i}` }));
    this.enterPhase(PHASE.GUESS, this.cfg.guessMs);

    if (this.pendingPlayers().length === 0) this.closeGuessPhase();
  }

  /** A fallback lie that collides with neither the truth nor another lie. */
  pickLazyLie() {
    const taken = new Set([
      normalize(this.prompt.answer),
      ...[...this.lies.values()].map((l) => normalize(l.text)),
    ]);
    const free = LAZY_LIES.filter((l) => !taken.has(normalize(l)));
    if (free.length) return free[Math.floor(this.rng() * free.length)];
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `no answer ${i}`;
      if (!taken.has(normalize(candidate))) return candidate;
    }
    return `no answer ${this.rng()}`;
  }

  // ----------------------------------------------------------- guess phase

  submitGuess(id, optionId) {
    if (this.phase !== PHASE.GUESS) return err('bad_phase', 'Not accepting guesses right now.');
    const player = this.players.get(id);
    if (!player) return err('no_player', 'You are not in this room.');
    if (player.activeFrom > this.round) {
      return err('waiting', 'You join in at the next round - sit tight!');
    }
    if (this.guesses.has(id)) return err('already', 'You already locked in a guess.');

    const option = this.options.find((o) => o.id === optionId);
    if (!option) return err('no_option', 'That answer is not on the board.');
    if (option.authorId === id) return err('own_lie', "That's your own lie!");

    this.guesses.set(id, optionId);
    if (this.pendingPlayers().every((p) => this.guesses.has(p.id))) this.closeGuessPhase();
    return ok();
  }

  /** Score the round and build the reveal payload. */
  closeGuessPhase() {
    const truth = this.options.find((o) => o.kind === 'truth');

    const pickedBy = new Map(this.options.map((o) => [o.id, []]));
    for (const [playerId, optionId] of this.guesses) {
      if (pickedBy.has(optionId)) pickedBy.get(optionId).push(playerId);
    }

    const awards = [];
    for (const p of this.activePlayers()) {
      const foundTruth = this.guesses.get(p.id) === truth.id;
      const myOption = this.options.find((o) => o.authorId === p.id);
      const fooled = myOption ? pickedBy.get(myOption.id).length : 0;

      const truthBonus = foundTruth ? this.cfg.truthPoints : 0;
      const bluffBonus = fooled * this.cfg.bluffPoints;

      p.roundPts = truthBonus + bluffBonus;
      p.score += p.roundPts;

      awards.push({
        playerId: p.id,
        name: p.name,
        foundTruth,
        fooled,
        truthBonus,
        bluffBonus,
        roundPts: p.roundPts,
        score: p.score,
        guessedOptionId: this.guesses.get(p.id) ?? null,
        autoLie: Boolean(myOption?.auto),
      });
    }

    this.reveal = {
      truthOptionId: truth.id,
      answer: this.prompt.answer,
      options: this.options.map((o) => ({
        id: o.id,
        text: o.text,
        kind: o.kind,
        authorId: o.authorId,
        authorName: o.authorId ? (this.players.get(o.authorId)?.name ?? 'Someone') : null,
        auto: Boolean(o.auto),
        pickedBy: pickedBy.get(o.id).map((pid) => ({
          id: pid,
          name: this.players.get(pid)?.name ?? 'Someone',
        })),
      })),
      awards: awards.sort((a, b) => b.roundPts - a.roundPts),
      noGuess: this.activePlayers()
        .filter((p) => !this.guesses.has(p.id))
        .map((p) => ({ id: p.id, name: p.name })),
    };

    this.enterPhase(PHASE.REVEAL, this.cfg.revealMs);
  }

  // ----------------------------------------------------------------- clock

  /**
   * Advance the machine if the current phase's deadline has passed.
   * Returns true when something changed, so the caller knows to broadcast.
   */
  tick() {
    if (this.deadline === null) return false;
    if (this.now() < this.deadline) return false;

    switch (this.phase) {
      case PHASE.LIE:
        this.closeLiePhase();
        return true;
      case PHASE.GUESS:
        this.closeGuessPhase();
        return true;
      case PHASE.REVEAL:
        this.beginRound();
        return true;
      default:
        this.deadline = null;
        return false;
    }
  }

  /** Host "skip ahead" button: close the current phase immediately. */
  skip(byId) {
    if (byId !== this.hostId) return err('not_host', 'Only the host can skip ahead.');
    switch (this.phase) {
      case PHASE.LIE:
        this.closeLiePhase();
        return ok();
      case PHASE.GUESS:
        this.closeGuessPhase();
        return ok();
      case PHASE.REVEAL:
        this.beginRound();
        return ok();
      default:
        return err('bad_phase', 'Nothing to skip.');
    }
  }

  /** Back to the lobby with scores cleared, keeping everyone seated. */
  playAgain(byId) {
    if (byId !== this.hostId) return err('not_host', 'Only the host can start a new game.');
    if (this.phase !== PHASE.FINAL) return err('bad_phase', 'Finish this game first.');
    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.prompt = null;
    this.lies.clear();
    this.guesses.clear();
    this.options = [];
    this.reveal = null;
    this.deadline = null;
    this.phaseMs = null;
    for (const p of this.players.values()) {
      p.score = 0;
      p.roundPts = 0;
      p.activeFrom = 1;
    }
    return ok();
  }

  // ------------------------------------------------------------------ view

  /** Fisher-Yates using the injected rng, so tests can pin the order. */
  shuffle(items) {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  standings() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((p, i) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        rank: i + 1,
      }));
  }

  /** True once this player has done what the current phase asks of them. */
  hasActed(playerId) {
    if (this.phase === PHASE.LIE) return this.lies.has(playerId);
    if (this.phase === PHASE.GUESS) return this.guesses.has(playerId);
    return false;
  }

  /**
   * Build the slice of state a single player is allowed to see.
   *
   * This is the security boundary of the whole game: the correct answer and
   * other players' lies must never leave the server before the reveal.
   */
  viewFor(playerId) {
    const me = this.players.get(playerId) ?? null;
    const playing = this.phase === PHASE.LIE || this.phase === PHASE.GUESS || this.phase === PHASE.REVEAL;

    const view = {
      phase: this.phase,
      round: this.round,
      totalRounds: this.totalRounds,
      hostId: this.hostId,
      youId: playerId,
      isHost: this.hostId === playerId,
      deadlineIn: this.deadline === null ? null : Math.max(0, this.deadline - this.now()),
      phaseMs: this.phaseMs,
      limits: {
        minPlayers: this.cfg.minPlayers,
        maxPlayers: this.cfg.maxPlayers,
        maxLieLen: this.cfg.maxLieLen,
        allowedRounds: this.cfg.allowedRounds,
        truthPoints: this.cfg.truthPoints,
        bluffPoints: this.cfg.bluffPoints,
      },
      players: [...this.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          score: p.score,
          roundPts: p.roundPts,
          connected: p.connected,
          isHost: p.id === this.hostId,
          waiting: p.activeFrom > this.round && playing,
          acted: this.hasActed(p.id),
        })),
      // The prompt text is public during play; the answer is not.
      prompt: playing && this.prompt ? { text: this.prompt.text } : null,
      you: me
        ? {
            name: me.name,
            score: me.score,
            roundPts: me.roundPts,
            waiting: me.activeFrom > this.round && playing,
            lie: this.lies.get(playerId)?.text ?? null,
            guess: this.guesses.get(playerId) ?? null,
          }
        : null,
      options: [],
      reveal: null,
      standings: this.phase === PHASE.FINAL ? this.standings() : null,
      // Only the two acting phases have anyone to wait on.
      waitingOn:
        this.phase === PHASE.LIE || this.phase === PHASE.GUESS
          ? this.pendingPlayers()
              .filter((p) => !this.hasActed(p.id))
              .map((p) => p.name)
          : [],
    };

    if (this.phase === PHASE.GUESS) {
      // Authors stay hidden, except that you need to know which one is yours
      // so the UI can grey it out.
      view.options = this.options.map((o) => ({
        id: o.id,
        text: o.text,
        mine: o.authorId === playerId,
      }));
    } else if (this.phase === PHASE.REVEAL) {
      view.reveal = this.reveal;
      view.options = this.reveal.options;
    }

    return view;
  }
}
