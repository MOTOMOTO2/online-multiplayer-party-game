#!/usr/bin/env node
/**
 * Smoke test against a running Bluffalo instance - local or deployed.
 *
 *   node scripts/smoke.js https://your-app.fly.dev
 *   node scripts/smoke.js                 # defaults to http://127.0.0.1:8080
 *
 * Opens two independent WebSocket connections (standing in for two devices),
 * creates a room, joins it with the code, plays a complete 3-round game and
 * checks the final scoreboard. Exits non-zero on any failure.
 *
 * Uses Node's built-in global WebSocket, so it needs no dependencies.
 */

import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const wsBase = base.replace(/^http/, 'ws') + '/ws';
const ROUNDS = 3;
const TIMEOUT = 15_000;

const log = (...args) => console.log(...args);

class Peer {
  constructor(label) {
    this.label = label;
    this.state = null;
    this.errors = [];
    this.messages = [];
    this.waiters = new Set();
  }

  async connect() {
    this.ws = new WebSocket(wsBase);
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      this.messages.push(msg);
      if (msg.t === 'state') this.state = msg.state;
      if (msg.t === 'joined') Object.assign(this, { room: msg.room, playerId: msg.playerId });
      if (msg.t === 'error') this.errors.push(msg);
      for (const w of [...this.waiters]) w();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: connect timed out`)), TIMEOUT);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`${this.label}: could not open a WebSocket to ${wsBase}`));
      });
    });
    return this;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  wait(predicate, label) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this)) return;
        done();
        resolve(this);
      };
      const timer = setTimeout(() => {
        done();
        reject(
          new Error(
            `${this.label}: timed out waiting for ${label} ` +
              `(phase=${this.state?.phase} round=${this.state?.round} errors=${JSON.stringify(this.errors)})`,
          ),
        );
      }, TIMEOUT);
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  phase(phase, round) {
    return this.wait(
      (p) => p.state?.phase === phase && (round === undefined || p.state.round === round),
      `phase ${phase}${round ? ` round ${round}` : ''}`,
    );
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  log(`Smoke-testing ${base}`);

  // 1. HTTP surface --------------------------------------------------------
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200, '/healthz should return 200');
  const stats = await health.json();
  assert.equal(stats.ok, true);
  log(`  health ok (rooms=${stats.rooms} connections=${stats.connections})`);

  const page = await fetch(base);
  assert.equal(page.status, 200, 'the home page should return 200');
  const html = await page.text();
  assert.ok(/Bluffalo/i.test(html), 'the home page should mention Bluffalo');
  assert.ok(/How to play/i.test(html), 'the home page should carry the rules');
  log('  home page ok (rules present)');

  // 2. Two devices join one room ------------------------------------------
  const host = await new Peer('host').connect();
  const guest = await new Peer('guest').connect();

  host.send({ t: 'create', name: 'SmokeHost' });
  await host.wait((p) => p.room, 'a room code');
  log(`  room created: ${host.room}`);

  guest.send({ t: 'join', code: host.room, name: 'SmokeGuest' });
  await guest.wait((p) => p.room, 'join confirmation');
  assert.equal(guest.room, host.room);

  const peers = [host, guest];
  await Promise.all(peers.map((p) => p.wait((x) => x.state?.players.length === 2, 'full roster')));
  log('  two independent connections are in the same room');

  // 3. Play a full game ----------------------------------------------------
  host.send({ t: 'rounds', n: ROUNDS });
  await host.wait((p) => p.state.totalRounds === ROUNDS, 'round count');
  host.send({ t: 'start' });

  for (let round = 1; round <= ROUNDS; round += 1) {
    await Promise.all(peers.map((p) => p.phase('lie', round)));
    assert.ok(host.state.prompt.text.includes('___'), 'the prompt should have a blank');

    peers.forEach((p, i) => p.send({ t: 'lie', text: `${p.label} round ${round} fib ${i}` }));
    await Promise.all(peers.map((p) => p.phase('guess', round)));
    assert.equal(host.state.options.length, 3, 'two lies plus the truth');

    peers.forEach((p, i) => {
      const choices = p.state.options.filter((o) => !o.mine);
      p.send({ t: 'guess', optionId: choices[(round + i) % choices.length].id });
    });
    await Promise.all(peers.map((p) => p.phase('reveal', round)));

    const { reveal } = host.state;
    const truth = reveal.options.find((o) => o.id === reveal.truthOptionId);
    assert.equal(truth.text, reveal.answer, 'the reveal should name the real answer');
    assert.equal(
      JSON.stringify(host.state.reveal),
      JSON.stringify(guest.state.reveal),
      'both devices should see the same reveal',
    );
    log(`  round ${round}: truth was "${reveal.answer}" - both devices agree`);

    host.send({ t: 'skip' });
  }

  await Promise.all(peers.map((p) => p.phase('final')));
  const standings = host.state.standings;
  assert.equal(standings.length, 2);
  assert.deepEqual(standings.map((s) => s.rank), [1, 2]);
  assert.ok(standings[0].score >= standings[1].score, 'standings should be ranked');
  log(`  final: ${standings.map((s) => `#${s.rank} ${s.name} ${s.score}`).join(', ')}`);

  assert.deepEqual(host.errors, [], 'the host hit no protocol errors');
  assert.deepEqual(guest.errors, [], 'the guest hit no protocol errors');

  peers.forEach((p) => {
    p.send({ t: 'leave' });
    p.close();
  });

  log('\nPASS - a full two-device game completed against this host.');
}

main().catch((error) => {
  console.error(`\nFAIL - ${error.message}`);
  process.exit(1);
});
