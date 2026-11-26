// Meld rules: validating Groups and Runs, laying off, and joker swaps.
// Pure functions shared by the host (authoritative) and clients (UI hints).
//
// Meld shapes:
//   { id, owner, type: 'group', rank, cards }          normal group (same rank)
//   { id, owner, type: 'group', suit, cards }          Crazy Cards group (same suit)
//   { id, owner, type: 'run', suit, start, cards }     run; suit is null under Crazy Cards
// Run ranks: 2..14 normally. Under Two Ways runs are cyclic over 1..13 (A=1) so K-A-2 is legal.

import { isJoker, rankOf, suitOf, rankLabel, SUIT_SYMBOL, SUIT_NAME } from './cards.js';

export const ROUNDS = [
  { groups: 2, runs: 0, label: 'Two Groups' },
  { groups: 1, runs: 1, label: 'One Run, One Group' },
  { groups: 0, runs: 2, label: 'Two Runs' },
  { groups: 2, runs: 1, label: 'Two Groups, One Run' },
  { groups: 1, runs: 2, label: 'Two Runs, One Group' },
  { groups: 3, runs: 0, label: 'Three Groups' },
  { groups: 0, runs: 3, label: 'Three Runs' },
];

export const MIN_GROUP = 3;
export const MIN_RUN = 4;
const MAX_RUN = 13;

const cyclic = (mods) => !!mods.twoWays;
/** Rank as used inside runs (A=1 when cyclic). */
const runRank = (r, mods) => (cyclic(mods) && r === 14 ? 1 : r);
export function rankAt(start, i, mods) {
  return cyclic(mods) ? ((start - 1 + i) % 13) + 1 : start + i;
}

const ok = (v) => ({ ok: true, ...v });
const bad = (err) => ({ ok: false, err });

function wildCheck(ids, mods) {
  const j = ids.filter(isJoker).length;
  if (j > 1) return 'Only one wild card is allowed in a Group or Run';
  if (j > 0 && !mods.wild) return 'Jokers are not in play';
  return null;
}

export function analyzeGroup(ids, mods) {
  if (ids.length < MIN_GROUP) return bad(`A Group needs at least ${MIN_GROUP} cards`);
  const w = wildCheck(ids, mods);
  if (w) return bad(w);
  const nat = ids.filter((id) => !isJoker(id));
  if (mods.crazy) {
    const s = suitOf(nat[0]);
    if (!nat.every((id) => suitOf(id) === s)) return bad('Crazy Cards: a Group must share one suit');
    return ok({ meld: { type: 'group', suit: s, cards: ids.slice() } });
  }
  const r = rankOf(nat[0]);
  if (!nat.every((id) => rankOf(id) === r)) return bad('A Group must be cards of the same value');
  return ok({ meld: { type: 'group', rank: r, cards: ids.slice() } });
}

/** All legal orderings of these cards as a run, best guess first. */
export function arrangeRun(ids, mods) {
  if (ids.length < MIN_RUN) return bad(`A Run needs at least ${MIN_RUN} cards`);
  if (ids.length > MAX_RUN) return bad(`A Run can't be longer than ${MAX_RUN} cards`);
  const w = wildCheck(ids, mods);
  if (w) return bad(w);
  const nat = ids.filter((id) => !isJoker(id));
  const jokers = ids.filter(isJoker);
  const suit = mods.crazy ? null : suitOf(nat[0]);
  if (suit && !nat.every((id) => suitOf(id) === suit)) return bad('A Run must be all one suit');
  const L = ids.length;
  const starts = [];
  if (cyclic(mods)) for (let s = 1; s <= 13; s++) starts.push(s);
  else for (let s = 2; s + L - 1 <= 14; s++) starts.push(s);
  const options = [];
  const seen = new Set();
  for (const start of starts) {
    const slots = new Array(L).fill(null);
    let good = true;
    for (const id of nat) {
      const r = runRank(rankOf(id), mods);
      const pos = cyclic(mods) ? (r - start + 13) % 13 : r - start;
      if (pos < 0 || pos >= L || slots[pos]) { good = false; break; }
      slots[pos] = id;
    }
    if (!good) continue;
    let j = 0;
    for (let i = 0; i < L; i++) if (!slots[i]) slots[i] = jokers[j++];
    const key = slots.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ type: 'run', suit, start, cards: slots });
  }
  if (!options.length) return bad('Those cards are not a sequence');
  const score = (m) => {
    const ji = m.cards.findIndex(isJoker);
    const jokerPenalty = ji === -1 || ji === L - 1 ? 0 : ji === 0 ? 1 : 0; // prefer joker at high end
    const startPenalty = m.start === 2 ? 0 : 1; // prefer conventional A-high when cyclic
    return jokerPenalty * 2 + startPenalty;
  };
  options.sort((a, b) => score(a) - score(b));
  return ok({ options });
}

/** Validate a run in a specific order (what the client sends). */
export function validateRunOrder(ids, mods) {
  const res = arrangeRun(ids, mods);
  if (!res.ok) return res;
  const key = ids.join(',');
  const m = res.options.find((o) => o.cards.join(',') === key);
  if (!m) return bad('Those cards are not in run order');
  return ok({ meld: m });
}

export function analyzeMeld(type, ids, mods) {
  if (new Set(ids).size !== ids.length) return bad('Duplicate card');
  return type === 'group' ? analyzeGroup(ids, mods) : validateRunOrder(ids, mods);
}

/** What a joker at index i of this meld stands for. */
export function jokerStandsFor(meld, i, mods) {
  if (meld.type === 'group') return meld.rank ? { rank: meld.rank } : { suit: meld.suit };
  return { rank: rankAt(meld.start, i, mods), suit: meld.suit };
}

function naturalMatches(cardId, want, mods) {
  if (isJoker(cardId)) return false;
  if (want.rank != null && runRank(rankOf(cardId), mods) !== runRank(want.rank, mods)) return false;
  if (want.suit && suitOf(cardId) !== want.suit) return false;
  return true;
}

/** Ways a single card can join a meld.
 *  Returns [{kind:'add', end:'low'|'high'|null}, {kind:'swap', index}] */
export function layOffOptions(meld, cardId, mods) {
  const out = [];
  const hasJoker = meld.cards.some(isJoker);
  const joker = isJoker(cardId);
  if (joker && (!mods.wild || hasJoker)) return out;
  if (meld.type === 'group') {
    if (joker || naturalMatches(cardId, jokerStandsFor(meld, 0, mods), mods)) out.push({ kind: 'add', end: null });
  } else {
    const L = meld.cards.length;
    if (L < MAX_RUN) {
      const canHigh = cyclic(mods) || meld.start + L <= 14;
      if (canHigh && (joker || naturalMatches(cardId, { rank: rankAt(meld.start, L, mods), suit: meld.suit }, mods))) {
        out.push({ kind: 'add', end: 'high' });
      }
      const lowStart = cyclic(mods) ? (meld.start === 1 ? 13 : meld.start - 1) : meld.start - 1;
      const canLow = cyclic(mods) || lowStart >= 2;
      if (canLow && (joker || naturalMatches(cardId, { rank: lowStart, suit: meld.suit }, mods))) {
        out.push({ kind: 'add', end: 'low' });
      }
    }
  }
  if (!joker) {
    meld.cards.forEach((c, i) => {
      if (isJoker(c) && naturalMatches(cardId, jokerStandsFor(meld, i, mods), mods)) out.push({ kind: 'swap', index: i });
    });
  }
  return out;
}

export const addOptions = (meld, cardId, mods) => layOffOptions(meld, cardId, mods).filter((o) => o.kind === 'add');

/** Returns a new meld with the card added (assumes validity was checked). */
export function withCardAdded(meld, cardId, end, mods) {
  const m = { ...meld, cards: meld.cards.slice() };
  if (meld.type === 'run' && end === 'low') {
    m.cards.unshift(cardId);
    m.start = cyclic(mods) ? (meld.start === 1 ? 13 : meld.start - 1) : meld.start - 1;
  } else {
    m.cards.push(cardId);
  }
  return m;
}

/** Every distinct way to add all of `ids` to one meld. Each plan lists the steps in play order
 *  ({ cardId, end }) and the meld they produce. A run may need its cards in a particular order
 *  (the 3 before the 2), and a Joker may fit at either end, so runs are searched; a group takes
 *  cards in any order. */
export function layOffPlans(meld, ids, mods) {
  const plans = new Map();
  const walk = (m, left, steps) => {
    if (!left.length) {
      const key = meld.type === 'group' ? 'g' : m.cards.join(',');
      if (!plans.has(key)) plans.set(key, { steps, meld: m });
      return;
    }
    const tries = meld.type === 'group' ? [left[0]] : left;
    for (const id of tries) {
      for (const o of addOptions(m, id, mods)) {
        walk(withCardAdded(m, id, o.end, mods), left.filter((x) => x !== id), [...steps, { cardId: id, end: o.end }]);
      }
    }
  };
  walk(meld, ids, []);
  return [...plans.values()];
}

export function describeMeld(meld, mods) {
  if (meld.type === 'group') {
    return meld.rank ? `Group of ${rankLabel(meld.rank)}s` : `${SUIT_NAME[meld.suit]} group`;
  }
  const hi = rankAt(meld.start, meld.cards.length - 1, mods);
  return `Run ${rankLabel(meld.start)}–${rankLabel(hi)}${meld.suit ? ' ' + SUIT_SYMBOL[meld.suit] : ''}`;
}

/** Describe what a card would become when added at an end (for UI). */
export function describeAdd(meld, end, mods) {
  if (meld.type === 'group') return 'Add to group';
  return end === 'low' ? `Add to low end` : `Add to high end`;
}

/** Lay-down legality for a player's proposed melds.
 *  existing: {groups, runs} already laid (Gambit), req: round requirement. */
export function checkLayDownCounts(melds, existing, req, mods) {
  const g = melds.filter((m) => m.type === 'group').length + existing.groups;
  const r = melds.filter((m) => m.type === 'run').length + existing.runs;
  if (req.groups === 0 && g > 0) return 'This round has no Groups';
  if (req.runs === 0 && r > 0) return 'This round has no Runs';
  if (!mods.seeingDouble) {
    if (g > req.groups) return `Only ${req.groups} Group${req.groups === 1 ? '' : 's'} this round`;
    if (r > req.runs) return `Only ${req.runs} Run${req.runs === 1 ? '' : 's'} this round`;
  }
  const partial = g < req.groups || r < req.runs;
  if (partial && !mods.gambit) return `You need ${req.label} to go down`;
  if (partial) {
    // The Gambit: until a lay-down completes the round, it's the bare requirement — no extra copies,
    // no extra cards — so you always keep enough cards to finish.
    if (g > req.groups || r > req.runs) return "The Gambit: extra Groups/Runs wait until you're fully down";
    for (const m of melds) {
      const min = m.type === 'group' ? MIN_GROUP : MIN_RUN;
      if (m.cards.length !== min) return `The Gambit: until you're fully down, a ${m.type === 'group' ? 'Group' : 'Run'} is exactly ${min} cards`;
    }
  }
  if (mods.restrictive) {
    for (const m of melds) {
      const min = m.type === 'group' ? MIN_GROUP : MIN_RUN;
      if (m.cards.length !== min) return `Restrictive Requirements: lay down exactly ${min} cards per ${m.type === 'group' ? 'Group' : 'Run'}`;
    }
  }
  return null;
}

export function isFullyDown(counts, req) {
  return !!counts && counts.groups >= req.groups && counts.runs >= req.runs;
}

/** Could these loose cards ever form a new meld of a kind this round asks for? (Seeing Double stalemate check.)
 *  Optimistic on purpose: it only answers "no" when no such meld can possibly be built from them. */
export function couldStartMeld(ids, req, mods) {
  const wild = mods.wild && ids.some(isJoker) ? 1 : 0;
  const nat = ids.filter((id) => !isJoker(id));
  if (req.groups) {
    const counts = {};
    for (const id of nat) { const k = mods.crazy ? suitOf(id) : rankOf(id); counts[k] = (counts[k] || 0) + 1; }
    if (Object.values(counts).some((c) => c + wild >= MIN_GROUP)) return true;
  }
  if (req.runs) {
    const ranks = {};
    for (const id of nat) (ranks[mods.crazy ? '*' : suitOf(id)] ||= new Set()).add(runRank(rankOf(id), mods));
    const starts = cyclic(mods) ? 13 : 14 - MIN_RUN; // cyclic: 1..13; otherwise 2..11
    for (const set of Object.values(ranks)) {
      for (let s = 0; s < starts; s++) {
        const start = cyclic(mods) ? s + 1 : s + 2;
        let have = 0;
        for (let i = 0; i < MIN_RUN; i++) if (set.has(rankAt(start, i, mods))) have++;
        if (have + wild >= MIN_RUN) return true;
      }
    }
  }
  return false;
}
