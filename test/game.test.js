import test from 'node:test';
import assert from 'node:assert/strict';

import { Game, PHASE, DEFAULTS } from '../server/lib/game.js';

/**
 * Fixture prompt bank. Using our own answers (ALPHA, BRAVO, ...) lets the
 * redaction tests assert on exact strings that cannot appear by accident.
 */
const PROMPTS = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO', 'FOXTROT'].map((answer, i) => ({
  id: `t${i}`,
  text: `Fixture prompt ${i} is ___.`,
  answer,
}));

/** Deterministic PRNG so shuffles and prompt picks are reproducible. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGame({ players = [], config = {}, seed = 7 } = {}) {
  const clock = { t: 1_000_000 };
  const game = new Game({
    prompts: PROMPTS,
    rng: mulberry32(seed),
    now: () => clock.t,
    config: { totalRounds: 3, ...config },
  });
  for (const [id, name] of players) {
    const res = game.addPlayer(id, name);
    assert.equal(res.ok, true, `addPlayer(${id}) should succeed`);
  }
  return { game, clock, advance: (ms) => { clock.t += ms; } };
}

/** Everyone submits a distinct lie; returns the lie text keyed by player id. */
function allLie(game, ids) {
  const lies = {};
  for (const id of ids) {
    lies[id] = `lie-from-${id}`;
    const res = game.submitLie(id, lies[id]);
    assert.equal(res.ok, true, `submitLie(${id}): ${res.message ?? ''}`);
  }
  return lies;
}

const truthId = (game) => game.options.find((o) => o.kind === 'truth').id;
const optionOf = (game, authorId) => game.options.find((o) => o.authorId === authorId).id;

// ---------------------------------------------------------------- lobby

test('first player becomes host and duplicate names are made unique', () => {
  const { game } = makeGame({ players: [['a', 'Sam'], ['b', 'Sam']] });
  assert.equal(game.hostId, 'a');
  assert.equal(game.players.get('a').name, 'Sam');
  assert.equal(game.players.get('b').name, 'Sam 2');
});

test('blank and overlong names are normalised', () => {
  const { game } = makeGame({ players: [['a', '   '], ['b', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']] });
  assert.equal(game.players.get('a').name, 'Player');
  assert.equal(game.players.get('b').name.length, DEFAULTS.maxNameLen);
});

test('rooms are capped at maxPlayers', () => {
  const { game } = makeGame({ config: { maxPlayers: 2 } });
  assert.equal(game.addPlayer('a', 'A').ok, true);
  assert.equal(game.addPlayer('b', 'B').ok, true);
  const third = game.addPlayer('c', 'C');
  assert.equal(third.ok, false);
  assert.equal(third.code, 'full');
});

test('a game needs at least two players and only the host may start it', () => {
  const { game } = makeGame({ players: [['a', 'A']] });
  assert.equal(game.startGame('a').code, 'need_players');

  game.addPlayer('b', 'B');
  assert.equal(game.startGame('b').code, 'not_host');

  const started = game.startGame('a');
  assert.equal(started.ok, true);
  assert.equal(game.phase, PHASE.LIE);
  assert.equal(game.round, 1);
});

test('host can only set an allowed round count, and only between games', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  assert.equal(game.setRounds('a', 7).code, 'bad_rounds');
  assert.equal(game.setRounds('a', 8).ok, true);
  assert.equal(game.totalRounds, 8);

  game.setRounds('a', 3);
  game.startGame('a');
  assert.equal(game.setRounds('a', 5).code, 'bad_phase');
});

// ------------------------------------------------------------- lie phase

test('a lie matching the real answer is rejected', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');

  const res = game.submitLie('a', ` ${game.prompt.answer.toLowerCase()}! `);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'is_truth');
  assert.equal(game.lies.has('a'), false);
});

test('a lie duplicating another player is rejected (case/punctuation insensitive)', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C']] });
  game.startGame('a');

  assert.equal(game.submitLie('a', 'Three Hundred Cats').ok, true);
  const dupe = game.submitLie('b', '  three hundred cats!! ');
  assert.equal(dupe.code, 'duplicate');
  assert.equal(game.lies.has('b'), false);
});

test('empty lies are rejected and overlong lies are clamped', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');

  assert.equal(game.submitLie('a', '   ').code, 'empty');
  assert.equal(game.submitLie('a', '!!!...').code, 'empty');

  game.submitLie('a', 'x'.repeat(200));
  assert.equal(game.lies.get('a').text.length, DEFAULTS.maxLieLen);
});

test('a player cannot submit two lies in one round', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  assert.equal(game.submitLie('a', 'first').ok, true);
  assert.equal(game.submitLie('a', 'second').code, 'already');
  assert.equal(game.lies.get('a').text, 'first');
});

test('the lie phase closes as soon as every connected player has answered', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C']] });
  game.startGame('a');

  game.submitLie('a', 'one');
  game.submitLie('b', 'two');
  assert.equal(game.phase, PHASE.LIE, 'still waiting on C');

  game.submitLie('c', 'three');
  assert.equal(game.phase, PHASE.GUESS);
  // One truth plus one lie per player.
  assert.equal(game.options.length, 4);
  assert.equal(game.options.filter((o) => o.kind === 'truth').length, 1);
});

test('a disconnected player is not waited on, but their lie stays in play', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C']] });
  game.startGame('a');

  game.submitLie('c', 'ghost lie');
  game.setConnected('c', false);
  game.submitLie('a', 'one');
  game.submitLie('b', 'two');

  assert.equal(game.phase, PHASE.GUESS, 'offline player should not block the round');
  assert.ok(game.options.some((o) => o.text === 'ghost lie' && o.authorId === 'c'));
});

test('the lie clock running out autofills a lazy lie for anyone who idled', () => {
  const { game, advance } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  game.submitLie('a', 'my real attempt');

  advance(DEFAULTS.lieMs + 1);
  assert.equal(game.tick(), true);

  assert.equal(game.phase, PHASE.GUESS);
  assert.equal(game.lies.get('b').auto, true);
  assert.equal(game.lies.get('a').auto, false);
  assert.equal(game.options.length, 3);
});

test('autofilled lies never collide with the truth or another lie', () => {
  const { game, advance } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']] });
  game.startGame('a');
  advance(DEFAULTS.lieMs + 1);
  game.tick();

  const texts = game.options.map((o) => o.text.toLowerCase());
  assert.equal(new Set(texts).size, texts.length, 'all options must be distinct');
});

// ----------------------------------------------------------- guess phase

test('you cannot pick your own lie, or an option that does not exist', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  allLie(game, ['a', 'b']);

  assert.equal(game.submitGuess('a', optionOf(game, 'a')).code, 'own_lie');
  assert.equal(game.submitGuess('a', 'nope').code, 'no_option');
  assert.equal(game.guesses.has('a'), false);
});

test('finding the truth scores the truth bonus; fooling someone scores the bluff bonus', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C']] });
  game.startGame('a');
  allLie(game, ['a', 'b', 'c']);

  // A finds the truth. B and C both fall for A's lie.
  game.submitGuess('a', truthId(game));
  game.submitGuess('b', optionOf(game, 'a'));
  game.submitGuess('c', optionOf(game, 'a'));

  assert.equal(game.phase, PHASE.REVEAL);
  assert.equal(game.players.get('a').score, DEFAULTS.truthPoints + 2 * DEFAULTS.bluffPoints);
  assert.equal(game.players.get('b').score, 0);
  assert.equal(game.players.get('c').score, 0);
});

test('not guessing in time scores nothing', () => {
  const { game, advance } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  allLie(game, ['a', 'b']);

  game.submitGuess('a', truthId(game));
  advance(DEFAULTS.guessMs + 1);
  game.tick();

  assert.equal(game.phase, PHASE.REVEAL);
  assert.equal(game.players.get('a').score, DEFAULTS.truthPoints);
  assert.equal(game.players.get('b').score, 0);
  assert.deepEqual(game.reveal.noGuess.map((p) => p.id), ['b']);
});

test('the reveal reports authors, pickers and a per-player points breakdown', () => {
  const { game } = makeGame({ players: [['a', 'Ann'], ['b', 'Bo'], ['c', 'Cy']] });
  game.startGame('a');
  allLie(game, ['a', 'b', 'c']);

  const aLie = optionOf(game, 'a');
  game.submitGuess('a', truthId(game));
  game.submitGuess('b', aLie);
  game.submitGuess('c', truthId(game));

  const { reveal } = game;
  const truthOption = reveal.options.find((o) => o.id === reveal.truthOptionId);
  assert.equal(truthOption.kind, 'truth');
  assert.equal(truthOption.authorName, null);
  assert.deepEqual(truthOption.pickedBy.map((p) => p.name).sort(), ['Ann', 'Cy']);

  const annLie = reveal.options.find((o) => o.id === aLie);
  assert.equal(annLie.authorName, 'Ann');
  assert.deepEqual(annLie.pickedBy.map((p) => p.name), ['Bo']);

  const ann = reveal.awards.find((x) => x.playerId === 'a');
  assert.equal(ann.foundTruth, true);
  assert.equal(ann.fooled, 1);
  assert.equal(ann.roundPts, DEFAULTS.truthPoints + DEFAULTS.bluffPoints);
  assert.equal(reveal.awards[0].playerId, 'a', 'awards are sorted best-first');
});

// -------------------------------------------------------------- redaction

test('the answer and rival lies never leave the server during the lie phase', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  const answer = game.prompt.answer;
  game.submitLie('b', 'b-secret-lie');

  const view = JSON.stringify(game.viewFor('a'));
  assert.equal(view.includes(answer), false, 'answer leaked');
  assert.equal(view.includes('b-secret-lie'), false, 'rival lie leaked');
  assert.equal(game.viewFor('a').options.length, 0);
});

test('guess-phase options hide their authors but flag your own lie', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  allLie(game, ['a', 'b']);

  const view = game.viewFor('a');
  assert.equal(view.options.length, 3);
  for (const o of view.options) {
    assert.equal('authorId' in o, false, 'author leaked during guessing');
    assert.equal('kind' in o, false, 'truth flag leaked during guessing');
  }
  assert.equal(view.options.filter((o) => o.mine).length, 1);
  assert.equal(view.options.find((o) => o.mine).text, 'lie-from-a');

  // The truth is on the board on purpose - that is the thing you're hunting.
  // What matters is that nothing in the payload marks it out.
  const truthOnBoard = view.options.filter((o) => o.text === game.prompt.answer);
  assert.equal(truthOnBoard.length, 1, 'the real answer should be one of the options');
  assert.deepEqual(Object.keys(truthOnBoard[0]).sort(), ['id', 'mine', 'text']);
  assert.equal(truthOnBoard[0].mine, false);
  assert.equal(view.reveal, null);
  assert.equal(truthOnBoard[0].id, truthId(game), 'sanity: it really is the truth option');
});

test('option ids are opaque, so the wire payload cannot betray the truth', () => {
  // Across many rounds the truth must land on different ids, and no id may
  // hint at what it holds.
  const positions = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    const { game } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C']], seed });
    game.startGame('a');
    allLie(game, ['a', 'b', 'c']);

    for (const o of game.options) assert.match(o.id, /^o\d+$/);
    for (const o of game.viewFor('a').options) {
      assert.equal(/truth|lie|answer/i.test(o.id), false, `telltale option id: ${o.id}`);
    }
    positions.add(truthId(game));
  }
  assert.ok(positions.size > 1, `truth was always at ${[...positions]} - ordering is predictable`);
});

test('the reveal view finally exposes the answer', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  allLie(game, ['a', 'b']);
  game.submitGuess('a', truthId(game));
  game.submitGuess('b', truthId(game));

  const view = game.viewFor('a');
  assert.equal(view.reveal.answer, game.prompt.answer);
  assert.ok(view.options.every((o) => 'authorId' in o));
});

// ----------------------------------------------------------- joining late

test('a player who joins mid-round sits out until the next round', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');

  const late = game.addPlayer('c', 'Late');
  assert.equal(late.ok, true);
  assert.equal(late.waiting, true);
  assert.equal(game.submitLie('c', 'too soon').code, 'waiting');
  assert.deepEqual(game.activePlayers().map((p) => p.id), ['a', 'b']);
  assert.equal(game.viewFor('c').you.waiting, true);

  // Finish round 1, then round 2 should include them.
  allLie(game, ['a', 'b']);
  game.submitGuess('a', truthId(game));
  game.submitGuess('b', truthId(game));
  game.skip('a');

  assert.equal(game.round, 2);
  assert.deepEqual(game.activePlayers().map((p) => p.id).sort(), ['a', 'b', 'c']);
  assert.equal(game.submitLie('c', 'now I can play').ok, true);
});

// ------------------------------------------------------------------ host

test('the host badge moves on when the host drops off', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B'], ['c', 'C']] });
  assert.equal(game.hostId, 'a');

  game.setConnected('a', false);
  assert.equal(game.hostId, 'b', 'host should pass to the next oldest connected player');

  game.removePlayer('b');
  assert.equal(game.hostId, 'c');
});

test('only the host can skip a phase', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  assert.equal(game.skip('b').code, 'not_host');
  assert.equal(game.skip('a').ok, true);
  assert.equal(game.phase, PHASE.GUESS);
});

// ------------------------------------------------------------- full games

test('a full three-round game ends in a ranked final scoreboard', () => {
  const ids = ['a', 'b', 'c'];
  const { game, advance } = makeGame({
    players: [['a', 'Ann'], ['b', 'Bo'], ['c', 'Cy']],
    config: { totalRounds: 3 },
  });
  game.startGame('a');

  const seenPrompts = [];
  for (let round = 1; round <= 3; round += 1) {
    assert.equal(game.phase, PHASE.LIE);
    assert.equal(game.round, round);
    seenPrompts.push(game.prompt.id);

    allLie(game, ids);
    // Ann always finds the truth; Bo and Cy always fall for Ann's lie.
    game.submitGuess('a', truthId(game));
    game.submitGuess('b', optionOf(game, 'a'));
    game.submitGuess('c', optionOf(game, 'a'));
    assert.equal(game.phase, PHASE.REVEAL);

    advance(DEFAULTS.revealMs + 1);
    game.tick();
  }

  assert.equal(game.phase, PHASE.FINAL);
  assert.equal(new Set(seenPrompts).size, 3, 'prompts must not repeat within a game');

  const standings = game.viewFor('a').standings;
  assert.equal(standings[0].name, 'Ann');
  assert.equal(standings[0].rank, 1);
  assert.equal(standings[0].score, 3 * (DEFAULTS.truthPoints + 2 * DEFAULTS.bluffPoints));
  assert.deepEqual(standings.slice(1).map((s) => s.score), [0, 0]);
});

test('a two-player game is playable end to end', () => {
  const { game } = makeGame({ players: [['a', 'Ann'], ['b', 'Bo']], config: { totalRounds: 1 } });
  game.startGame('a');
  allLie(game, ['a', 'b']);

  // With two players each sees three options and may pick two of them.
  const view = game.viewFor('a');
  assert.equal(view.options.length, 3);
  assert.equal(view.options.filter((o) => !o.mine).length, 2);

  game.submitGuess('a', optionOf(game, 'b'));
  game.submitGuess('b', truthId(game));
  assert.equal(game.phase, PHASE.REVEAL);
  assert.equal(game.players.get('a').score, 0);
  assert.equal(game.players.get('b').score, DEFAULTS.truthPoints + DEFAULTS.bluffPoints);

  game.skip('a');
  assert.equal(game.phase, PHASE.FINAL);
  assert.equal(game.viewFor('b').standings[0].name, 'Bo');
});

test('play again clears scores and returns everyone to the lobby', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']], config: { totalRounds: 1 } });
  game.startGame('a');
  allLie(game, ['a', 'b']);
  game.submitGuess('a', truthId(game));
  game.submitGuess('b', truthId(game));
  game.skip('a');
  assert.equal(game.phase, PHASE.FINAL);
  assert.ok(game.players.get('a').score > 0);

  assert.equal(game.playAgain('b').code, 'not_host');
  assert.equal(game.playAgain('a').ok, true);
  assert.equal(game.phase, PHASE.LOBBY);
  assert.equal(game.round, 0);
  assert.equal(game.players.get('a').score, 0);
  assert.equal(game.viewFor('a').prompt, null);

  assert.equal(game.startGame('a').ok, true, 'should be able to start a fresh game');
});

test('the prompt bank recycles once every prompt has been used', () => {
  const { game } = makeGame({
    players: [['a', 'A'], ['b', 'B']],
    config: { totalRounds: 8 },
  });
  game.startGame('a');
  // Only 6 fixture prompts exist, so rounds 7-8 force a recycle.
  for (let round = 1; round <= 8; round += 1) {
    assert.ok(game.prompt, `round ${round} must have a prompt`);
    allLie(game, ['a', 'b']);
    game.submitGuess('a', truthId(game));
    game.submitGuess('b', truthId(game));
    game.skip('a');
  }
  assert.equal(game.phase, PHASE.FINAL);
});

test('deadlines only fire once their time has come', () => {
  const { game, advance } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');

  advance(DEFAULTS.lieMs - 10);
  assert.equal(game.tick(), false);
  assert.equal(game.phase, PHASE.LIE);

  advance(20);
  assert.equal(game.tick(), true);
  assert.equal(game.phase, PHASE.GUESS);
});

test('actions are rejected outside their phase', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  assert.equal(game.submitLie('a', 'too early').code, 'bad_phase');
  assert.equal(game.submitGuess('a', 'truth').code, 'bad_phase');
  assert.equal(game.playAgain('a').code, 'bad_phase');

  game.startGame('a');
  assert.equal(game.submitGuess('a', 'truth').code, 'bad_phase');
  assert.equal(game.startGame('a').code, 'bad_phase');
});

test('a stranger cannot act on a room they are not in', () => {
  const { game } = makeGame({ players: [['a', 'A'], ['b', 'B']] });
  game.startGame('a');
  assert.equal(game.submitLie('zz', 'hello').code, 'no_player');
  assert.equal(game.submitGuess('zz', 'truth').code, 'bad_phase');
});
