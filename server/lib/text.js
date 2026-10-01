/**
 * Text helpers shared by the game engine.
 *
 * `normalize` is the single source of truth for "are these two answers the
 * same?". It is deliberately aggressive: players type lies on phone keyboards,
 * so "13 Seconds", "13 seconds." and "13  SECONDS" must all collide.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function normalize(input) {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')     // punctuation -> space
    .trim()
    .replace(/\s+/g, ' ');
}

/** Strip control characters and clamp length. Used on every untrusted string. */
export function clean(input, maxLen) {
  return String(input ?? '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, maxLen);
}

/** Player display name: never empty, never longer than maxLen. */
export function cleanName(input, maxLen = 16) {
  const name = clean(input, maxLen);
  return name.length > 0 ? name : 'Player';
}

/** Make `name` unique against `taken` by appending " 2", " 3", ... */
export function uniqueName(name, taken) {
  const used = new Set([...taken].map((n) => normalize(n)));
  if (!used.has(normalize(name))) return name;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${name} ${i}`;
    if (!used.has(normalize(candidate))) return candidate;
  }
  return `${name} ${Math.floor(Math.random() * 1e6)}`;
}
