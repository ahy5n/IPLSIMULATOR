import { test, assert } from './harness.js';
import { loadScenario } from '../js/data.js';
import { createRng } from '../js/engine/rng.js';
import { createAuction, simulateRest } from '../js/engine/auction.js';
import { createSeason, playFixture, nextFixture, autoLineup, fixtureConditions } from '../js/engine/season.js';
import { simulateMatch } from '../js/engine/match.js';
import { arrangeOrder, positionFit, effectiveBat, orderPenalty, slotDistance } from '../js/engine/batting.js';
import { CONDITIONS, adjustPlayers, aiChooseConditions } from '../js/engine/conditions.js';
import { typeOf } from '../js/engine/bowling.js';
import { startWorld, endSeason, suggestRetentions, suggestFor, retentionProblemFor, nextKind, applyRetentions, buildAuction, scenarioFromWorld, retentionProblem, purseCap, teamPlayers, ageCurve } from '../js/engine/dynasty.js';
import { SQUAD_MAX, OVERSEAS_MAX } from '../js/engine/rules.js';

const scn = await loadScenario('ipl-2026', '..');
const P = scn.players;

// ---------- batting positions ----------
test('positions: every player has one or more batting bands', () => {
  for (const p of Object.values(P)) assert.ok(Array.isArray(p.pos) && p.pos.length && p.pos.every((b) => ['top', 'middle', 'lower', 'tail'].includes(b)), p.name);
  assert.deepEqual(P['virat-kohli'].pos, ['top']);
  assert.deepEqual(P['sunil-narine'].pos, ['top', 'lower']);
  assert.deepEqual(P['rinku-singh'].pos, ['middle', 'lower']);
});

test('positions: bands are top 1-3, middle 3-7, lower 5-9; outside them batting scales down', () => {
  const narine = P['sunil-narine'];
  assert.equal(slotDistance(narine, 0), 0, 'Narine opens');
  assert.equal(slotDistance(narine, 7), 0, 'and bats at 8');
  assert.equal(slotDistance(narine, 3), 1, 'No. 4 is one outside both bands');
  assert.equal(positionFit(P['virat-kohli'], 2), 1);
  assert.ok(positionFit(P['virat-kohli'], 6) < 0.85);
  assert.equal(slotDistance(P['rinku-singh'], 8), 0, 'lower order runs to No. 9');
  assert.equal(slotDistance({ pos: ['middle'] }, 2), 0, 'a middle-order batter is at home at No. 3');
  assert.equal(slotDistance({ pos: ['middle'] }, 1), 1, 'but not opening');
  assert.ok(effectiveBat(P['virat-kohli'], 6) < P['virat-kohli'].bat);
});

test('positions: the arranged order puts top-order players in 1-3', () => {
  const xi = autoLineup(scn.teamById.RCB.retained, P).xi;
  const order = arrangeOrder(xi, P);
  assert.ok(order.slice(0, 2).every((id) => P[id].pos.includes('top')), `openers: ${order.slice(0, 2).map((id) => P[id].name)}`);
  assert.ok(orderPenalty(order, P) <= orderPenalty(order.slice().reverse(), P));
});

test('positions: a batter is weaker in a match when moved out of position', () => {
  const kkr = autoLineup(scn.teamById.KKR.retained, P), mi = autoLineup(scn.teamById.MI.retained, P);
  // Put the tail at the top: the same XI should score less on average.
  const flipped = { xi: kkr.xi.slice().reverse(), impact: kkr.impact };
  const avg = (lineup) => {
    const rng = createRng(17); let n = 0;
    for (let i = 0; i < 60; i++) n += simulateMatch(rng, { teamA: 'KKR', teamB: 'MI', lineups: { KKR: lineup, MI: mi }, players: P, washoutChance: 0 }).innings.find((x) => x.team === 'KKR').runs;
    return n / 60;
  };
  const a = avg(kkr), b = avg(flipped);
  assert.ok(a > b + 8, `normal ${a.toFixed(0)} vs flipped ${b.toFixed(0)}`);
});

// ---------- conditions ----------
test('conditions: turning tracks lift spinners and green tops lift seamers', () => {
  const ids = ['varun-chakravarthy', 'jasprit-bumrah'];
  const turn = adjustPlayers(P, ids, 'turning'), green = adjustPlayers(P, ids, 'green');
  const extra = (id, c) => typeOf(P[id]).pitch[c] || 0;   // each bowling type's own response to the pitch
  assert.equal(turn['varun-chakravarthy'].bowl, P['varun-chakravarthy'].bowl + CONDITIONS.turning.spin + extra('varun-chakravarthy', 'turning'));
  assert.equal(turn['jasprit-bumrah'].bowl, P['jasprit-bumrah'].bowl + CONDITIONS.turning.pace + extra('jasprit-bumrah', 'turning'));
  assert.ok(green['jasprit-bumrah'].bowl > P['jasprit-bumrah'].bowl);
  assert.equal(P['varun-chakravarthy'].bowl, turn['varun-chakravarthy'].bowl - CONDITIONS.turning.spin - extra('varun-chakravarthy', 'turning'), 'original data untouched');
});

test('conditions: flat decks produce more runs than turning tracks', () => {
  const a = autoLineup(scn.teamById.SRH.retained, P), b = autoLineup(scn.teamById.RCB.retained, P);
  const avg = (cond) => {
    const rng = createRng(5); let n = 0;
    for (let i = 0; i < 80; i++) n += simulateMatch(rng, { teamA: 'SRH', teamB: 'RCB', lineups: { SRH: a, RCB: b }, players: P, washoutChance: 0, conditions: cond }).innings[0].runs;
    return n / 80;
  };
  const flat = avg('flat'), turning = avg('turning');
  assert.ok(flat > turning + 10, `flat ${flat.toFixed(0)} vs turning ${turning.toFixed(0)}`);
});

test('conditions: the auto XI changes with the pitch', () => {
  const sq = simulateRest(createAuction(scn, { userTeam: 'CSK', seed: 3 }), scn).teams.CSK.squad;
  const spinners = (cond) => autoLineup(sq, P, cond).xi.filter((id) => P[id].bowlType === 'spin' && P[id].bowl >= 55).length;
  assert.ok(spinners('turning') >= spinners('green'), `turning ${spinners('turning')} vs green ${spinners('green')}`);
});

test('conditions: AI hosts choose conditions and the choice is recorded on the fixture', () => {
  const a = simulateRest(createAuction(scn, { userTeam: 'GT', seed: 4 }), scn);
  const squads = Object.fromEntries(Object.values(a.teams).map((t) => [t.id, t.squad]));
  const s = createSeason(scn, squads, { userTeam: 'GT', seed: 4 });
  const fx = s.fixtures.find((f) => f.home !== 'GT');
  const c = fixtureConditions(s, scn, fx);
  assert.ok(CONDITIONS[c]);
  assert.equal(fx.conditions, c);
  assert.equal(c, aiChooseConditions(fx.home, squads[fx.home], squads[fx.away], P));
  const res = playFixture(s, scn, fx);
  assert.equal(res.conditions, c);
});

// ---------- dynasty ----------
function playSeason(world, scnNow, user, seed) {
  const a = simulateRest(createAuction(scnNow, { userTeam: user, seed }), scnNow);
  const squads = Object.fromEntries(Object.values(a.teams).map((t) => [t.id, t.squad]));
  const s = createSeason(scnNow, squads, { userTeam: user, seed });
  let g = 0;
  while (s.stage !== 'done' && g++ < 100) playFixture(s, scnNow, nextFixture(s));
  return { a, s };
}

test('dynasty: ageing curve rewards youth and punishes age', () => {
  assert.ok(ageCurve(20) > 0 && ageCurve(36) < 0);
});

test('dynasty: three seasons run with legal retentions and auctions', () => {
  const world = startWorld(scn);
  let scnNow = scn;
  for (let y = 0; y < 3; y++) {
    const { a, s } = playSeason(world, scnNow, 'RR', 100 + y);
    const out = endSeason(world, { auction: a, season: s, userTeam: 'RR', finish: '5th', seed: 100 + y });
    assert.equal(world.year, 2027 + y);
    assert.ok(out.prospects.length > 0);
    const retained = {};
    for (const t of scn.teams) {
      retained[t.id] = suggestFor(world, t.id);
      assert.equal(retentionProblemFor(world, retained[t.id]), null, `${t.id} retentions`);
    }
    assert.equal(nextKind(world), world.year === 2028 ? 'mega' : 'mini');
    applyRetentions(world, retained);
    buildAuction(world, scn.teams);
    scnNow = scenarioFromWorld(world, scn);
    for (const t of scnNow.teams) {
      assert.ok(t.retained.length <= SQUAD_MAX);
      assert.ok(t.retained.filter((id) => world.players[id].overseas).length <= OVERSEAS_MAX);
      assert.ok(t.purse >= 0 && t.purse <= purseCap(world.year), `${t.id} purse ${t.purse}`);
      assert.ok(t.retained.every((id) => !world.players[id].retired), `${t.id} retained a retired player`);
    }
    const slots = scnNow.teams.reduce((n, t) => n + SQUAD_MAX - t.retained.length, 0);
    assert.ok(scnNow.pool.length > slots, `pool ${scnNow.pool.length} for ${slots} slots`);
    assert.ok(scnNow.pool.every((id) => !world.players[id].team && !world.players[id].retired));
    const lots = scnNow.pool.map((id) => world.players[id].lot);
    assert.equal(new Set(lots).size, lots.length, 'unique lot numbers');
  }
  assert.equal(world.history.length, 3);
});

test('dynasty: players age a year and old players retire', () => {
  const world = startWorld(scn);
  const { a, s } = playSeason(world, scn, 'CSK', 7);
  const before = world.players['ms-dhoni'].age;
  const out = endSeason(world, { auction: a, season: s, userTeam: 'CSK', finish: '1st', seed: 7 });
  assert.equal(world.players['ms-dhoni'].age, before + 1);
  assert.ok(out.retired.length > 0, 'someone retired');
  assert.ok(out.retired.every((id) => world.players[id].age >= 31));
});

test('dynasty: released players can be bought back in the next auction', () => {
  const world = startWorld(scn);
  const { a, s } = playSeason(world, scn, 'DC', 9);
  endSeason(world, { auction: a, season: s, userTeam: 'DC', finish: '3rd', seed: 9 });
  const dc = teamPlayers(world, 'DC');
  const keep = dc.slice(0, 10);
  const retained = Object.fromEntries(scn.teams.map((t) => [t.id, t.id === 'DC' ? keep : suggestRetentions(world, t.id)]));
  applyRetentions(world, retained);
  buildAuction(world, scn.teams);
  const next = scenarioFromWorld(world, scn);
  assert.deepEqual(next.teamById.DC.retained.slice().sort(), keep.slice().sort());
  const released = dc.filter((id) => !keep.includes(id));
  assert.ok(released.some((id) => next.pool.includes(id)), 'released DC players are in the pool');
  const a2 = simulateRest(createAuction(next, { userTeam: 'DC', seed: 10 }), next);
  assert.equal(a2.phase, 'done');
  for (const t of Object.values(a2.teams)) assert.ok(t.squad.length >= 18 && t.squad.length <= 25, `${t.id} ${t.squad.length}`);
});
