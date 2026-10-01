/**
 * Bluffalo client.
 *
 * Plain ES modules, no build step. The server is the only source of truth: the
 * client sends intents, receives a redacted snapshot of the game, and draws it.
 *
 * All user-authored text (names, lies, chat) is inserted with textContent via
 * the `el` helper below - never innerHTML.
 */

const SESSION_KEY = 'bluffalo.session.v1';
const NAME_KEY = 'bluffalo.name.v1';
const PING_MS = 25_000;

// ------------------------------------------------------------------- utils

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder. `text` and string children always go in as text. */
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const replaceChildren = (parent, ...kids) => {
  parent.replaceChildren();
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) parent.append(kid);
};

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function saveJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing - the game still works, it just won't resume */
  }
}

// ------------------------------------------------------------------- state

let sock = null;
let state = null;
let stateAt = 0;
let session = loadJson(SESSION_KEY);
let currentRoom = session?.room ?? null;
let chatEntries = [];
let stageSignature = null;
let phaseText = '';
let draft = '';
let reconnectAttempts = 0;
let closing = false;
let pingTimer = null;
const stageRefs = { waiting: null, error: null, submit: null };

// ------------------------------------------------------------------ banner

let bannerTimer = null;
function banner(text, { sticky = false } = {}) {
  const node = $('#banner');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(() => (node.hidden = true), 2600);
}

const hideBanner = () => {
  clearTimeout(bannerTimer);
  $('#banner').hidden = true;
};

// ---------------------------------------------------------------- transport

const wsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function send(msg) {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function connect(onOpen) {
  closing = false;
  sock = new WebSocket(wsUrl());

  sock.onopen = () => {
    reconnectAttempts = 0;
    hideBanner();
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping' }), PING_MS);
    onOpen?.();
  };

  sock.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    receive(msg);
  };

  sock.onclose = () => {
    clearInterval(pingTimer);
    if (closing) return;
    reconnectAttempts += 1;
    const delay = Math.min(8000, 400 * 2 ** (reconnectAttempts - 1));
    banner('Connection lost — reconnecting…', { sticky: true });
    setTimeout(() => {
      connect(() => {
        if (session) send({ t: 'resume', ...session });
      });
    }, delay);
  };

  sock.onerror = () => {
    /* onclose does the recovery work */
  };
}

function receive(msg) {
  switch (msg.t) {
    case 'joined':
      session = { code: msg.room, playerId: msg.playerId, token: msg.token };
      currentRoom = msg.room;
      saveJson(SESSION_KEY, session);
      showScreen('game');
      if (msg.waiting) banner("You're in — you'll join the scoring next round");
      break;

    case 'state':
      currentRoom = msg.room ?? currentRoom;
      state = msg.state;
      stateAt = performance.now();
      showScreen('game');
      render();
      break;

    case 'error':
      handleError(msg);
      break;

    case 'note':
      pushChat({ system: true, text: msg.text });
      break;

    case 'chat':
      pushChat(msg.entry);
      break;

    case 'chatHistory':
      chatEntries = (msg.entries ?? []).map((e) => ({ ...e }));
      renderChat();
      break;

    case 'left':
      session = null;
      saveJson(SESSION_KEY, null);
      state = null;
      showScreen('home');
      break;

    case 'replaced':
      closing = true;
      banner('This game was opened somewhere else', { sticky: true });
      break;

    default:
      break;
  }
}

function handleError(msg) {
  // Failing to resume means the room is gone or the token is stale: fall back
  // to the home screen rather than looping on a dead session.
  if (msg.code === 'no_room' || msg.code === 'bad_resume') {
    const wasResuming = Boolean(session) && !state;
    session = null;
    saveJson(SESSION_KEY, null);
    if (wasResuming) {
      showScreen('home');
      showHomeError('That game has finished or expired. Start a new one!');
      return;
    }
  }

  if (!state) {
    showHomeError(msg.message ?? 'Something went wrong.');
    setBusy(false);
    return;
  }

  if (stageRefs.error) {
    stageRefs.error.textContent = msg.message ?? 'That did not work.';
    stageRefs.error.hidden = false;
  } else {
    banner(msg.message ?? 'That did not work.');
  }
  if (stageRefs.submit) stageRefs.submit.disabled = false;
}

// ------------------------------------------------------------------ screens

function showScreen(which) {
  $('#screen-home').hidden = which !== 'home';
  $('#screen-game').hidden = which === 'home';
}

function showHomeError(text) {
  const node = $('#home-error');
  node.textContent = text;
  node.hidden = !text;
}

function setBusy(busy) {
  $('#create-btn').disabled = busy;
  $('#join-btn').disabled = busy;
}

// -------------------------------------------------------------------- chat

function pushChat(entry) {
  chatEntries.push(entry);
  if (chatEntries.length > 80) chatEntries.shift();
  renderChat();
}

function renderChat() {
  const log = $('#chat-log');
  if (!log) return;
  replaceChildren(
    log,
    chatEntries.map((e) =>
      e.system
        ? el('li', { class: 'system', text: e.text })
        : el('li', {}, el('span', { class: 'chat-from', text: `${e.from}: ` }), e.text),
    ),
  );
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------------ drawing

/** Turn "A group of flamingos is called a ___." into a styled sentence. */
function promptNode(text, answer) {
  const idx = text.indexOf('___');
  if (idx === -1) return el('p', { class: 'prompt', text });
  return el(
    'p',
    { class: 'prompt' },
    text.slice(0, idx),
    el('span', { class: 'blank', text: answer ?? '?' }),
    text.slice(idx + 3),
  );
}

const PHASE_TEXT = {
  lobby: 'Waiting to start',
  lie: 'Write your lie',
  guess: 'Spot the truth',
  reveal: 'The results',
  final: 'Game over',
};

function render() {
  if (!state) return;

  $('#room-code').textContent = currentRoom ?? '————';
  $('#round-label').textContent =
    state.phase === 'lobby'
      ? 'Lobby'
      : state.phase === 'final'
        ? 'Final'
        : `Round ${state.round} of ${state.totalRounds}`;

  phaseText = PHASE_TEXT[state.phase] ?? '';
  if (state.phase === 'lie' && state.you?.lie) phaseText = 'Lie locked in';
  if (state.phase === 'guess' && state.you?.guess) phaseText = 'Answer locked in';
  if (state.you?.waiting) phaseText = 'Sitting out this round';
  $('#phase-label').textContent = phaseText;

  renderRoster();
  renderStage();
  updateWaitingLine();
  tickTimer();
}

function renderRoster() {
  const list = $('#roster');
  const playing = state.phase === 'lie' || state.phase === 'guess';

  replaceChildren(
    list,
    state.players.map((p) =>
      el(
        'li',
        { class: p.connected ? '' : 'offline' },
        el('span', {
          class: `dot ${!p.connected ? 'offline' : playing && p.acted ? 'done' : ''}`,
          title: !p.connected ? 'offline' : playing && p.acted ? 'ready' : 'thinking',
        }),
        el('span', {
          class: `roster-name ${p.id === state.youId ? 'you' : ''}`,
          text: p.name,
        }),
        p.isHost ? el('span', { class: 'tag-host', text: 'HOST' }) : null,
        p.waiting ? el('span', { class: 'tag-wait', text: 'NEXT' }) : null,
        el('span', { class: 'roster-score', text: String(p.score) }),
      ),
    ),
  );

  const connected = state.players.filter((p) => p.connected).length;
  const hint = $('#host-hint');
  if (state.phase === 'lobby') {
    hint.textContent = state.isHost
      ? connected < state.limits.minPlayers
        ? `Waiting for ${state.limits.minPlayers - connected} more player(s)…`
        : "You're the host — start when everyone's in."
      : 'Waiting for the host to start the game.';
  } else {
    hint.textContent = '';
  }
}

/**
 * Rebuild the stage only when its inputs change, so typing a lie is never
 * interrupted by somebody else's state update.
 */
function renderStage() {
  const sig = stageSig();
  if (sig === stageSignature) return;
  stageSignature = sig;
  stageRefs.waiting = null;
  stageRefs.error = null;
  stageRefs.submit = null;

  const stage = $('#stage');
  const builders = {
    lobby: lobbyStage,
    lie: lieStage,
    guess: guessStage,
    reveal: revealStage,
    final: finalStage,
  };
  replaceChildren(stage, (builders[state.phase] ?? (() => []))());
}

function stageSig() {
  const s = state;
  switch (s.phase) {
    case 'lobby':
      return `lobby|${s.players.length}|${s.totalRounds}|${s.isHost}|${
        s.players.filter((p) => p.connected).length
      }`;
    case 'lie':
      return `lie|${s.round}|${s.you?.lie ?? ''}|${s.you?.waiting}|${s.isHost}`;
    case 'guess':
      return `guess|${s.round}|${s.you?.guess ?? ''}|${s.you?.waiting}|${s.isHost}|${s.options
        .map((o) => o.id)
        .join(',')}`;
    case 'reveal':
      return `reveal|${s.round}|${s.isHost}`;
    case 'final':
      return `final|${s.isHost}|${s.standings.map((x) => `${x.id}:${x.score}`).join(',')}`;
    default:
      return s.phase;
  }
}

function inviteUrl() {
  return `${location.origin}/?room=${currentRoom ?? ''}`;
}

function lobbyStage() {
  const connected = state.players.filter((p) => p.connected).length;
  const canStart = connected >= state.limits.minPlayers;

  return [
    el(
      'section',
      { class: 'card' },
      el('h2', { text: 'Invite your friends' }),
      el(
        'div',
        { class: 'invite' },
        el('div', { class: 'invite-code', text: currentRoom ?? '————' }),
        el('div', { class: 'invite-url', text: inviteUrl() }),
      ),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn btn-secondary', onclick: copyInvite }, 'Copy invite link'),
      ),
      el('p', {
        class: 'hint',
        text: `Anyone on any device can join at that link, or by typing ${
          currentRoom ?? 'the code'
        } on the home page. ${state.limits.minPlayers}–${state.limits.maxPlayers} players.`,
      }),
    ),

    el(
      'section',
      { class: 'card' },
      el('h2', { text: 'Rounds' }),
      el(
        'div',
        { class: 'rounds-picker' },
        state.limits.allowedRounds.map((n) =>
          el('button', {
            class: `btn ${n === state.totalRounds ? 'active' : ''}`,
            text: String(n),
            disabled: !state.isHost,
            onclick: () => send({ t: 'rounds', n }),
          }),
        ),
      ),
      state.isHost
        ? el(
            'button',
            {
              class: 'btn btn-primary btn-block',
              disabled: !canStart,
              onclick: () => send({ t: 'start' }),
            },
            canStart ? 'Start the game' : `Need ${state.limits.minPlayers} players to start`,
          )
        : el('p', { class: 'hint', text: 'The host chooses the length and starts the game.' }),
      errorNode(),
    ),

    rulesRecap(),
  ];
}

function rulesRecap() {
  const { truthPoints, bluffPoints } = state.limits;
  return el(
    'section',
    { class: 'card' },
    el('h2', { text: 'Quick reminder' }),
    el(
      'ol',
      { class: 'rules-list' },
      el('li', {}, 'Everyone gets the same statement with a missing word.'),
      el('li', {}, 'Invent an answer that sounds true.'),
      el('li', {}, "Then pick the real answer out of everyone's lies."),
      el(
        'li',
        {},
        el('span', { class: 'pill pill-truth', text: `+${truthPoints}` }),
        ' for finding the truth, ',
        el('span', { class: 'pill pill-bluff', text: `+${bluffPoints}` }),
        ' each time someone falls for your lie.',
      ),
    ),
  );
}

function errorNode() {
  stageRefs.error = el('p', { class: 'error', hidden: true, role: 'alert' });
  return stageRefs.error;
}

function waitingNode() {
  stageRefs.waiting = el('p', { class: 'waiting', 'aria-live': 'polite' });
  return stageRefs.waiting;
}

function updateWaitingLine() {
  if (!stageRefs.waiting || !state) return;
  const names = state.waitingOn ?? [];
  stageRefs.waiting.textContent = names.length
    ? `Still waiting on: ${names.join(', ')}`
    : 'Everyone is in…';
}

function lieStage() {
  const prompt = promptNode(state.prompt?.text ?? '');

  if (state.you?.waiting) {
    return [
      el(
        'section',
        { class: 'card' },
        el('h2', { text: 'Next round is yours' }),
        prompt,
        el('p', {
          class: 'hint',
          text: 'You arrived mid-round, so you sit this one out. You will be dealt in automatically for the next round.',
        }),
        waitingNode(),
      ),
    ];
  }

  if (state.you?.lie) {
    return [
      el(
        'section',
        { class: 'card' },
        el('h2', { text: 'Lie submitted' }),
        prompt,
        el(
          'div',
          { class: 'locked' },
          el('span', { class: 'locked-label', text: 'Your lie' }),
          el('span', { class: 'locked-value', text: state.you.lie }),
        ),
        waitingNode(),
        hostSkip('Skip the wait'),
      ),
    ];
  }

  const input = el('textarea', {
    id: 'lie-input',
    maxlength: state.limits.maxLieLen,
    placeholder: 'Something believable…',
    rows: 2,
    'aria-label': 'Your lie',
  });
  input.value = draft;

  const counter = el('p', {
    class: 'charcount',
    text: `${draft.length}/${state.limits.maxLieLen}`,
  });
  input.addEventListener('input', () => {
    draft = input.value;
    counter.textContent = `${input.value.length}/${state.limits.maxLieLen}`;
  });

  const submit = el('button', { class: 'btn btn-primary btn-block', text: 'Lock in my lie' });
  stageRefs.submit = submit;

  const submitLie = () => {
    const text = input.value.trim();
    if (!text) {
      stageRefs.error.textContent = 'Type something first!';
      stageRefs.error.hidden = false;
      return;
    }
    submit.disabled = true;
    send({ t: 'lie', text });
  };

  submit.addEventListener('click', submitLie);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitLie();
    }
  });

  // Autofocus on desktop only: pulling up a phone keyboard hides the prompt.
  if (window.matchMedia('(min-width: 900px)').matches) setTimeout(() => input.focus(), 0);

  return [
    el(
      'section',
      { class: 'card lie-form' },
      el('h2', { text: 'Fill in the blank — with a lie' }),
      prompt,
      el('p', {
        class: 'hint',
        text: 'Write a fake answer that others might believe. Type the real answer by accident and we will make you try again.',
      }),
      input,
      counter,
      submit,
      errorNode(),
      waitingNode(),
    ),
  ];
}

function guessStage() {
  const prompt = promptNode(state.prompt?.text ?? '');

  if (state.you?.waiting) {
    return [
      el(
        'section',
        { class: 'card' },
        el('h2', { text: 'Watching this round' }),
        prompt,
        el('p', { class: 'hint', text: 'You join the scoring next round.' }),
        waitingNode(),
      ),
    ];
  }

  const chosen = state.you?.guess ?? null;

  const options = state.options.map((o) =>
    el(
      'li',
      {},
      el(
        'button',
        {
          class: `option ${o.mine ? 'is-mine' : ''} ${chosen === o.id ? 'chosen' : ''}`,
          disabled: o.mine || Boolean(chosen),
          onclick: () => {
            if (o.mine || chosen) return;
            send({ t: 'guess', optionId: o.id });
          },
        },
        el('span', { class: 'option-text', text: o.text }),
        o.mine ? el('span', { class: 'option-tag', text: 'your lie' }) : null,
        chosen === o.id ? el('span', { class: 'option-tag', text: 'picked' }) : null,
      ),
    ),
  );

  return [
    el(
      'section',
      { class: 'card' },
      el('h2', { text: chosen ? 'Locked in' : 'Which one is true?' }),
      prompt,
      el('p', {
        class: 'hint',
        text: chosen
          ? 'Sit tight while everyone else decides.'
          : "One of these is the real answer. The rest are lies from the other players - and you can't pick your own.",
      }),
      el('ul', { class: 'options' }, options),
      errorNode(),
      waitingNode(),
      hostSkip('Skip the wait'),
    ),
  ];
}

function revealStage() {
  const { reveal } = state;
  const mine = reveal.awards.find((a) => a.playerId === state.youId);

  const options = reveal.options.map((o) => {
    const isTruth = o.id === reveal.truthOptionId;
    const pickers = o.pickedBy.map((p) => p.name).join(', ');
    return el(
      'li',
      {},
      el(
        'div',
        { class: `option ${isTruth ? 'is-truth' : ''}` },
        el(
          'span',
          { class: 'option-text' },
          el('span', { text: o.text }),
          el('span', {
            class: 'option-meta',
            text: isTruth
              ? pickers
                ? `The truth! Found by ${pickers}`
                : 'The truth — nobody found it!'
              : `${o.auto ? 'Auto-filled for ' : 'Lie by '}${o.authorName}${
                  pickers ? ` · fooled ${pickers}` : ' · fooled nobody'
                }`,
          }),
        ),
        isTruth ? el('span', { class: 'option-tag truth', text: 'TRUTH' }) : null,
      ),
    );
  });

  const scores = reveal.awards.map((a) =>
    el(
      'div',
      { class: 'scoreline' },
      el(
        'span',
        {},
        el('strong', { text: a.name }),
        el('span', {
          class: 'option-meta',
          text: [
            a.foundTruth ? 'found the truth' : 'missed the truth',
            a.fooled ? `fooled ${a.fooled} player${a.fooled === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
      ),
      el('span', {
        class: `scoreline-pts ${a.roundPts === 0 ? 'zero' : ''}`,
        text: `+${a.roundPts}`,
      }),
    ),
  );

  return [
    el(
      'section',
      { class: 'card' },
      el('h2', { text: `Round ${state.round} results` }),
      promptNode(state.prompt?.text ?? '', reveal.answer),
      mine
        ? el('p', {
            class: 'hint',
            text: mine.roundPts
              ? `You scored ${mine.roundPts} this round.`
              : 'No points this round — get them next time.',
          })
        : null,
      el('ul', { class: 'options' }, options),
    ),
    el('section', { class: 'card' }, el('h2', { text: 'Round scores' }), scores),
    hostSkip(state.round >= state.totalRounds ? 'See the final scores' : 'Next round', true),
  ];
}

function finalStage() {
  const winners = state.standings.filter((s) => s.score === state.standings[0].score);
  const youWon = winners.some((w) => w.id === state.youId);

  return [
    el(
      'section',
      { class: 'card' },
      el('p', {
        class: 'winner-banner',
        text: youWon
          ? '🏆 You win!'
          : winners.length > 1
            ? `🏆 It's a tie: ${winners.map((w) => w.name).join(' & ')}`
            : `🏆 ${winners[0]?.name ?? 'Nobody'} wins!`,
      }),
      el(
        'ul',
        { class: 'podium' },
        state.standings.map((s) =>
          el(
            'li',
            { class: s.rank === 1 ? 'first' : '' },
            el('span', { class: 'podium-rank', text: `#${s.rank}` }),
            el('span', { class: 'podium-name', text: s.name }),
            el('span', { class: 'podium-score', text: String(s.score) }),
          ),
        ),
      ),
      state.isHost
        ? el('button', {
            class: 'btn btn-primary btn-block',
            text: 'Play again',
            onclick: () => send({ t: 'again' }),
          })
        : el('p', { class: 'hint', text: 'The host can start another game.' }),
      errorNode(),
    ),
  ];
}

function hostSkip(label, primary = false) {
  if (!state.isHost) return null;
  return el('button', {
    class: `btn ${primary ? 'btn-primary' : 'btn-ghost'} btn-block`,
    text: label,
    onclick: () => send({ t: 'skip' }),
  });
}

// ------------------------------------------------------------------- timer

function tickTimer() {
  const fill = $('#timer-fill');
  if (!state || state.deadlineIn == null || !state.phaseMs) {
    fill.style.width = '0%';
    return;
  }
  const remaining = Math.max(0, state.deadlineIn - (performance.now() - stateAt));
  fill.style.width = `${Math.min(100, (remaining / state.phaseMs) * 100)}%`;
  fill.classList.toggle('urgent', remaining <= 10_000);

  const seconds = Math.ceil(remaining / 1000);
  $('#phase-label').textContent = phaseText ? `${phaseText} · ${seconds}s` : `${seconds}s`;
}

setInterval(tickTimer, 100);

// ------------------------------------------------------------------ actions

function nameValue() {
  const name = $('#name-input').value.trim();
  if (name) saveJson(NAME_KEY, name);
  return name || 'Player';
}

function startAction(msg) {
  showHomeError('');
  setBusy(true);
  draft = '';
  if (sock?.readyState === WebSocket.OPEN) {
    send(msg);
    setBusy(false);
  } else {
    connect(() => {
      send(msg);
      setBusy(false);
    });
  }
}

async function copyInvite() {
  const url = inviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    banner('Invite link copied!');
  } catch {
    // Clipboard needs a secure context and permission; show it instead.
    banner(url, { sticky: true });
  }
}

$('#create-btn').addEventListener('click', () => {
  startAction({ t: 'create', name: nameValue() });
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#code-input').value.trim().toUpperCase();
  if (code.length !== 4) {
    showHomeError('Room codes are 4 letters.');
    return;
  }
  startAction({ t: 'join', code, name: nameValue() });
});

$('#code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

$('#code-btn').addEventListener('click', copyInvite);

$('#chat-btn').addEventListener('click', () => {
  const panel = $('#chat-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderChat();
    $('#chat-input').focus();
  }
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  input.value = '';
});

$('#leave-btn').addEventListener('click', () => {
  if (!confirm('Leave this game?')) return;
  send({ t: 'leave' });
  session = null;
  saveJson(SESSION_KEY, null);
  state = null;
  stageSignature = null;
  chatEntries = [];
  showScreen('home');
});

// --------------------------------------------------------------- bootstrap

(function boot() {
  const savedName = loadJson(NAME_KEY);
  if (typeof savedName === 'string') $('#name-input').value = savedName;

  const roomParam = (new URL(location).searchParams.get('room') ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  // A ?room= link for a different room wins over a stale saved session.
  if (session && roomParam && roomParam !== session.code) {
    session = null;
    saveJson(SESSION_KEY, null);
  }

  if (session?.code && session.playerId && session.token) {
    connect(() => send({ t: 'resume', ...session }));
    return;
  }

  showScreen('home');
  if (roomParam) {
    $('#code-input').value = roomParam;
    $('#name-input').focus();
  }
})();
