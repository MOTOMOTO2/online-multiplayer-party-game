#!/usr/bin/env node
/**
 * Browser check: drives two real Chrome tabs through a complete game.
 *
 *   node scripts/browser-check.js [baseUrl]
 *
 * This exercises the actual UI - clicking buttons, typing into the lie box,
 * reading rendered text - rather than the WebSocket protocol underneath it
 * (scripts/smoke.js covers that). Fails on any console error or page error.
 *
 * Needs a local Chrome or Edge; set CHROME_PATH to point at a specific one.
 * Screenshots land in .screenshots/ when SHOTS=1.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8099').replace(/\/+$/, '');
const SHOTS = process.env.SHOTS === '1';
const SHOT_DIR = path.resolve('.screenshots');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error(`No Chrome/Edge found. Tried:\n  ${CANDIDATES.join('\n  ')}`);
}

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Poll until `fn()` returns a truthy value, or give up. */
async function until(fn, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last=${JSON.stringify(last)})` : ''}`);
}

const text = (page, sel) =>
  page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);

async function shot(page, name) {
  if (!SHOTS) return;
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/**
 * Chrome freezes backgrounded tabs, which stalls CDP evaluate calls against
 * whichever page isn't in front. Each player therefore gets a whole browser
 * instance - which also means a separate profile and separate localStorage,
 * a closer match to two real devices.
 */
async function launchBrowser(executablePath) {
  return puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 30_000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
}

/** A browser tab playing as one person. */
class Tab {
  constructor(page, label, browser) {
    this.page = page;
    this.label = label;
    this.browser = browser;
    this.consoleErrors = [];

    page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => this.consoleErrors.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => {
      // Ignore the WebSocket upgrade showing up as "failed" on teardown.
      if (!r.url().includes('/ws')) this.consoleErrors.push(`requestfailed: ${r.url()}`);
    });
  }

  async open() {
    await this.page.setViewport({ width: 420, height: 880, deviceScaleFactor: 1 });
    await this.page.goto(base, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('#create-btn');
    return this;
  }

  async setName(name) {
    await this.page.$eval('#name-input', (n) => (n.value = ''));
    await this.page.type('#name-input', name);
  }

  phase() {
    return this.page.evaluate(() => document.querySelector('#round-label')?.textContent ?? '');
  }

  /** Read the live game state straight out of the rendered DOM. */
  async view() {
    return this.page.evaluate(() => ({
      screen: document.querySelector('#screen-game').hidden ? 'home' : 'game',
      code: document.querySelector('#room-code')?.textContent ?? '',
      round: document.querySelector('#round-label')?.textContent ?? '',
      heading: document.querySelector('#stage h2')?.textContent ?? '',
      prompt: document.querySelector('#stage .prompt')?.textContent ?? '',
      roster: [...document.querySelectorAll('#roster li')].map((li) => ({
        name: li.querySelector('.roster-name')?.textContent ?? '',
        score: li.querySelector('.roster-score')?.textContent ?? '',
      })),
      options: [...document.querySelectorAll('#stage .option')].map((b) => ({
        text: b.querySelector('.option-text')?.textContent ?? b.textContent,
        disabled: b.disabled === true,
        mine: b.classList.contains('is-mine'),
        truth: b.classList.contains('is-truth'),
      })),
      locked: document.querySelector('#stage .locked-value')?.textContent ?? null,
      podium: [...document.querySelectorAll('.podium li')].map((li) => li.textContent.trim()),
      winner: document.querySelector('.winner-banner')?.textContent ?? null,
      error: (() => {
        const e = document.querySelector('#stage .error');
        return e && !e.hidden ? e.textContent : null;
      })(),
    }));
  }

  async clickText(selector, label) {
    const handles = await this.page.$$(selector);
    for (const h of handles) {
      const t = await h.evaluate((n) => n.textContent);
      if (t.includes(label)) {
        await h.click();
        return true;
      }
    }
    throw new Error(`${this.label}: no "${selector}" containing "${label}"`);
  }
}

async function main() {
  const executablePath = await findBrowser();
  log(`Browser check against ${base}`);
  log(`  using ${executablePath}`);

  const browsers = [await launchBrowser(executablePath), await launchBrowser(executablePath)];

  try {
    const [host, guest] = await Promise.all(
      ['host', 'guest'].map(async (label, i) => {
        const browser = browsers[i];
        const page = await browser.newPage();
        return new Tab(page, label, browser).open();
      }),
    );
    const tabs = [host, guest];
    log('  launched two independent browser profiles');

    // ---- home screen carries the rules --------------------------------
    const rulesText = await host.page.$eval('.rules', (n) => n.textContent);
    assert(/\+1000/.test(rulesText), 'home page should state the truth bonus');
    assert(/\+500/.test(rulesText), 'home page should state the bluff bonus');
    assert(/can't pick your own lie/i.test(rulesText), 'home page should state the self-pick rule');
    await shot(host.page, '1-home');
    log('  home page renders with the full rules');

    // ---- create + join ------------------------------------------------
    await host.setName('Ada');
    await host.page.click('#create-btn');
    const code = await until(
      async () => {
        const v = await host.view();
        return v.screen === 'game' && /^[A-Z]{4}$/.test(v.code) ? v.code : null;
      },
      'a room code on the host tab',
    );
    log(`  host created room ${code}`);
    await shot(host.page, '2-lobby');

    await guest.setName('Grace');
    await guest.page.type('#code-input', code);
    await guest.page.click('#join-btn');
    await until(async () => (await guest.view()).screen === 'game', 'guest to reach the game screen');

    for (const tab of tabs) {
      const v = await until(
        async () => {
          const view = await tab.view();
          return view.roster.length === 2 ? view : null;
        },
        `${tab.label} to see both players`,
      );
      assert(
        v.roster.map((r) => r.name).join(',') === 'Ada,Grace',
        `${tab.label} roster wrong: ${JSON.stringify(v.roster)}`,
      );
    }
    log('  two browser tabs are in the same room and see each other');

    // ---- start a 3-round game -----------------------------------------
    await host.clickText('.rounds-picker .btn', '3');
    await until(
      async () => (await host.page.$eval('.rounds-picker .active', (n) => n.textContent)) === '3',
      'round count set to 3',
    );
    await host.clickText('#stage .btn-primary', 'Start the game');

    for (let round = 1; round <= 3; round += 1) {
      // ---- lie phase --------------------------------------------------
      for (const tab of tabs) {
        await until(
          async () => (await tab.view()).round === `Round ${round} of 3`,
          `${tab.label} to reach round ${round}`,
        );
        const v = await tab.view();
        assert(v.prompt.includes('?'), `${tab.label}: prompt should show a blank`);
      }
      if (round === 1) await shot(host.page, '3-lie');

      for (const [i, tab] of tabs.entries()) {
        await tab.page.waitForSelector('#lie-input');
        await tab.page.type('#lie-input', `${tab.label} fib ${round}.${i}`);
        await tab.clickText('#stage .btn-primary', 'Lock in my lie');
      }

      // ---- guess phase ------------------------------------------------
      for (const tab of tabs) {
        const v = await until(
          async () => {
            const view = await tab.view();
            return view.options.length === 3 ? view : null;
          },
          `${tab.label} to see 3 options in round ${round}`,
        );
        const mine = v.options.filter((o) => o.mine);
        assert(mine.length === 1, `${tab.label}: exactly one option should be marked yours`);
        assert(mine[0].disabled, `${tab.label}: your own lie must not be clickable`);
        assert(
          mine[0].text.includes(tab.label),
          `${tab.label}: own lie mislabelled (${mine[0].text})`,
        );
      }
      if (round === 1) {
        await shot(host.page, '4-guess');
        log('  guess phase: own lie is shown and disabled on both tabs');
      }

      for (const tab of tabs) {
        const buttons = await tab.page.$$('#stage .option');
        for (const b of buttons) {
          const usable = await b.evaluate((n) => !n.disabled && !n.classList.contains('is-mine'));
          if (usable) {
            await b.click();
            break;
          }
        }
      }

      // ---- reveal -----------------------------------------------------
      for (const tab of tabs) {
        await until(
          async () => (await tab.view()).heading === `Round ${round} results`,
          `${tab.label} to see round ${round} results`,
        );
        const v = await tab.view();
        assert(
          v.options.some((o) => o.truth),
          `${tab.label}: the reveal should highlight the truth`,
        );
        assert(!v.prompt.includes('?'), `${tab.label}: the blank should be filled in on reveal`);
      }
      if (round === 1) {
        await shot(host.page, '5-reveal');
        log('  reveal phase: the answer is filled into the blank and highlighted');
      }

      await host.clickText('#stage .btn-primary, #stage .btn', round >= 3 ? 'final' : 'Next round');
    }

    // ---- final ---------------------------------------------------------
    for (const tab of tabs) {
      const v = await until(
        async () => {
          const view = await tab.view();
          return view.podium.length === 2 ? view : null;
        },
        `${tab.label} to see the final scoreboard`,
      );
      assert(v.winner && /wins|You win|tie/i.test(v.winner), `${tab.label}: no winner announced`);
      assert(v.round === 'Final', `${tab.label}: header should read Final`);
    }
    await shot(host.page, '6-final');
    const finalView = await host.view();
    log(`  final scoreboard: ${finalView.podium.join(' | ')}`);
    log(`  winner banner: ${finalView.winner}`);

    // ---- reload keeps your seat ----------------------------------------
    await guest.page.reload({ waitUntil: 'domcontentloaded' });
    const resumed = await until(
      async () => {
        const v = await guest.view();
        return v.screen === 'game' && v.podium.length === 2 ? v : null;
      },
      'guest to resume the same game after a reload',
    );
    assert(resumed.code === code, `resumed into the wrong room: ${resumed.code}`);
    log('  a page reload resumes the same seat (reconnect works)');

    // ---- play again -----------------------------------------------------
    await host.clickText('#stage .btn-primary', 'Play again');
    for (const tab of tabs) {
      const v = await until(
        async () => {
          const view = await tab.view();
          return view.round === 'Lobby' ? view : null;
        },
        `${tab.label} to return to the lobby`,
      );
      assert(
        v.roster.every((r) => r.score === '0'),
        `${tab.label}: scores should be cleared (${JSON.stringify(v.roster)})`,
      );
    }
    log('  "Play again" returns everyone to the lobby with scores cleared');

    // ---- no console noise ----------------------------------------------
    for (const tab of tabs) {
      assert(
        tab.consoleErrors.length === 0,
        `${tab.label} logged console errors:\n  ${tab.consoleErrors.join('\n  ')}`,
      );
    }

    log('\nPASS - two real browser tabs played a full game with no console errors.');
    if (SHOTS) log(`Screenshots in ${SHOT_DIR}`);
  } finally {
    await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  }
}

main().catch((error) => {
  console.error(`\nFAIL - ${error.message}`);
  process.exit(1);
});
