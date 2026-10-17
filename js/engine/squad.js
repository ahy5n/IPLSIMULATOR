// Squad analysis: best XI, impact player, team strength. Pure functions over player ids.
import { arrangeOrder, quickOrder, effectiveBat } from './batting.js';
import { attackVariety } from './bowling.js';

export let XI_OVERSEAS_MAX = 4;
export let IMPACT = true;   // impact players (IPL only)
export function configureSquad({ xiOverseas, impact }) { XI_OVERSEAS_MAX = xiOverseas; IMPACT = impact; }
const BAT_W = [1, 1, 0.95, 0.9, 0.85, 0.75, 0.6];
const BOWL_W = [1, 1, 0.95, 0.9, 0.85];
const BOWLER_MIN = 55;                       // rating at which a player is a genuine bowling option

const wavg = (vals, w) => {
  const v = vals.slice().sort((a, b) => b - a);
  let s = 0, t = 0;
  w.forEach((wi, i) => { s += (v[i] ?? 0) * wi; t += wi; });
  return s / t;
};

// Batting strength counts each batter at the slot he would get, so an XI of five openers scores lower.
export function batStrength(ids, players) {
  return wavg(quickOrder(ids, players).map((id, i) => effectiveBat(players[id], i)), BAT_W);
}
export function bowlStrength(ids, players) { return wavg(ids.map((id) => players[id].bowl), BOWL_W); }

export function xiScore(ids, players) {
  let s = batStrength(ids, players) + bowlStrength(ids, players);
  const ps = ids.map((id) => players[id]);
  if (!ps.some((p) => p.role === 'WK')) s -= 12;
  const options = ps.filter((p) => p.bowl >= BOWLER_MIN);
  if (options.length < 5) s -= (5 - options.length) * 6;
  if (!options.some((p) => p.bowlType === 'spin')) s -= 3;
  if (!options.some((p) => p.bowlType === 'pace')) s -= 6;
  // Teams value a varied attack (a left-arm seamer, a wrist spinner, different types) over five of a kind.
  s += attackVariety(ids, players) * 0.6;
  return s;
}

const overseasIn = (ids, players) => ids.filter((id) => players[id].overseas).length;

// Pick the strongest legal XI (at most 4 overseas) by greedy seeding plus swap-based hill climbing.
export function bestXI(squad, players, { exclude = [] } = {}) {
  const avail = squad.filter((id) => !exclude.includes(id));
  if (avail.length <= 11) return orderBatting(avail, players);
  const sorted = avail.slice().sort((a, b) => players[b].ovr - players[a].ovr);
  const xi = [];
  const wk = sorted.find((id) => players[id].role === 'WK');
  if (wk) xi.push(wk);
  for (const id of sorted) {
    if (xi.length === 11) break;
    if (xi.includes(id)) continue;
    if (players[id].overseas && overseasIn(xi, players) >= XI_OVERSEAS_MAX) continue;
    xi.push(id);
  }
  let best = xiScore(xi, players);
  for (let iter = 0; iter < 40; iter++) {
    let improved = false;
    for (let i = 0; i < xi.length; i++) {
      for (const cand of avail) {
        if (xi.includes(cand)) continue;
        const trial = xi.slice(); trial[i] = cand;
        if (overseasIn(trial, players) > XI_OVERSEAS_MAX) continue;
        const sc = xiScore(trial, players);
        if (sc > best + 1e-9) { best = sc; xi[i] = cand; improved = true; }
      }
    }
    if (!improved) break;
  }
  return orderBatting(xi, players);
}

// Batting order from each player's preferred position.
export function orderBatting(ids, players) { return arrangeOrder(ids, players); }

// Two impact substitutes, as teams name before the toss:
//   bat:  a batter who comes in for the chase if we bowl first
//   bowl: a bowler who comes in for the second innings if we bat first
// If the XI already has 4 overseas players, both must be Indian.
export function bestImpacts(squad, xi, players, { exclude = [] } = {}) {
  if (!IMPACT) return { bat: null, bowl: null };
  const osFull = overseasIn(xi, players) >= XI_OVERSEAS_MAX;
  const legal = squad.filter((id) => !xi.includes(id) && !exclude.includes(id) && !(osFull && players[id].overseas));
  const pick = (key, not) => legal.filter((id) => id !== not).reduce((b, id) => (b == null || key(players[id]) > key(players[b]) ? id : b), null);
  const bowl = pick((p) => p.bowl * 1.1 + p.bat * 0.15);
  const bat = pick((p) => p.bat * 1.1 + p.bowl * 0.1, bowl);
  return { bat, bowl };
}

// One impact player (the more useful of the two), for code that only needs one.
export function bestImpact(squad, xi, players) {
  const { bat, bowl } = bestImpacts(squad, xi, players);
  const weakBowl = bowlStrength(xi, players) < batStrength(xi, players);
  return (weakBowl ? bowl : bat) ?? bowl ?? bat ?? null;
}

// Team strength on a 0-100-ish scale, plus the parts used for grades.
export function teamStrength(squad, players) {
  const xi = bestXI(squad, players);
  const impact = bestImpacts(squad, xi, players);
  // A side bats or bowls second about half the time, so each impact player counts at half weight.
  const batting = (batStrength(xi, players) + batStrength(impact.bat ? xi.concat(impact.bat) : xi, players)) / 2;
  const bowling = (bowlStrength(xi, players) + bowlStrength(impact.bowl ? xi.concat(impact.bowl) : xi, players)) / 2;
  const bench = squad.filter((id) => !xi.includes(id)).map((id) => players[id].ovr).sort((a, b) => b - a);
  const depth = bench.length ? bench.slice(0, 6).reduce((a, b) => a + b, 0) / Math.min(6, bench.length) : 0;
  const balance = Math.max(0, 100 + (xiScore(xi, players) - batStrength(xi, players) - bowlStrength(xi, players)) * 4);
  const overall = batting * 0.45 + bowling * 0.45 + depth * 0.06 + balance * 0.04;
  return { xi, impact, batting, bowling, depth, balance, overall };
}

// What the squad is short of, used by AI valuation. Targets are for a 25-man squad.
export function composition(squad, players) {
  const c = { BAT: 0, WK: 0, AR: 0, BOWL: 0, pace: 0, spin: 0, overseas: 0, size: squad.length };
  for (const id of squad) {
    const p = players[id];
    c[p.role]++;
    if (p.overseas) c.overseas++;
    if (p.bowl >= BOWLER_MIN && p.bowlType) c[p.bowlType]++;
  }
  return c;
}
