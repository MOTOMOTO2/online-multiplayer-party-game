# 🐃 Bluffalo

A real-time, cross-device multiplayer bluffing party game. Everyone gets the same
statement with a word missing. You invent a convincing fake answer, then try to
pick the real one out of the pile of everyone else's lies.

**▶ Play now: <https://bluffalo-party.fly.dev>**

No install, no accounts, no app. Open the link on a phone or a laptop, tap
**Start a new game**, and share the 4-letter room code (or the invite link) with
anyone, anywhere. 2–10 players.

![Bluffalo](https://img.shields.io/badge/players-2--10-ffd166) ![Node](https://img.shields.io/badge/node-%E2%89%A520-06d6a0)

---

## The rules

The rules are printed on the home page, so a new player can learn the game
without anyone explaining it.

1. **Everyone sees the same statement** with one word missing —
   _"A group of flamingos is called a \_\_\_."_
2. **Make up an answer.** You're trying to write a lie that sounds like the
   truth. Type the real answer by accident and the game tells you to try again;
   duplicate someone else's lie and you're asked for another.
3. **Then spot the truth.** All the lies get shuffled in with the real answer.
   Pick the one you think is true — you can't pick your own lie.
4. **Watch the reveal.** The round results spell out the real answer and ring
   the option you picked: green when you found the truth, red when you fell for
   someone's lie. Every answer shows who wrote it and who it fooled.
5. **Score.** `+1000` for finding the truth, `+500` for every player who falls
   for your lie.
6. **Highest score after the last round wins.** Run out of time and a feeble
   answer gets picked for you, so don't dawdle.

The host picks 3, 5 or 8 rounds and starts the game once at least two players
have joined.

---

## Running it locally

Requires Node.js ≥ 20. There is no build step and one runtime dependency (`ws`).

```bash
npm install
npm start           # http://localhost:8080
```

Then open the page in two browser windows — or, to play across real devices on
your network, find your machine's LAN IP and open `http://<that-ip>:8080` on your
phone.

```bash
PORT=3000 npm start   # pick a different port
```

## Testing

```bash
npm test              # 57 tests, ~7s, no network or browser needed
```

- **`test/game.test.js`** — the rules engine: scoring, phase transitions,
  duplicate/truth lie rejection, late joiners, host migration, prompt recycling,
  and the redaction guarantees (the answer must not reach a client early).
- **`test/e2e.test.js`** — boots a real HTTP+WebSocket server on an ephemeral
  port and drives **real WebSocket clients** through complete games: joining by
  code from independent connections, a full 3-round game where every client's
  scoreboard is re-derived from the public reveal and checked, reconnection,
  host migration, a 10-player room, room isolation, and malformed input.
- **`test/prompts.test.js`** — validates the prompt bank's shape and checks no
  fallback answer collides with a real one.

Two further scripts check a *running* instance, local or deployed:

```bash
npm run smoke -- https://bluffalo-party.fly.dev          # protocol-level, no deps
npm run browser-check -- https://bluffalo-party.fly.dev  # drives two real Chrome profiles
```

`browser-check` launches two separate browser instances (separate profiles, so
separate `localStorage` — a faithful stand-in for two devices), plays a complete
game through the actual UI, reloads one of them to prove reconnection works, and
fails on any console error. Set `SHOTS=1` to save screenshots to `.screenshots/`.
It needs a local Chrome or Edge; override discovery with `CHROME_PATH`.

---

## How it fits together

```
server/
  index.js        entry point: port, signals
  app.js          HTTP + WebSocket server, message routing, rate limiting
  lib/game.js     the rules engine — pure logic, injected clock, no I/O
  lib/rooms.js    rooms: sockets, reconnect tokens, chat, the tick loop
  lib/prompts.js  the prompt bank (~90 prompts) and fallback lies
  lib/static.js   static file serving for public/
  lib/text.js     normalisation + sanitising for untrusted strings
public/           the client: index.html, app.js, styles.css — no build step
test/             node:test suites
scripts/          smoke.js and browser-check.js
```

**The server is the only source of truth.** Clients send intents (`lie`,
`guess`, `start`) and receive a *redacted* snapshot of the game. `Game.viewFor()`
is the security boundary: during the lie phase neither the answer nor anyone
else's lie is in the payload at all, and during the guess phase the options
carry only `{id, text, mine}` — no author, no truth flag. Option ids are
assigned *after* shuffling (`o0`, `o1`, …), so a player reading the WebSocket
frames in devtools still can't tell which answer is real.

**The engine is pure.** `lib/game.js` takes its clock as a parameter and
advances only when `tick()` is called, so every deadline-driven rule is tested
instantly instead of by waiting a minute.

**No build step, deliberately.** The client is plain ES modules, so what runs in
the browser is exactly what's in the repo. All user-authored text (names, lies,
chat) goes into the DOM via `textContent`, never `innerHTML`.

---

## Deployment

Live on [Fly.io](https://fly.io) at <https://bluffalo-party.fly.dev>:

```bash
flyctl deploy --remote-only   # or: npm run deploy
```

`--remote-only` builds the image on Fly's builder, so Docker isn't needed
locally. The `Dockerfile` is a plain `node:22-alpine` image (~54 MB).

> ⚠️ **This app must run exactly one machine.** Rooms live in the memory of a
> single process. Fly creates a second machine for high-availability by default
> — that scatters players across processes, so a friend entering a valid room
> code lands on the wrong machine and is told the room doesn't exist. After the
> first deploy, run `flyctl scale count 1`. Surviving more than one machine
> would mean moving room state into Redis or pinning rooms to a machine by
> code; that's deliberately out of scope here.

`auto_stop_machines` is off for the same reason: a suspended machine would drop
every live room, and the shared URL would look broken to whoever clicks it
first. To cut idle cost instead, set `min_machines_running = 0` and accept that
rooms don't survive an idle period.

Any host that runs a Node process and allows WebSockets works just as well —
Railway, Render, a VPS. The only requirements are a single process and `PORT`.

---

## Decisions and assumptions

The brief left these open; these are the conventional choices made:

- **Game type.** A "spot the real answer among the fakes" bluffing game — it
  needs no shared physical space, works from 2 players up, is readable on a
  phone, and its rules fit in five lines.
- **Rooms are ephemeral and in-memory.** A party game doesn't need to outlive
  the party, so there's no database. Empty rooms are reaped 15 minutes after the
  last player disconnects.
- **Identity is a name you type**, kept in `localStorage` with a per-room
  reconnect token. No accounts, no email, no tracking.
- **Reconnection over elimination.** Closing a tab or losing signal keeps your
  seat and your score; refresh and you're back in the same game. Disconnected
  players stop blocking the round rather than stalling it.
- **Mid-round joiners sit out** until the next round, so nobody is scored on a
  prompt they never saw.
- **The host can skip a phase**, and the host badge moves to the
  longest-standing connected player if the host vanishes — so a game can't be
  held hostage by someone who walked away.
- **Prompt facts are a static bank** in `server/lib/prompts.js` with no external
  API. Adding prompts is appending to one array.

### Known limitations

- Single process, so a room is limited to one machine (see above).
- Scores reset when the server restarts; there are no persistent profiles or
  leaderboards.
- Prompts are English-only.
- Nothing stops two people in the same physical room from looking at each
  other's screens. That part is on you.

## License

MIT
