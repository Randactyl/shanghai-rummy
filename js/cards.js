// Card model. A card is identified by a compact string id: `${suit}${rank}.${deck}`
//   suit: H S D C, or X for a joker
//   rank: 2..14 (11=J, 12=Q, 13=K, 14=A); jokers use 1 or 2 to keep ids unique
//   deck: which physical deck it came from (multiple decks are shuffled together)

export const SUITS = ['H', 'S', 'D', 'C']; // tie-break order, high -> low
export const SUIT_SYMBOL = { H: '♥', S: '♠', D: '♦', C: '♣', X: '★' };
export const SUIT_NAME = { H: 'Hearts', S: 'Spades', D: 'Diamonds', C: 'Clubs' };
const FACE = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 1: 'A' };

export const isJoker = (id) => id[0] === 'X';
export const suitOf = (id) => id[0];
export const rankOf = (id) => (isJoker(id) ? 0 : parseInt(id.slice(1), 10));
export const isRed = (id) => id[0] === 'H' || id[0] === 'D';

export function rankLabel(r) {
  return FACE[r] || String(r);
}

export function label(id) {
  if (isJoker(id)) return 'Joker';
  return rankLabel(rankOf(id)) + SUIT_SYMBOL[suitOf(id)];
}

export function buildDeck(decks, withJokers = true) {
  const ids = [];
  for (let d = 0; d < decks; d++) {
    for (const s of SUITS) for (let r = 2; r <= 14; r++) ids.push(`${s}${r}.${d}`);
    if (withJokers) ids.push(`X1.${d}`, `X2.${d}`);
  }
  return ids;
}

export function cardsPerDeck(withJokers) {
  return withJokers ? 54 : 52;
}

/** Uniform random integer in [0, n). Uses crypto when available. */
export function defaultRng(n) {
  if (globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    let x;
    do {
      globalThis.crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % n;
  }
  return Math.floor(Math.random() * n);
}

export function shuffle(arr, rng = defaultRng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function points(id) {
  if (isJoker(id)) return 50;
  const r = rankOf(id);
  if (r === 14) return 20;
  if (r >= 10) return 10;
  return 5;
}

/** Value used when drawing for first dealer. Lowest card deals.
 *  High -> low: Joker, A, K, ... 2; ties by suit Hearts > Spades > Diamonds > Clubs. */
export function dealDrawValue(id) {
  if (isJoker(id)) return 1000;
  const suitLow = { C: 0, D: 1, S: 2, H: 3 }[suitOf(id)];
  return rankOf(id) * 4 + suitLow;
}

/** Sort helpers for hand display. */
export function sortByRank(ids) {
  return ids.slice().sort((a, b) => (rankOf(a) || 99) - (rankOf(b) || 99) || SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)));
}
export function sortBySuit(ids) {
  return ids.slice().sort((a, b) => {
    const sa = isJoker(a) ? 9 : SUITS.indexOf(suitOf(a));
    const sb = isJoker(b) ? 9 : SUITS.indexOf(suitOf(b));
    return sa - sb || rankOf(a) - rankOf(b);
  });
}
