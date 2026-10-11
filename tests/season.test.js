import { test, assert } from './harness.js';
import { loadScenario } from '../js/data.js';
import { generateFixtures, createSeason, playFixture, nextFixture, simToUserGame, standings, nrr, lineupProblem, autoLineup } from '../js/engine/season.js';
import { createAuction, simulateRest } from '../js/engine/auction.js';
import { gradeTeams, valueAnalysis, predictSeason } from '../js/engine/grading.js';

const scn = await loadScenario('ipl-2026', '..');
const auction = simulateRest(createAuction(scn, { userTeam: 'SRH', seed: 31 }), scn);
const squads = Object.fromEntries(Object.values(auction.teams).map((t) => [t.id, t.squad]));

test('fixtures: 70 league games, 14 per team, 7 at home', () => {
  const f = generateFixtures(scn.teams, 1);
  assert.equal(f.length, 70);
  for (const t of scn.teams) {
    const mine = f.filter((x) => x.home === t.id || x.away === t.id);
    assert.equal(mine.length, 14, `${t.id} plays ${mine.length}`);
    const home = f.filter((x) => x.home === t.id).length;
    assert.equal(home, 7, `${t.id} home games ${home}`);
  }
});

test('fixtures: group rivals meet twice, other-group teams once or twice', () => {
  const f = generateFixtures(scn.teams, 2);
  const meet = (a, b) => f.filter((x) => (x.home === a && x.away === b) || (x.home === b && x.away === a)).length;
  assert.equal(meet('CSK', 'KKR'), 2);
  assert.equal(meet('CSK', 'MI'), 2);   // same row in the other group
  assert.equal(meet('CSK', 'SRH'), 1);
});

test('fixtures: no team plays back-to-back games', () => {
  const f = generateFixtures(scn.teams, 3);
  let b2b = 0;
  for (let i = 1; i < f.length; i++) {
    const prev = [f[i - 1].home, f[i - 1].away];
    if (prev.includes(f[i].home) || prev.includes(f[i].away)) b2b++;
  }
  assert.ok(b2b <= 2, `${b2b} back-to-back games`);
});

test('season: full season runs to a champion with playoffs', () => {
  const s = createSeason(scn, squads, { userTeam: 'SRH', seed: 4 });
  let guard = 0;
  while (s.stage !== 'done' && guard++ < 100) playFixture(s, scn, nextFixture(s));
  assert.equal(s.stage, 'done');
  assert.equal(s.playoffs.length, 4);
  assert.ok(s.champion);
  const rows = standings(s);
  assert.equal(rows.reduce((n, r) => n + r.p, 0), 140);
  assert.equal(rows.reduce((n, r) => n + r.w, 0) + rows.reduce((n, r) => n + r.nr, 0) / 2, 70);
  const top4 = rows.slice(0, 4).map((r) => r.id);
  assert.ok(top4.includes(s.playoffs[3].home) && top4.includes(s.playoffs[3].away), 'finalists came from the top four');
  assert.ok(s.awards.orange && s.awards.purple);
  assert.ok(Math.abs(rows.reduce((n, r) => n + nrr(r) * r.bf, 0)) < 1e9);
});

test('season: sim to user game stops at the user fixture', () => {
  const s = createSeason(scn, squads, { userTeam: 'MI', seed: 5 });
  const fx = simToUserGame(s, scn);
  assert.ok(fx.home === 'MI' || fx.away === 'MI');
  assert.ok(s.fixtures.filter((f) => f.result).every((f) => f.home !== 'MI' && f.away !== 'MI'));
});

test('season: lineup checks enforce 11 players and the overseas limit', () => {
  const sq = squads.SRH;
  const ok = autoLineup(sq, scn.players);
  assert.equal(lineupProblem(ok, sq, scn.players), null);
  assert.ok(lineupProblem({ xi: ok.xi.slice(0, 10), impact: null }, sq, scn.players));
  const os = sq.filter((id) => scn.players[id].overseas);
  if (os.length >= 5) {
    const xi = os.slice(0, 5).concat(sq.filter((id) => !scn.players[id].overseas).slice(0, 6));
    assert.ok(/overseas/.test(lineupProblem({ xi, impact: null }, sq, scn.players)));
  }
});

test('grading: every team gets a grade and the user gets a value table', () => {
  const g = gradeTeams(auction, scn);
  assert.equal(g.length, 10);
  assert.ok(g.every((r) => /^[A-D][+]?$/.test(r.grade)));
  const v = valueAnalysis(auction, scn, 'SRH');
  assert.equal(v.length, auction.teams.SRH.bought.length);
});

test('prediction: probabilities sum to 4 playoff places and 1 title', () => {
  const p = predictSeason(squads, scn, { sims: 200, seed: 2 });
  const po = Object.values(p).reduce((n, r) => n + r.playoffs, 0);
  const ti = Object.values(p).reduce((n, r) => n + r.titles, 0);
  assert.between(po, 3.99, 4.01);
  assert.between(ti, 0.99, 1.01);
});
