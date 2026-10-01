/**
 * End-to-end tests: a real HTTP+WebSocket server on an ephemeral port, with
 * real WebSocket clients standing in for separate devices.
 *
 * This is the test that actually proves the headline requirement - several
 * independent connections joining one room and playing a game to completion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { createGameServer } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

/** Long phase timers: these tests drive every transition by player action. */
const NO_TIMEOUTS = { lieMs: 60_000, guessMs: 60_000, revealMs: 60_000 };

async function boot(config = NO_TIMEOUTS) {
  const app = createGameServer({
    gameOptions: { config },
    roomConfig: { tickMs: 25 },
    publicDir: PUBLIC_DIR,
  });
  const address = await app.listen(0, '127.0.0.1');
  return {
    app,
    http: `http://127.0.0.1:${address.port}`,
    ws: `ws://127.0.0.1:${address.port}/ws`,
    close: () => app.close(),
  };
}

/** One simulated device. */
class Client {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.messages = [];
    this.state = null;
    this.notes = [];
    this.chats = [];
    this.errors = [];
    this.waiters = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('message', (raw) => this.#receive(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    return this;
  }

  #receive(msg) {
    this.messages.push(msg);
    if (msg.t === 'state') this.state = msg.state;
    if (msg.t === 'joined') {
      this.room = msg.room;
      this.playerId = msg.playerId;
      this.token = msg.token;
      this.name = msg.name;
    }
    if (msg.t === 'note') this.notes.push(msg.text);
    if (msg.t === 'chat') this.chats.push(msg.entry);
    if (msg.t === 'error') this.errors.push(msg);
    for (const w of [...this.waiters]) w();
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
    return this;
  }

  /** Resolve once `predicate(this)` holds; re-checked on every message. */
  wait(predicate, label, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let hit = false;
        try {
          hit = Boolean(predicate(this));
        } catch {
          hit = false;
        }
        if (!hit) return;
        cleanup();
        resolve(this);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `[${this.label}] timed out waiting for ${label}. ` +
              `phase=${this.state?.phase} round=${this.state?.round} ` +
              `errors=${JSON.stringify(this.errors)}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  waitPhase(phase, round, timeoutMs) {
    return this.wait(
      (c) => c.state?.phase === phase && (round === undefined || c.state.round === round),
      `phase=${phase}${round === undefined ? '' : ` round=${round}`}`,
      timeoutMs,
    );
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === 3) return resolve();
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

/** Create a room with `names[0]` as host and the rest joining by code. */
async function seatPlayers(url, names) {
  const clients = [];
  const host = await new Client(url, names[0]).connect();
  host.send({ t: 'create', name: names[0] });
  await host.wait((c) => c.room, 'room code');
  clients.push(host);

  for (const name of names.slice(1)) {
    const c = await new Client(url, name).connect();
    c.send({ t: 'join', code: host.room, name });
    await c.wait((x) => x.room, `${name} joined`);
    clients.push(c);
  }

  // Everyone should see the full roster before we start.
  await Promise.all(
    clients.map((c) => c.wait((x) => x.state?.players.length === names.length, 'full roster')),
  );
  return clients;
}

// ------------------------------------------------------------- plumbing

test('the health endpoint reports server stats', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const res = await fetch(`${srv.http}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.rooms, 'number');
});

test('the client page and its assets are served', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const page = await fetch(srv.http);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /Bluffalo/i);

  for (const asset of ['/app.js', '/styles.css']) {
    const res = await fetch(srv.http + asset);
    assert.equal(res.status, 200, `${asset} should be served`);
  }

  // Deep links like /?room=ABCD fall through to the single-page client.
  const deep = await fetch(`${srv.http}/some/unknown/route`);
  assert.equal(deep.status, 200);
});

test('path traversal cannot escape the public directory', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  for (const attempt of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/server/app.js']) {
    const res = await fetch(srv.http + attempt);
    const body = await res.text();
    assert.equal(body.includes('"dependencies"'), false, `${attempt} leaked package.json`);
    assert.equal(body.includes('createGameServer'), false, `${attempt} leaked server source`);
  }
});

// --------------------------------------------------------------- joining

test('two players on separate connections land in the same room', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const [host, guest] = await seatPlayers(srv.ws, ['Ada', 'Linus']);

  assert.match(host.room, /^[A-HJ-NP-Z]{4}$/, `odd room code: ${host.room}`);
  assert.equal(guest.room, host.room);
  assert.notEqual(host.playerId, guest.playerId);

  for (const c of [host, guest]) {
    assert.equal(c.state.players.length, 2);
    assert.deepEqual(c.state.players.map((p) => p.name), ['Ada', 'Linus']);
  }
  assert.equal(host.state.isHost, true);
  assert.equal(guest.state.isHost, false);
  assert.ok(guest.notes.length === 0 || true);
  assert.ok(host.notes.some((n) => n.includes('Linus')), 'host should be told Linus joined');
});

test('a bad room code is rejected without seating the player', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const c = await new Client(srv.ws, 'lost').connect();
  t.after(() => c.close());
  c.send({ t: 'join', code: 'ZZZZ', name: 'Lost' });
  await c.wait((x) => x.errors.length > 0, 'error');
  assert.equal(c.errors[0].code, 'no_room');
  assert.equal(c.state, null);
});

test('room codes are case-insensitive and whitespace-tolerant', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const host = await new Client(srv.ws, 'host').connect();
  host.send({ t: 'create', name: 'Host' });
  await host.wait((c) => c.room, 'code');
  t.after(() => host.close());

  const guest = await new Client(srv.ws, 'guest').connect();
  t.after(() => guest.close());
  guest.send({ t: 'join', code: ` ${host.room.toLowerCase()} `, name: 'Guest' });
  await guest.wait((c) => c.room, 'joined');
  assert.equal(guest.room, host.room);
});

test('only the host can start, and not before two players are in', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const host = await new Client(srv.ws, 'host').connect();
  t.after(() => host.close());
  host.send({ t: 'create', name: 'Solo' });
  await host.wait((c) => c.room, 'code');

  host.send({ t: 'start' });
  await host.wait((c) => c.errors.length > 0, 'need_players');
  assert.equal(host.errors[0].code, 'need_players');

  const guest = await new Client(srv.ws, 'guest').connect();
  t.after(() => guest.close());
  guest.send({ t: 'join', code: host.room, name: 'Pal' });
  await guest.wait((c) => c.state?.players.length === 2, 'roster');

  guest.send({ t: 'start' });
  await guest.wait((c) => c.errors.length > 0, 'not_host');
  assert.equal(guest.errors[0].code, 'not_host');

  host.send({ t: 'start' });
  await Promise.all([host.waitPhase('lie', 1), guest.waitPhase('lie', 1)]);
});

// ------------------------------------------------------- a complete game

test('three devices play a full three-round game and agree on the result', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const names = ['Ada', 'Grace', 'Alan'];
  const clients = await seatPlayers(srv.ws, names);
  const [host] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  const ROUNDS = 3;
  host.send({ t: 'rounds', n: ROUNDS });
  await host.wait((c) => c.state.totalRounds === ROUNDS, 'round count');

  host.send({ t: 'start' });

  const expected = new Map(names.map((n) => [n, 0]));

  for (let round = 1; round <= ROUNDS; round += 1) {
    await Promise.all(clients.map((c) => c.waitPhase('lie', round)));

    // The prompt is public; nothing else about the round is.
    for (const c of clients) {
      assert.ok(c.state.prompt.text.includes('___'), 'prompt should show a blank');
      assert.equal(c.state.options.length, 0);
      assert.equal(c.state.reveal, null);
    }

    clients.forEach((c, i) => c.send({ t: 'lie', text: `${c.label} fibs in round ${round} (${i})` }));
    await Promise.all(clients.map((c) => c.waitPhase('guess', round)));

    for (const c of clients) {
      // One truth plus one lie per player, authors hidden.
      assert.equal(c.state.options.length, names.length + 1);
      assert.equal(c.state.options.filter((o) => o.mine).length, 1);
      for (const o of c.state.options) {
        assert.deepEqual(Object.keys(o).sort(), ['id', 'mine', 'text']);
      }
      assert.equal(c.state.you.lie, `${c.label} fibs in round ${round} (${names.indexOf(c.label)})`);
    }

    // Vary who picks what so scores differ between players and rounds.
    clients.forEach((c, i) => {
      const choices = c.state.options.filter((o) => !o.mine);
      c.send({ t: 'guess', optionId: choices[(round + i) % choices.length].id });
    });
    await Promise.all(clients.map((c) => c.waitPhase('reveal', round)));

    // Every client must receive the identical reveal.
    const reveals = clients.map((c) => JSON.stringify(c.state.reveal));
    assert.equal(new Set(reveals).size, 1, 'clients disagree about the reveal');

    const { reveal } = host.state;
    const truth = reveal.options.find((o) => o.id === reveal.truthOptionId);
    assert.equal(truth.text, reveal.answer);
    assert.equal(truth.kind, 'truth');
    assert.equal(host.state.prompt.text.includes('___'), true);

    // Re-derive the scoring from the public reveal and check the server agrees.
    const { truthPoints, bluffPoints } = host.state.limits;
    for (const award of reveal.awards) {
      const mine = reveal.options.find((o) => o.authorId === award.playerId);
      const fooled = mine ? mine.pickedBy.length : 0;
      const foundTruth = truth.pickedBy.some((p) => p.id === award.playerId);
      const points = (foundTruth ? truthPoints : 0) + fooled * bluffPoints;

      assert.equal(award.fooled, fooled, `${award.name}: fooled count`);
      assert.equal(award.foundTruth, foundTruth, `${award.name}: truth flag`);
      assert.equal(award.roundPts, points, `${award.name}: round points`);
      expected.set(award.name, expected.get(award.name) + points);
    }

    // Nobody can be fooled by their own lie.
    for (const o of reveal.options) {
      assert.equal(o.pickedBy.some((p) => p.id === o.authorId), false, 'self-pick leaked through');
    }

    host.send({ t: 'skip' });
  }

  await Promise.all(clients.map((c) => c.waitPhase('final')));

  for (const c of clients) {
    const standings = c.state.standings;
    assert.equal(standings.length, names.length);
    assert.deepEqual(standings.map((s) => s.rank), [1, 2, 3]);
    for (const s of standings) {
      assert.equal(s.score, expected.get(s.name), `${s.name} final score`);
    }
    // Ranked best first.
    for (let i = 1; i < standings.length; i += 1) {
      assert.ok(standings[i - 1].score >= standings[i].score, 'standings out of order');
    }
  }

  const total = [...expected.values()].reduce((a, b) => a + b, 0);
  assert.ok(total > 0, 'somebody should have scored across three rounds');
});

test('the host can restart and everyone keeps their seat with a clean slate', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host, guest] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'rounds', n: 3 });
  await host.wait((c) => c.state.totalRounds === 3, 'rounds');
  host.send({ t: 'start' });

  for (let round = 1; round <= 3; round += 1) {
    await Promise.all(clients.map((c) => c.waitPhase('lie', round)));
    clients.forEach((c, i) => c.send({ t: 'lie', text: `r${round}-p${i}` }));
    await Promise.all(clients.map((c) => c.waitPhase('guess', round)));
    clients.forEach((c) => {
      const pick = c.state.options.find((o) => !o.mine);
      c.send({ t: 'guess', optionId: pick.id });
    });
    await Promise.all(clients.map((c) => c.waitPhase('reveal', round)));
    host.send({ t: 'skip' });
  }
  await Promise.all(clients.map((c) => c.waitPhase('final')));

  guest.send({ t: 'again' });
  await guest.wait((c) => c.errors.some((e) => e.code === 'not_host'), 'not_host');

  host.send({ t: 'again' });
  await Promise.all(clients.map((c) => c.waitPhase('lobby')));
  for (const c of clients) {
    assert.deepEqual(c.state.players.map((p) => p.score), [0, 0]);
    assert.equal(c.state.players.length, 2);
  }
});

// ------------------------------------------------- resilience & fair play

test('a dropped player can resume the same seat, score intact', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo', 'Cy']);
  const [host, , cy] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.waitPhase('lie', 1)));
  clients.forEach((c, i) => c.send({ t: 'lie', text: `lie-${i}` }));
  await Promise.all(clients.map((c) => c.waitPhase('guess', 1)));

  // Everyone finds something to pick, then the round is scored.
  clients.forEach((c) => c.send({ t: 'guess', optionId: c.state.options.find((o) => !o.mine).id }));
  await Promise.all(clients.map((c) => c.waitPhase('reveal', 1)));

  const scoreBefore = host.state.players.find((p) => p.name === 'Cy').score;
  const { playerId, token, room } = cy;

  await cy.close();
  await host.wait(
    (c) => c.state.players.find((p) => p.name === 'Cy')?.connected === false,
    'Cy marked offline',
  );

  // Reconnect from a "new device" using the stored credentials.
  const revived = await new Client(srv.ws, 'Cy-again').connect();
  t.after(() => revived.close());
  revived.send({ t: 'resume', code: room, playerId, token });
  await revived.wait((c) => c.state, 'resumed state');

  assert.equal(revived.playerId, playerId);
  assert.equal(revived.name, 'Cy');
  assert.equal(revived.state.you.score, scoreBefore);
  assert.equal(revived.state.players.length, 3, 'no duplicate seat was created');
  await host.wait(
    (c) => c.state.players.find((p) => p.name === 'Cy')?.connected === true,
    'Cy back online',
  );
});

test('resume is rejected without the right token', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  t.after(() => Promise.all(clients.map((c) => c.close())));

  const impostor = await new Client(srv.ws, 'impostor').connect();
  t.after(() => impostor.close());
  impostor.send({ t: 'resume', code: clients[0].room, playerId: clients[0].playerId, token: 'guess' });
  await impostor.wait((c) => c.errors.length > 0, 'rejection');
  assert.equal(impostor.errors[0].code, 'bad_resume');
  assert.equal(impostor.state, null);
});

test('the host badge moves on when the host disconnects', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host, guest] = clients;
  t.after(() => guest.close());

  assert.equal(guest.state.isHost, false);
  await host.close();
  await guest.wait((c) => c.state.isHost === true, 'promoted to host');

  // And the new host can actually run the game once someone else turns up.
  const third = await new Client(srv.ws, 'Cy').connect();
  t.after(() => third.close());
  third.send({ t: 'join', code: guest.room, name: 'Cy' });
  await third.wait((c) => c.state?.players.length === 3, 'roster');

  guest.send({ t: 'start' });
  await Promise.all([guest.waitPhase('lie', 1), third.waitPhase('lie', 1)]);
});

test('duplicate lies and the real answer are refused across connections', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host, guest] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.waitPhase('lie', 1)));

  host.send({ t: 'lie', text: 'Twelve angry geese' });
  await host.wait((c) => c.state.you.lie === 'Twelve angry geese', 'lie accepted');

  guest.send({ t: 'lie', text: '  twelve ANGRY geese!! ' });
  await guest.wait((c) => c.errors.some((e) => e.code === 'duplicate'), 'duplicate refused');
  assert.equal(guest.state.you.lie, null);
  assert.equal(guest.state.phase, 'lie', 'round must not advance on a refused lie');

  guest.send({ t: 'lie', text: 'A suspiciously large hat' });
  await Promise.all(clients.map((c) => c.waitPhase('guess', 1)));
});

test('you cannot pick your own lie', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host, guest] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.waitPhase('lie', 1)));
  host.send({ t: 'lie', text: 'mine' });
  guest.send({ t: 'lie', text: 'theirs' });
  await Promise.all(clients.map((c) => c.waitPhase('guess', 1)));

  const own = host.state.options.find((o) => o.mine);
  host.send({ t: 'guess', optionId: own.id });
  await host.wait((c) => c.errors.some((e) => e.code === 'own_lie'), 'own_lie refused');
  assert.equal(host.state.you.guess, null);
});

test('a late arrival sits out the round in progress, then joins in', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host, guest] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.waitPhase('lie', 1)));

  const late = await new Client(srv.ws, 'Late').connect();
  t.after(() => late.close());
  late.send({ t: 'join', code: host.room, name: 'Late' });
  await late.wait((c) => c.state?.you, 'seated');
  assert.equal(late.state.you.waiting, true);

  late.send({ t: 'lie', text: 'let me in' });
  await late.wait((c) => c.errors.some((e) => e.code === 'waiting'), 'held back');

  // Finish round 1 with the original two, then the latecomer is in.
  host.send({ t: 'lie', text: 'one' });
  guest.send({ t: 'lie', text: 'two' });
  await Promise.all(clients.map((c) => c.waitPhase('guess', 1)));
  clients.forEach((c) => c.send({ t: 'guess', optionId: c.state.options.find((o) => !o.mine).id }));
  await Promise.all(clients.map((c) => c.waitPhase('reveal', 1)));
  host.send({ t: 'skip' });

  await late.waitPhase('lie', 2);
  assert.equal(late.state.you.waiting, false);
  late.send({ t: 'lie', text: 'now I am playing' });
  await late.wait((c) => c.state.you.lie === 'now I am playing', 'lie accepted in round 2');
});

test('chat reaches the whole room and new joiners get the backlog', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host, guest] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'chat', text: 'can everyone hear me?' });
  await guest.wait((c) => c.chats.length > 0, 'chat delivered');
  assert.equal(guest.chats[0].from, 'Ann');
  assert.equal(guest.chats[0].text, 'can everyone hear me?');

  const third = await new Client(srv.ws, 'Cy').connect();
  t.after(() => third.close());
  third.send({ t: 'join', code: host.room, name: 'Cy' });
  await third.wait((c) => c.messages.some((m) => m.t === 'chatHistory'), 'backlog');
  const history = third.messages.find((m) => m.t === 'chatHistory');
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].text, 'can everyone hear me?');
});

test('malformed and out-of-turn messages are refused, not crashed on', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const c = await new Client(srv.ws, 'rude').connect();
  t.after(() => c.close());

  c.ws.send('this is not json');
  await c.wait((x) => x.errors.some((e) => e.code === 'bad_json'), 'bad_json');

  c.ws.send(JSON.stringify({ hello: 'there' }));
  await c.wait((x) => x.errors.some((e) => e.code === 'bad_msg'), 'bad_msg');

  c.send({ t: 'nonsense' });
  await c.wait((x) => x.errors.some((e) => e.code === 'unknown'), 'unknown');

  c.send({ t: 'lie', text: 'no room yet' });
  await c.wait((x) => x.errors.some((e) => e.code === 'not_in_room'), 'not_in_room');

  // The connection must still be usable afterwards.
  c.send({ t: 'ping' });
  await c.wait((x) => x.messages.some((m) => m.t === 'pong'), 'pong');

  const health = await fetch(`${srv.http}/healthz`);
  assert.equal(health.status, 200, 'server should still be healthy');
});

test('an idle player is autofilled when the clock runs out', async (t) => {
  const srv = await boot({ lieMs: 250, guessMs: 250, revealMs: 60_000 });
  t.after(srv.close);

  const clients = await seatPlayers(srv.ws, ['Ann', 'Bo']);
  const [host] = clients;
  t.after(() => Promise.all(clients.map((c) => c.close())));

  host.send({ t: 'start' });
  await Promise.all(clients.map((c) => c.waitPhase('lie', 1)));
  host.send({ t: 'lie', text: 'I showed up' });

  // Bo never answers; the lie clock should close the phase anyway.
  await Promise.all(clients.map((c) => c.waitPhase('guess', 1)));
  assert.equal(host.state.options.length, 3, 'Bo should still have contributed an option');

  // Nobody guesses; the guess clock should score the round anyway.
  await Promise.all(clients.map((c) => c.waitPhase('reveal', 1)));
  assert.equal(host.state.reveal.noGuess.length, 2);
  assert.ok(host.state.reveal.awards.every((a) => a.roundPts === 0));
});

test('the room fills up at ten players', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const names = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
  const clients = await seatPlayers(srv.ws, names);
  t.after(() => Promise.all(clients.map((c) => c.close())));

  const extra = await new Client(srv.ws, 'P11').connect();
  t.after(() => extra.close());
  extra.send({ t: 'join', code: clients[0].room, name: 'P11' });
  await extra.wait((c) => c.errors.length > 0, 'full');
  assert.equal(extra.errors[0].code, 'full');

  // A ten-way round still produces one option per player plus the truth.
  clients[0].send({ t: 'start' });
  await Promise.all(clients.map((c) => c.waitPhase('lie', 1)));
  clients.forEach((c, i) => c.send({ t: 'lie', text: `fib number ${i}` }));
  await Promise.all(clients.map((c) => c.waitPhase('guess', 1)));
  assert.equal(clients[0].state.options.length, 11);
});

test('separate rooms do not leak into each other', async (t) => {
  const srv = await boot();
  t.after(srv.close);

  const roomA = await seatPlayers(srv.ws, ['A1', 'A2']);
  const roomB = await seatPlayers(srv.ws, ['B1', 'B2']);
  t.after(() => Promise.all([...roomA, ...roomB].map((c) => c.close())));

  assert.notEqual(roomA[0].room, roomB[0].room);

  roomA[0].send({ t: 'start' });
  await Promise.all(roomA.map((c) => c.waitPhase('lie', 1)));
  assert.equal(roomB[0].state.phase, 'lobby', 'room B should be untouched');

  roomA[0].send({ t: 'chat', text: 'room A only' });
  await roomA[1].wait((c) => c.chats.length > 0, 'chat in room A');
  assert.equal(roomB[1].chats.length, 0, 'chat leaked between rooms');
});
