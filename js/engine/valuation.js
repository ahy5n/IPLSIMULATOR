// How much players are worth: a market price for everyone, and each AI franchise's private ceiling.
import { maxAllowedBid, openSlots, overseasSlots, increment, SQUAD_MIN, SQUAD_MAX, MIN_PRICE } from './rules.js';
import { composition, teamStrength } from './squad.js';
import { createRng, hash32 } from './rng.js';

// Market value in lakh, from overall rating, before team needs and purse pressure. Exponential up to 80,
// because auctions pay a premium for match-winners (70 is worth about ₹1.65 Cr, 75 about ₹3.5 Cr,
// 80 about ₹7.7 Cr), then ₹1.8 Cr a point (85 about ₹16.7 Cr, 90 about ₹25.7 Cr).
// Age matters too: franchises pay less for players past 33 and a little more for those 22 and under.
// Leagues with smaller squads under the same cap pay more per player: career mode scales values to
// each league's real fees (see js/engine/league.js).
let VALUE_SCALE = 1;
export function configureValuation({ valueScale = 1 }) { VALUE_SCALE = valueScale; }

export function marketValue(p) {
  const age = p.age == null ? 1 : p.age >= 34 ? Math.max(0.45, 1 - (p.age - 33) * 0.1) : p.age <= 22 ? 1.1 : 1;
  const raw = p.ovr <= 80 ? 24.7 * Math.exp(0.17 * (p.ovr - 60)) : 740 + (p.ovr - 80) * 180;
  return Math.max(p.base ?? MIN_PRICE, Math.round(MIN_PRICE + raw * age * VALUE_SCALE));
}

export const DIFFICULTY = {
  // noise: spread of AI valuation errors. needWeight: how much squad needs matter.
  // pacing: extra share of purse an AI will risk on one player (higher = worse purse management).
  easy: { label: 'Easy', noise: 0.35, needWeight: 0.45, pacing: 0.18 },
  medium: { label: 'Medium', noise: 0.2, needWeight: 0.8, pacing: 0.06 },
  hard: { label: 'Hard', noise: 0.08, needWeight: 1, pacing: 0 },
};

const ROLE_TARGET = { WK: 2, BAT: 6, AR: 6, BOWL: 8 };
const TYPE_TARGET = { pace: 6, spin: 3 };
// AI teams aim to fill the squad (the live binding follows the league's squad maximum).
export { SQUAD_MAX as AI_TARGET_SIZE };

// How much the team's strength rises if it adds this player.
export function upgradeValue(team, p, players, baseStrength) {
  const before = baseStrength ?? teamStrength(team.squad, players).overall;
  return teamStrength(team.squad.concat(p.id), players).overall - before;
}

// Multiplier (about 0.4 to 1.9) for how badly a team needs this player.
export function needMultiplier(team, p, players, baseStrength, upgrade) {
  const c = composition(team.squad, players);
  let m = 1;
  m += 0.12 * Math.min(3, Math.max(0, ROLE_TARGET[p.role] - c[p.role]));
  if (p.bowlType && p.bowl >= 55) m += 0.1 * Math.min(2, Math.max(0, TYPE_TARGET[p.bowlType] - c[p.bowlType]));
  if (c.size < SQUAD_MIN) m += 0.1;
  const up = upgrade ?? upgradeValue(team, p, players, baseStrength);
  m += up * 0.3;
  if (up <= 0.05) m -= 0.25;   // would not get into the side
  return Math.min(1.9, Math.max(0.4, m));
}

// The most an AI team will pay for a player. Noise is fixed per (seed, team, player) so a team's
// ceiling does not wobble between bids.
// Price level of an auction relative to IPL 2026 (₹237.55 Cr for 77 slots, about ₹3.1 Cr a slot).
// More money chasing each open slot pushes every valuation up, as real auctions show.
export function marketInflation(teams, openSlotsTotal) {
  const perSlot = teams.reduce((n, t) => n + t.purse, 0) / Math.max(1, openSlotsTotal);
  // (Leagues whose slots are worth more already carry that in VALUE_SCALE.)
  return Math.pow(Math.min(2.5, Math.max(1, perSlot / (310 * VALUE_SCALE))), 0.7);
}

export function aiCeiling(team, p, players, { seed, difficulty, baseStrength, phase = 'main', inflation = 1, affinity = false }) {
  const d = DIFFICULTY[difficulty];
  if (openSlots(team) <= 0) return 0;
  if (p.overseas && overseasSlots(team, players) <= 0) return 0;
  const spendable = maxAllowedBid(team);
  if (spendable < p.base) return 0;
  const toFill = Math.max(1, SQUAD_MAX - team.squad.length);
  const rng = createRng(hash32(`${seed}:${team.id}:${p.id}`));
  const up = upgradeValue(team, p, players, baseStrength);
  // Squad depth: a player who would not make the XI is only worth about his reserve price.
  // In the opening sets teams save their slots for the accelerated rounds, so they pass on most depth lots.
  if (up < (phase === 'main' ? 0.35 : 0.1)) {
    const keen = phase === 'main' ? (openSlots(team) >= 4 ? 0.08 : 0) : 0.6;
    if (rng.next() > keen) return 0;
    return Math.min(spendable, p.base + (rng.next() < 0.3 ? 3 * increment(p.base) : 0));
  }
  const need = 1 + (needMultiplier(team, p, players, baseStrength, up) - 1) * d.needWeight;
  const richness = spendable / toFill;
  const heat = Math.min(1.6, Math.max(0.85, 1 + (richness - 100) / 400));
  const noise = Math.max(0.3, 1 + rng.normal(0, d.noise));
  const shareCap = toFill <= 1 ? 1 : Math.min(1, Math.max(0.08, (p.ovr - 58) / 50) + d.pacing);
  // affinity: the team's head coach has worked with this player before and wants him back.
  const value = marketValue(p) * inflation * need * heat * noise * (affinity ? 1.15 : 1);
  // Franchises budget per slot: nobody spends more than about 5.5 times the money they have per open
  // slot on one player (KKR's ₹25.2 Cr for Green in 2026, Pant's ₹27 Cr record in 2025).
  const perSlotCap = toFill <= 1 ? spendable : (spendable / toFill) * 5.5 * (0.9 + noise * 0.1);
  return Math.floor(Math.min(value, spendable * shareCap, perSlotCap, spendable));
}
