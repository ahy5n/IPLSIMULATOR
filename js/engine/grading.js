// After the auction: team grades, value-for-money verdicts and a Monte Carlo season prediction.
import { teamStrength } from './squad.js';
import { marketValue } from './valuation.js';
import { createRng } from './rng.js';
import { generateFixtures } from './season.js';

const LETTERS = [[1.2, 'A+'], [0.7, 'A'], [0.3, 'B+'], [-0.1, 'B'], [-0.5, 'C+'], [-0.9, 'C'], [-Infinity, 'D']];

const zscores = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
  return xs.map((x) => (x - m) / sd);
};

// Grade every team on final strength (60%) and how much strength each crore bought (40%).
export function gradeTeams(auction, scn) {
  const rows = Object.values(auction.teams).map((t) => {
    const before = teamStrength(scn.teamById[t.id].retained, scn.players);
    const after = teamStrength(t.squad, scn.players);
    const spent = t.bought.filter((b) => !b.traded).reduce((n, b) => n + b.price, 0);
    return { id: t.id, before, after, spent, gain: after.overall - before.overall, efficiency: (after.overall - before.overall) / (spent / 100 + 2) };
  });
  const zs = zscores(rows.map((r) => r.after.overall));
  const ze = zscores(rows.map((r) => r.efficiency));
  rows.forEach((r, i) => {
    r.score = zs[i] * 0.6 + ze[i] * 0.4;
    r.grade = LETTERS.find(([cut]) => r.score >= cut)[1];
  });
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// Verdict for each player a team bought.
export function valueAnalysis(auction, scn, teamId) {
  return auction.teams[teamId].bought.filter((b) => !b.traded).map(({ id, price }) => {
    const p = scn.players[id];
    const fair = Math.round(marketValue(p) * (auction.inflation ?? 1));
    const ratio = price / fair;
    const verdict = ratio <= 0.7 ? 'Steal' : ratio <= 1.3 ? 'Fair price' : ratio <= 2 ? 'Overpaid' : 'Big overpay';
    return { id, price, fair, ratio, verdict, real: scn.actual[id] || null };
  }).sort((a, b) => b.price - a.price);
}

// Fast season model for predictions: win probability from the strength gap.
export function winProbability(sA, sB) { return 1 / (1 + Math.exp(-(sA - sB) / 3.5)); }

export function predictSeason(squads, scn, { sims = 400, seed = 1 } = {}) {
  const strength = Object.fromEntries(Object.entries(squads).map(([id, sq]) => [id, teamStrength(sq, scn.players).overall]));
  const fixtures = generateFixtures(scn.teams, seed);
  const rng = createRng(seed ^ 0x9e3779b9);
  const out = Object.fromEntries(Object.keys(squads).map((id) => [id, { playoffs: 0, titles: 0, pts: 0, strength: strength[id] }]));
  const play = (a, b) => (rng.next() < winProbability(strength[a], strength[b]) ? a : b);
  for (let s = 0; s < sims; s++) {
    const pts = Object.fromEntries(Object.keys(squads).map((id) => [id, 0]));
    for (const f of fixtures) pts[play(f.home, f.away)] += 2;
    const order = Object.keys(pts).sort((a, b) => pts[b] - pts[a] || rng.next() - 0.5);
    order.slice(0, 4).forEach((id) => out[id].playoffs++);
    Object.entries(pts).forEach(([id, p]) => { out[id].pts += p; });
    const q1 = play(order[0], order[1]);
    const el = play(order[2], order[3]);
    const q2 = play(q1 === order[0] ? order[1] : order[0], el);
    out[play(q1, q2)].titles++;
  }
  for (const r of Object.values(out)) { r.playoffs /= sims; r.titles /= sims; r.pts /= sims; }
  return out;
}
