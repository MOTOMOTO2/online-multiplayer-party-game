import test from 'node:test';
import assert from 'node:assert/strict';

import { PROMPT_BANK, LAZY_LIES } from '../server/lib/prompts.js';
import { normalize } from '../server/lib/text.js';

test('the prompt bank is big enough for a long session', () => {
  // 8 rounds is the longest game; a bank this size keeps repeats rare.
  assert.ok(PROMPT_BANK.length >= 50, `only ${PROMPT_BANK.length} prompts`);
});

test('every prompt has exactly one blank and a short, non-empty answer', () => {
  for (const p of PROMPT_BANK) {
    assert.equal(p.text.split('___').length, 2, `bad blank: ${p.text}`);
    assert.ok(normalize(p.answer).length > 0, `empty answer: ${p.text}`);
    assert.ok(p.answer.length <= 22, `answer too long to pass as a lie: ${p.answer}`);
  }
});

test('prompt ids and prompt text are unique', () => {
  const ids = PROMPT_BANK.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate prompt id');

  const texts = PROMPT_BANK.map((p) => normalize(p.text));
  assert.equal(new Set(texts).size, texts.length, 'duplicate prompt text');
});

test('no prompt gives its own answer away', () => {
  for (const p of PROMPT_BANK) {
    const words = normalize(p.answer).split(' ').filter((w) => w.length > 3);
    const promptWords = new Set(normalize(p.text).split(' '));
    for (const w of words) {
      assert.equal(promptWords.has(w), false, `prompt contains its answer "${w}": ${p.text}`);
    }
  }
});

test('lazy lies are distinct and never accidentally correct', () => {
  const normalised = LAZY_LIES.map(normalize);
  assert.equal(new Set(normalised).size, LAZY_LIES.length, 'duplicate lazy lie');

  // If an autofilled lie matched a real answer, an AFK player could score.
  const answers = new Set(PROMPT_BANK.map((p) => normalize(p.answer)));
  for (const lie of normalised) {
    assert.equal(answers.has(lie), false, `lazy lie "${lie}" is a real answer`);
  }
});

test('there are more lazy lies than the maximum player count', () => {
  // closeLiePhase() needs a distinct fallback for every idle player.
  assert.ok(LAZY_LIES.length >= 10);
});
