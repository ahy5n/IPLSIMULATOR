import { test, assert } from './harness.js';
import { loadScenario } from '../js/data.js';
import { createRng } from '../js/engine/rng.js';
import { simulateMatch } from '../js/engine/match.js';
import { autoLineup } from '../js/engine/season.js';
import { createAuction, simulateRest } from '../js/engine/auction.js';

const scn = await loadScenario('ipl-2026', '..');
const auction = simulateRest(createAuction(scn, { userTeam: 'CSK', seed: 77 }), scn);
const squads = Object.fromEntries(Object.values(auction.teams).map((t) => [t.id, t.squad]));
const lineups = (a, b) => ({ [a]: autoLineup(squads[a], scn.players), [b]: autoLineup(squads[b], scn.players) });

test('match: scorecards add up', () => {
  const rng = createRng(1);
  for (let i = 0; i < 30; i++) {
    const r = simulateMatch(rng, { teamA: 'CSK', teamB: 'MI', lineups: lineups('CSK', 'MI'), players: scn.players, washoutChance: 0 });
    for (const inn of r.innings) {
      const batRuns = inn.batting.reduce((n, b) => n + b.r, 0);
      assert.equal(batRuns + inn.extras, inn.runs, 'batting runs + extras = total');
      const bowlBalls = inn.bowling.reduce((n, b) => n + b.balls, 0);
      assert.equal(bowlBalls, inn.balls, 'bowler balls = legal balls');
      const credited = inn.bowling.reduce((n, b) => n + b.w, 0);
      assert.ok(credited <= inn.wkts, 'bowler wickets ≤ wickets');
      assert.ok(inn.balls <= 120 && inn.wkts <= 10);
      for (const b of inn.bowling) assert.ok(b.balls <= 24, `bowler over quota: ${b.balls} balls`);
    }
    assert.ok(r.winner === 'CSK' || r.winner === 'MI');
  }
});

test('match: chasing side stops once the target is reached', () => {
  const rng = createRng(2);
  for (let i = 0; i < 40; i++) {
    const r = simulateMatch(rng, { teamA: 'RCB', teamB: 'KKR', lineups: lineups('RCB', 'KKR'), players: scn.players, washoutChance: 0 });
    const [a, b] = r.innings;
    if (b.runs > a.runs) assert.ok(b.runs - a.runs <= 6, `overshot target by ${b.runs - a.runs}`);
  }
});

test('match: average first-innings score is in the IPL 2025 range (165-205)', () => {
  const rng = createRng(3);
  let total = 0, n = 0, sixes = 0;
  const ids = scn.teams.map((t) => t.id);
  for (let i = 0; i < 200; i++) {
    const a = ids[i % 10], b = ids[(i * 3 + 1) % 10];
    if (a === b) continue;
    const r = simulateMatch(rng, { teamA: a, teamB: b, lineups: lineups(a, b), players: scn.players, washoutChance: 0 });
    total += r.innings[0].runs; n++;
    sixes += r.innings[0].batting.reduce((s, x) => s + x.f6, 0);
  }
  assert.between(total / n, 165, 205, `average ${Math.round(total / n)}`);
  assert.between(sixes / n, 5, 14, `sixes per innings ${(sixes / n).toFixed(1)}`);
});

test('match: stronger side wins more often', () => {
  const strong = { xi: Object.values(scn.players).sort((a, b) => b.ovr - a.ovr).filter((p) => !p.overseas).slice(0, 11).map((p) => p.id), impact: null };
  const weak = { xi: Object.values(scn.players).sort((a, b) => a.ovr - b.ovr).filter((p) => !p.overseas).slice(0, 11).map((p) => p.id), impact: null };
  const rng = createRng(4);
  let wins = 0;
  for (let i = 0; i < 60; i++) {
    const r = simulateMatch(rng, { teamA: 'X', teamB: 'Y', lineups: { X: strong, Y: weak }, players: scn.players, washoutChance: 0 });
    if (r.winner === 'X') wins++;
  }
  assert.ok(wins >= 50, `strong side won ${wins}/60`);
});

test('match: same seed replays the same match', () => {
  const l = lineups('GT', 'DC');
  const a = simulateMatch(createRng(99), { teamA: 'GT', teamB: 'DC', lineups: l, players: scn.players });
  const b = simulateMatch(createRng(99), { teamA: 'GT', teamB: 'DC', lineups: l, players: scn.players });
  assert.deepEqual(a, b);
});

test('match: impact player swap is recorded and legal', () => {
  const rng = createRng(5);
  let swaps = 0;
  for (let i = 0; i < 20; i++) {
    const l = lineups('PBKS', 'LSG');
    const r = simulateMatch(rng, { teamA: 'PBKS', teamB: 'LSG', lineups: l, players: scn.players, washoutChance: 0 });
    for (const t of ['PBKS', 'LSG']) {
      const s = r.impact[t];
      if (!s) continue;
      swaps++;
      assert.ok([l[t].impact.bat, l[t].impact.bowl].includes(s.in), 'one of the named impact players came on');
      assert.ok(l[t].xi.includes(s.out));
    }
  }
  assert.ok(swaps > 0, 'impact players were used');
});
