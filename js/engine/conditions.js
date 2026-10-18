// Pitch conditions. The home team chooses them; they change bowling ratings and scoring, so the
// best XI for a turning track differs from the best XI for a flat deck.
import { bestXI, xiScore } from './squad.js';
import { typeOf } from './bowling.js';

export const CONDITIONS = {
  balanced: { label: 'Balanced', blurb: 'Fair contest between bat and ball.', pace: 0, spin: 0, boundary: 1, wicket: 1 },
  flat: { label: 'Flat deck', blurb: 'Big totals. Bowlers of every kind suffer.', pace: -4, spin: -4, boundary: 1.12, wicket: 0.88 },
  turning: { label: 'Turning track', blurb: 'Dry and slow. Spinners thrive, pace is easier to score off.', pace: -4, spin: 8, boundary: 0.93, wicket: 1.05 },
  green: { label: 'Green top', blurb: 'Grass and seam movement. Quicks thrive, spinners struggle.', pace: 8, spin: -4, boundary: 0.95, wicket: 1.08 },
};

// What each ground usually offers, used when the home side has no strong preference.
export const VENUE_DEFAULT = {
  CSK: 'turning', KKR: 'balanced', RR: 'balanced', RCB: 'flat', PBKS: 'green',
  MI: 'flat', SRH: 'flat', GT: 'balanced', DC: 'flat', LSG: 'turning',
  // PSL
  LQ: 'flat', KRK: 'balanced', IU: 'flat', RWP: 'flat', MS: 'turning', PZ: 'balanced', QG: 'balanced', HK: 'turning',
  // SA20
  JSK: 'flat', MICT: 'green', DSG: 'balanced', PR: 'turning', PC: 'flat', SEC: 'balanced',
  // The Hundred
  BPH: 'balanced', LS: 'green', MSG: 'balanced', MIL: 'flat', SB: 'green', SRL: 'flat', TR: 'flat', WF: 'turning',
};

// Copies of the given players with bowling adjusted for the conditions. Batting is unchanged.
export function adjustPlayers(players, ids, cond) {
  const c = CONDITIONS[cond] || CONDITIONS.balanced;
  if (!c.pace && !c.spin) return players;
  const out = Object.create(players);
  for (const id of ids) {
    const p = players[id];
    if (!p || !p.bowlType || p.bowl < 40) continue;
    // General pace/spin effect plus the type's own response (a green top helps swing bowlers most,
    // a turner helps finger spinners most, a flat deck punishes medium pace and finger spin).
    out[id] = { ...p, bowl: Math.max(0, Math.min(99, p.bowl + c[p.bowlType] + (typeOf(p).pitch[cond] || 0))) };
  }
  return out;
}

// The AI home side picks the conditions that most favour its squad over the visitors.
export function aiChooseConditions(homeId, homeSquad, awaySquad, players) {
  let best = VENUE_DEFAULT[homeId] || 'balanced', bestScore = -Infinity;
  for (const cond of Object.keys(CONDITIONS)) {
    const ids = homeSquad.concat(awaySquad);
    const adj = adjustPlayers(players, ids, cond);
    const edge = xiScore(bestXI(homeSquad, adj), adj) - xiScore(bestXI(awaySquad, adj), adj);
    const score = edge + (cond === VENUE_DEFAULT[homeId] ? 1.5 : 0);   // grounds pull towards their usual nature
    if (score > bestScore) { bestScore = score; best = cond; }
  }
  return best;
}
