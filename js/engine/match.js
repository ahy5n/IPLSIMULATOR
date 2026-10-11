// T20 match engine. Simulates every ball internally and returns scorecards (no ball-by-ball view).
// Lineups: { xi: [11 ids in batting order], impact: { bat: id|null, bowl: id|null } }.
//   impact.bat comes in to bat if the side bowled first; impact.bowl comes on to bowl if it batted first.
// mods: { id: { bat, bowl } } rating changes for form, fitness and team chemistry this match.
import { effectiveBat, positionFit, styleEffect } from './batting.js';
import { typeOf, phaseBonus, rolesOf } from './bowling.js';
import { CONDITIONS, adjustPlayers } from './conditions.js';

const OVERS = 20;
const BALLS = OVERS * 6;
const MAX_OVERS_PER_BOWLER = 4;

// Base outcome rates per legal ball by phase, tuned to IPL 2025 scoring (about 9.5 an over).
const PHASE_RATES = {
  pp: { 0: 0.39, 1: 0.29, 2: 0.06, 3: 0.005, 4: 0.18, 6: 0.08, W: 0.036 },
  mid: { 0: 0.32, 1: 0.40, 2: 0.085, 3: 0.005, 4: 0.10, 6: 0.068, W: 0.043 },
  death: { 0: 0.27, 1: 0.30, 2: 0.085, 3: 0.005, 4: 0.145, 6: 0.13, W: 0.07 },
};
const EXTRA_RATE = 0.04;

const phaseOf = (over) => (over < 6 ? 'pp' : over < 15 ? 'mid' : 'death');

function ballOutcome(rng, batSkill, bowl, ctx) {
  const phase = phaseOf(ctx.over);
  const base = PHASE_RATES[phase];
  // The bowler's type and specialism change his effective rating by phase and his wicket/boundary
  // profile: express pace and wrist spin take more wickets but go for more; finger spin and medium pace
  // are tighter; new-ball and death specialists are better in their overs.
  const T = typeOf(bowl);
  const d = (batSkill - (bowl.bowl + phaseBonus(bowl, phase))) / 100;
  // The batter's archetype: anchors rarely get out, sloggers hit and miss, finishers peak at the death.
  const S = styleEffect(ctx.batter, phase, T.kind === 'spin');
  let boundary = Math.exp(1.0 * d) * T.boundary * S.boundary, wicket = Math.exp(-0.9 * d) * T.wicket * S.wicket, dot = Math.exp(-0.6 * d) * S.dot;
  if (ctx.facedByStriker < 6) { wicket *= 1.15; boundary *= 0.85; }
  const a = ctx.aggression;
  boundary *= (1 + 0.35 * a) * ctx.cond.boundary; wicket *= (1 + 0.35 * a) * ctx.cond.wicket; dot *= 1 - 0.2 * a;
  if (ctx.wicketsLeft <= 3 && ctx.over < 15) { boundary *= 0.85; wicket *= 0.8; }
  const w = { 0: base[0] * dot, 1: base[1], 2: base[2], 3: base[3], 4: base[4] * boundary, 6: base[6] * boundary, W: base.W * wicket };
  const total = Object.values(w).reduce((x, y) => x + y, 0);
  let r = rng.next() * total;
  for (const k of ['0', '1', '2', '3', '4', '6', 'W']) { r -= w[k]; if (r <= 0) return k; }
  return '0';
}

// Bowling attack: up to six best bowlers, at least five, ordered by bowling rating.
function pickAttack(ids, players) {
  const sorted = ids.slice().sort((a, b) => players[b].bowl - players[a].bowl);
  const attack = sorted.filter((id) => players[id].bowl >= 45).slice(0, 6);
  for (const id of sorted) { if (attack.length >= 5) break; if (!attack.includes(id)) attack.push(id); }
  return attack;
}

function chooseBowler(over, attack, overs, last, players) {
  const remaining = OVERS - over;
  const left = (id) => MAX_OVERS_PER_BOWLER - (overs[id] || 0);
  const pool = attack.filter((id) => left(id) > 0 && id !== last);
  if (!pool.length) return attack.find((id) => left(id) > 0) || attack[0];
  // If quotas are tight, the bowler with the most overs left must bowl now.
  const total = attack.reduce((n, id) => n + left(id), 0);
  if (total - remaining <= 1) {
    const most = Math.max(...pool.map(left));
    const forced = pool.filter((id) => left(id) === most);
    if (forced.length === 1) return forced[0];
  }
  const ph = phaseOf(over);
  const top2 = attack.slice(0, 2);
  const score = (id) => {
    const p = players[id];
    // Captains match type to phase: swing and pace up front, spin in the middle, fast men at the death.
    // New-ball specialists open; death specialists keep overs back for the end.
    let s = p.bowl + phaseBonus(p, ph) * 1.6;
    const roles = rolesOf(p);
    if (roles.includes('death') && over < 15 && left(id) <= 2 && remaining > 5) s -= 15;
    if (roles.includes('newball') && !roles.includes('death') && ph === 'death') s -= 4;
    if (over < 15 && top2.includes(id) && left(id) <= 1 && remaining > 5) s -= 20;  // keep an over of the best for the death
    return s;
  };
  return pool.reduce((b, id) => (score(id) > score(b) ? id : b), pool[0]);
}

function dismissal(rng, bowlerId, fielders, players) {
  const bowler = players[bowlerId];
  const r = rng.next();
  if (r < 0.05) return { how: 'run out', credit: false, fielder: rng.pick(fielders) };
  if (r < 0.08 && bowler.bowlType === 'spin') {
    const wk = fielders.find((id) => players[id].role === 'WK');
    if (wk) return { how: 'stumped', credit: true, fielder: wk };
  }
  if (r < 0.26) return { how: 'bowled', credit: true };
  if (r < 0.40) return { how: 'lbw', credit: true };
  const wk = fielders.find((id) => players[id].role === 'WK');
  const catcher = wk && rng.next() < 0.15 ? wk : rng.pick(fielders.filter((id) => id !== bowlerId));
  return { how: catcher === bowlerId ? 'caught and bowled' : 'caught', credit: true, fielder: catcher };
}

export function simulateInnings(rng, { battingOrder, bowlers, fielders, players, target = null, balls = BALLS, maxWickets = 10, conditions = 'balanced' }) {
  const cond = CONDITIONS[conditions] || CONDITIONS.balanced;
  const card = battingOrder.map((id) => ({ id, r: 0, b: 0, f4: 0, f6: 0, out: null, batted: false }));
  const bowl = {};
  const overs = {};
  let runs = 0, wkts = 0, legal = 0, extras = 0;
  let striker = 0, non = 1, next = 2;
  card[0].batted = true; if (card[1]) card[1].batted = true;
  const fow = [];
  let lastBowler = null;
  const totalOvers = Math.ceil(balls / 6);
  for (let over = 0; over < totalOvers && wkts < maxWickets; over++) {
    const bowlerId = balls < BALLS ? bowlers[0] : chooseBowler(over, bowlers, overs, lastBowler, players);
    const bw = bowl[bowlerId] || (bowl[bowlerId] = { id: bowlerId, balls: 0, r: 0, w: 0, dots: 0 });
    let inOver = 0;
    while (inOver < 6 && legal < balls && wkts < maxWickets) {
      if (target != null && runs >= target) break;
      if (rng.next() < EXTRA_RATE) { runs++; extras++; bw.r++; continue; }
      const bat = card[striker];
      const ballsLeft = balls - legal;
      let aggression = phaseOf(over) === 'death' ? 0.3 : 0;
      if (target != null) {
        const req = ((target - runs) / ballsLeft) * 6;
        aggression = Math.max(-0.5, Math.min(1, (req - 9) / 6));
      }
      // A batter's skill depends on where he bats: card index = batting slot.
      const o = ballOutcome(rng, effectiveBat(players[bat.id], striker), players[bowlerId], {
        over, aggression, wicketsLeft: maxWickets - wkts, facedByStriker: bat.b, cond, batter: players[bat.id],
      });
      legal++; inOver++; bat.b++; bw.balls++;
      if (o === 'W') {
        const d = dismissal(rng, bowlerId, fielders, players);
        if (d.credit) bw.w++;
        bat.out = { how: d.how, bowler: d.credit ? bowlerId : null, fielder: d.fielder || null };
        wkts++;
        fow.push({ runs, wkts, balls: legal, id: bat.id });
        if (next < card.length && wkts < maxWickets) { striker = next++; card[striker].batted = true; }
        bw.dots++;
      } else {
        const r = Number(o);
        runs += r; bat.r += r; bw.r += r;
        if (r === 0) bw.dots++;
        if (r === 4) bat.f4++;
        if (r === 6) bat.f6++;
        if (r % 2 === 1) [striker, non] = [non, striker];
      }
    }
    overs[bowlerId] = (overs[bowlerId] || 0) + 1;
    lastBowler = bowlerId;
    [striker, non] = [non, striker];
    if (target != null && runs >= target) break;
  }
  return { runs, wkts, balls: legal, extras, batting: card, bowling: Object.values(bowl), fow, allOut: wkts >= maxWickets };
}

// The impact player for a role. Accepts the older single-impact lineups too.
export function impactFor(lineup, role) {
  const i = lineup.impact;
  if (!i) return null;
  return typeof i === 'object' ? i[role] || null : i;
}

export function impactIds(lineup) {
  const i = lineup.impact;
  if (!i) return [];
  return typeof i === 'object' ? [i.bat, i.bowl].filter(Boolean) : [i];
}

// Players with this match's rating changes applied (form, fitness, chemistry).
export function applyMods(players, mods) {
  if (!mods) return players;
  const out = Object.create(players);
  for (const [id, m] of Object.entries(mods)) {
    const p = players[id];
    if (!p) continue;
    out[id] = { ...p, bat: Math.max(1, Math.min(99, p.bat + (m.bat || 0))), bowl: Math.max(1, Math.min(99, p.bowl + (m.bowl || 0))) };
  }
  return out;
}

// Swap in the impact player at the innings break. Returns { xi, swap } for the next innings.
function applyImpact(lineup, players, role) {
  const imp = impactFor(lineup, role);
  if (!imp) return { xi: lineup.xi, swap: null };
  const xi = lineup.xi.slice();
  let outIdx;
  if (role === 'bowl') {
    // Batted first: bring on a bowler for a batter who is no use with the ball.
    outIdx = xi.reduce((b, id, i) => (players[id].role !== 'WK' && players[id].bowl < players[xi[b]].bowl ? i : b), xi.findIndex((id) => players[id].role !== 'WK'));
    if (players[imp].bowl <= players[xi[outIdx]].bowl) return { xi, swap: null };
    xi[outIdx] = imp;
  } else {
    // Bowled first: bring in a batter for the weakest batter, slotting him into the order by batting rating.
    outIdx = xi.reduce((b, id, i) => (players[id].bat < players[xi[b]].bat ? i : b), 0);
    if (players[imp].bat <= players[xi[outIdx]].bat) return { xi, swap: null };
    const out = xi[outIdx];
    xi.splice(outIdx, 1);
    // He goes in at the first slot inside his batting bands where he is the better batter.
    let pos = xi.findIndex((id, i) => positionFit(players[imp], i) === 1 && players[id].bat < players[imp].bat);
    if (pos < 0) pos = xi.length;
    xi.splice(pos, 0, imp);
    return { xi, swap: { in: imp, out } };
  }
  return { xi, swap: { in: imp, out: lineup.xi[outIdx] } };
}

function superOver(rng, a, b, lineups, players, conditions) {
  const one = (bat, bowlTeam, target) => {
    const order = lineups[bat].xi.slice().sort((x, y) => players[y].bat - players[x].bat).slice(0, 3);
    const best = pickAttack(lineups[bowlTeam].xi, players)[0];
    return simulateInnings(rng, { battingOrder: order, bowlers: [best], fielders: lineups[bowlTeam].xi, players, target, balls: 6, maxWickets: 2, conditions });
  };
  for (let i = 0; i < 3; i++) {
    const s1 = one(a, b, null);
    const s2 = one(b, a, s1.runs + 1);
    if (s1.runs !== s2.runs) return { winner: s1.runs > s2.runs ? a : b, rounds: i + 1, scores: [s1.runs, s2.runs] };
  }
  return { winner: rng.next() < 0.5 ? a : b, rounds: 3, scores: null };
}

// Player-of-the-match points.
export function impactPoints(id, innings) {
  let pts = 0;
  for (const inn of innings) {
    const bt = inn.batting.find((x) => x.id === id);
    if (bt && bt.batted) pts += bt.r + bt.f4 + bt.f6 * 2 + (bt.b >= 10 ? (bt.r / bt.b - 1.3) * 15 : 0);
    const bw = inn.bowling.find((x) => x.id === id);
    if (bw) pts += bw.w * 25 + bw.dots * 1 - Math.max(0, bw.r - bw.balls * 1.5) * 0.5;
  }
  return pts;
}

// Simulate a full match. teamA hosts. Returns a JSON-safe result.
export function simulateMatch(rng, { teamA, teamB, lineups, players: basePlayers, washoutChance = 0.015, conditions = 'balanced', mods = null }) {
  if (rng.next() < washoutChance) {
    return { teamA, teamB, noResult: true, winner: null, innings: [], summary: 'No result (rain)', conditions };
  }
  const allIds = [teamA, teamB].flatMap((t) => lineups[t].xi.concat(impactIds(lineups[t])));
  const players = adjustPlayers(applyMods(basePlayers, mods), allIds, conditions);
  const tossWinner = rng.next() < 0.5 ? teamA : teamB;
  const decision = rng.next() < 0.6 ? 'bowl' : 'bat';
  const first = decision === 'bat' ? tossWinner : (tossWinner === teamA ? teamB : teamA);
  const second = first === teamA ? teamB : teamA;

  const inn1 = simulateInnings(rng, {
    battingOrder: lineups[first].xi, bowlers: pickAttack(lineups[second].xi, players), fielders: lineups[second].xi, players, conditions,
  });
  const f2 = applyImpact(lineups[first], players, 'bowl');
  const s2 = applyImpact(lineups[second], players, 'bat');
  const inn2 = simulateInnings(rng, {
    battingOrder: s2.xi, bowlers: pickAttack(f2.xi, players), fielders: f2.xi, players, target: inn1.runs + 1, conditions,
  });
  inn1.team = first; inn2.team = second;
  const innings = [inn1, inn2];
  let winner, summary, superOverResult = null;
  if (inn2.runs > inn1.runs) {
    winner = second;
    const wLeft = 10 - inn2.wkts, bLeft = BALLS - inn2.balls;
    summary = `won by ${wLeft} wicket${wLeft === 1 ? '' : 's'}${bLeft ? ` (${bLeft} ball${bLeft === 1 ? '' : 's'} left)` : ''}`;
  } else if (inn2.runs < inn1.runs) {
    winner = first;
    const m = inn1.runs - inn2.runs;
    summary = `won by ${m} run${m === 1 ? '' : 's'}`;
  } else {
    superOverResult = superOver(rng, second, first, { [first]: { xi: f2.xi }, [second]: { xi: s2.xi } }, players, conditions);
    winner = superOverResult.winner;
    summary = 'won the Super Over';
  }
  const everyone = [...new Set([...lineups[teamA].xi, ...lineups[teamB].xi, ...s2.xi, ...f2.xi])];
  const potm = everyone.reduce((best, id) => {
    const bonus = (id) => (lineups[winner].xi.includes(id) || impactIds(lineups[winner]).includes(id) ? 15 : 0);
    return impactPoints(id, innings) + bonus(id) > impactPoints(best, innings) + bonus(best) ? id : best;
  }, everyone[0]);
  return {
    teamA, teamB, toss: { winner: tossWinner, decision }, innings, winner, summary, superOver: superOverResult, potm,
    impact: { [first]: f2.swap, [second]: s2.swap }, noResult: false, conditions,
  };
}
