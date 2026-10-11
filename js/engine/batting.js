// Batting positions. Each player lists one or more bands he is good in (Sunil Narine: top and lower).
// Bands overlap on purpose. Batting outside every band he has scales his batting down by distance.

export const BANDS = { top: [1, 3], middle: [4, 7], lower: [5, 9], tail: [8, 11] };
export const BAND_LABEL = { top: 'Top order', middle: 'Middle order', lower: 'Lower order', tail: 'Tail' };
export const BAND_SHORT = { top: 'Top', middle: 'Mid', lower: 'Lower', tail: 'Tail' };
// Multiplier by how many slots outside his nearest band a player bats.
const FIT = [1, 0.95, 0.89, 0.83, 0.78, 0.74, 0.7];
// Rough share of balls each slot faces, used to weight the order (openers bat the longest).
const SLOT_WEIGHT = [1, 1, 0.95, 0.9, 0.82, 0.72, 0.6, 0.45, 0.3, 0.2, 0.12];

const bandsOf = (p) => (Array.isArray(p.pos) ? p.pos : p.pos ? [p.pos] : ['middle']);

// Slots outside the player's bands (slot is 0-based).
export function slotDistance(p, slot) {
  const n = slot + 1;
  let best = Infinity;
  for (const b of bandsOf(p)) {
    const [lo, hi] = BANDS[b] || BANDS.middle;
    best = Math.min(best, n < lo ? lo - n : n > hi ? n - hi : 0);
  }
  return best;
}

export function positionFit(p, slot) { return FIT[Math.min(FIT.length - 1, slotDistance(p, slot))]; }

export function effectiveBat(p, slot) { return p.bat * positionFit(p, slot); }

export function bandsLabel(p) { return bandsOf(p).map((b) => BAND_SHORT[b]).join(' · '); }

export function bandsRange(p) {
  const bs = bandsOf(p).map((b) => BANDS[b]);
  return bs.map(([lo, hi]) => `${lo}–${hi}`).join(', ');
}

const weight = (i) => SLOT_WEIGHT[i] ?? 0.05;

// Batting order that gets the most out of an XI: fill slots in order with whoever bats best there,
// then swap any pair that improves the ball-weighted total.
export function arrangeOrder(ids, players) {
  const left = ids.slice();
  const order = [];
  for (let i = 0; left.length; i++) {
    let bi = 0, bv = -Infinity;
    left.forEach((id, k) => {
      const p = players[id];
      // Small tie-break so players who can bat lower are kept for later slots.
      const v = effectiveBat(p, i) - 0.01 * Math.max(...bandsOf(p).map((b) => (BANDS[b] || BANDS.middle)[1]));
      if (v > bv) { bv = v; bi = k; }
    });
    order.push(left.splice(bi, 1)[0]);
  }
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = players[order[i]], b = players[order[j]];
        const now = weight(i) * effectiveBat(a, i) + weight(j) * effectiveBat(b, j);
        const swapped = weight(i) * effectiveBat(b, i) + weight(j) * effectiveBat(a, j);
        if (swapped > now + 1e-9) { [order[i], order[j]] = [order[j], order[i]]; changed = true; }
      }
    }
    if (!changed) break;
  }
  return order;
}

// Fast approximate order for scoring XIs in bulk: top-order players first, then middle, lower and tail,
// best batters first within each group. arrangeOrder gives the real batting order.
export function quickOrder(ids, players) {
  const start = (p) => Math.min(...bandsOf(p).map((b) => (BANDS[b] || BANDS.middle)[0]));
  return ids.slice().sort((a, b) => start(players[a]) - start(players[b]) || players[b].bat - players[a].bat);
}

// Batting-rating points lost to players batting outside their bands.
export function orderPenalty(order, players) {
  return order.reduce((n, id, i) => n + players[id].bat - effectiveBat(players[id], i), 0);
}

// Batting archetypes: how a batter plays, on top of his rating. Multipliers on the chance of a
// boundary, a wicket and a dot ball, by phase (pp 1-6, mid 7-15, death 16-20) and against spin.
export const BAT_STYLES = {
  anchor: { label: 'Anchor', all: { boundary: 0.72, wicket: 0.62, dot: 0.94 } },
  aggressor: { label: 'Powerplay hitter', pp: { boundary: 1.38, wicket: 1.2 }, mid: { boundary: 1.1, wicket: 1.08 }, death: { boundary: 1.12, wicket: 1.08 } },
  slogger: { label: 'Slogger', all: { boundary: 1.75, wicket: 1.6, dot: 1.15 } },
  finisher: { label: 'Finisher', pp: { boundary: 0.88 }, death: { boundary: 1.32, wicket: 0.85 } },
  spin: { label: 'Spin hitter', vsSpin: { boundary: 1.3, wicket: 0.85 } },
};

export function styleLabel(p) { return BAT_STYLES[p.bs]?.label || ''; }

// Multipliers for one ball: { boundary, wicket, dot }.
export function styleEffect(p, phase, bowlerIsSpin) {
  const s = BAT_STYLES[p.bs];
  const m = { boundary: 1, wicket: 1, dot: 1 };
  if (!s) return m;
  for (const part of [s.all, s[phase], bowlerIsSpin ? s.vsSpin : null]) {
    if (!part) continue;
    for (const k of Object.keys(m)) if (part[k]) m[k] *= part[k];
  }
  return m;
}
