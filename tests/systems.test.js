import { test, assert } from './harness.js';
import { loadScenario } from '../js/data.js';
import { createRng } from '../js/engine/rng.js';
import { createAuction, simulateRest, beginLot, placeBid, aiAct, rtmCandidate, useRtm, rtmRaise, rtmDecide, rtmSkipRaise } from '../js/engine/auction.js';
import { createSeason, playFixture, nextFixture, nextUserFixture, simToUserGame, autoLineup, carriedLineup, lineupProblem, repairLineup } from '../js/engine/season.js';
import { simulateMatch } from '../js/engine/match.js';
import { statusOf, matchMods, afterMatch, replacementPool, signReplacement, pendingReplacements, RULED_OUT, fitnessPenalty } from '../js/engine/status.js';
import { startWorld, endSeason, nextKind, suggestFor, applyRetentions, buildAuction, scenarioFromWorld, megaRetentionCost, megaRetentionProblem, worldFromRealSquads, retentionProblemFor, MEGA_SLABS } from '../js/engine/dynasty.js';

const s26 = await loadScenario('ipl-2026', '..');
const s25 = await loadScenario('ipl-2025', '..');

const playSeason = (scn, auction, user, seed, limit = 100) => {
  const squads = Object.fromEntries(Object.values(auction.teams).map((t) => [t.id, t.squad]));
  const s = createSeason(scn, squads, { userTeam: user, seed });
  let g = 0;
  while (s.stage !== 'done' && g++ < limit) playFixture(s, scn, nextFixture(s));
  return s;
};

// ---------- IPL 2025 mega auction ----------
test('2025 data: 575 players, 46 retentions, real purses and RTM cards', () => {
  assert.equal(s25.kind, 'mega');
  assert.equal(s25.pool.length, 575);
  assert.equal(s25.teams.reduce((n, t) => n + t.retained.length, 0), 46);
  assert.equal(s25.teamById.PBKS.purse, 11050);
  assert.equal(s25.teamById.PBKS.rtm, 4);
  assert.equal(s25.teamById.KKR.rtm, 0);
  assert.equal(s25.actual['rishabh-pant'].price, 2700);
});

test('2025 mega auction: full AI simulation fills legal squads and uses RTM cards', () => {
  const a = simulateRest(createAuction(s25, { userTeam: 'SRH', seed: 3 }), s25);
  assert.equal(a.phase, 'done');
  for (const t of Object.values(a.teams)) {
    assert.between(t.squad.length, 18, 25, `${t.id} ${t.squad.length}`);
    assert.ok(t.squad.filter((id) => s25.players[id].overseas).length <= 8);
    assert.ok(t.purse >= 0);
  }
  const spent = a.sold.reduce((n, x) => n + x.price, 0);
  assert.between(spent, 35000, 64000, `spent ${spent}`);
  const top = Math.max(...a.sold.map((x) => x.price));
  assert.between(top, 1400, 4000, `top ${top}`);
  assert.ok(a.sold.some((x) => x.rtm), 'at least one RTM used');
});

test('RTM: the previous team can match, the winner raises once, then the RTM team decides', () => {
  const a = createAuction(s25, { userTeam: 'PBKS', seed: 1 });
  // Arshdeep Singh was a PBKS player in 2024; PBKS has 4 RTM cards.
  a.queue = ['arshdeep-singh'];
  beginLot(a, s25);
  placeBid(a, s25, 'SRH');
  assert.equal(rtmCandidate(a, s25), 'PBKS');
  useRtm(a, s25, 'PBKS');
  rtmRaise(a, s25, 400);
  const res = rtmDecide(a, s25, true);
  assert.equal(res.team, 'PBKS');
  assert.equal(res.price, 400);
  assert.ok(res.rtm);
  assert.equal(a.teams.PBKS.rtm, 3);
});

test('RTM: declining after a raise lets the winner keep the player', () => {
  const a = createAuction(s25, { userTeam: 'PBKS', seed: 1 });
  a.queue = ['arshdeep-singh'];
  beginLot(a, s25);
  placeBid(a, s25, 'DC');
  useRtm(a, s25, 'PBKS');
  rtmRaise(a, s25, 300);
  const res = rtmDecide(a, s25, false);
  assert.equal(res.team, 'DC');
  assert.equal(a.teams.PBKS.rtm, 4);
});

test('RTM: without a raise, the RTM team gets the player at the matched price', () => {
  const a = createAuction(s25, { userTeam: 'PBKS', seed: 1 });
  a.queue = ['arshdeep-singh'];
  beginLot(a, s25);
  placeBid(a, s25, 'DC');
  useRtm(a, s25, 'PBKS');
  rtmSkipRaise(a);
  const res = rtmDecide(a, s25, true);
  assert.equal(res.team, 'PBKS');
  assert.equal(res.price, 200);
});

test('RTM: not available in a mini auction', () => {
  const a = createAuction(s26, { userTeam: 'CSK', seed: 1 });
  beginLot(a, s26);
  placeBid(a, s26, 'KKR');
  assert.equal(rtmCandidate(a, s26), null);
});

// ---------- dynasty cycle ----------
test('dynasty: 2026 and 2027 are mini auctions, 2028 is a mega auction', () => {
  const w = startWorld(s26);
  assert.equal(w.lastMega, 2025);
  w.year = 2027; assert.equal(nextKind(w), 'mini');
  w.year = 2028; assert.equal(nextKind(w), 'mega');
  const w25 = startWorld(s25);
  assert.equal(w25.lastMega, 2025);
});

test('mega retentions: at most 6, 5 capped, 2 uncapped, slab costs', () => {
  const w = startWorld(s26);
  const kkr = s26.teamById.CSK.retained;
  const capped = kkr.filter((id) => w.players[id].capped);
  assert.ok(megaRetentionProblem(w, capped.slice(0, 6)), 'six capped is too many');
  assert.equal(megaRetentionProblem(w, capped.slice(0, 5)), null);
  assert.equal(megaRetentionCost(w, capped.slice(0, 5)).total, MEGA_SLABS.reduce((a, b) => a + b, 0));
  const unc = kkr.filter((id) => !w.players[id].capped);
  assert.equal(megaRetentionCost(w, unc.slice(0, 2)).total, 800);
});

test('dynasty: a mega off-season builds marquee sets, RTM cards and legal squads', () => {
  const w = worldFromRealSquads(s26, { kind: 'mega', seed: 4 });
  assert.equal(nextKind(w), 'mega');
  const retained = Object.fromEntries(s26.teams.map((t) => [t.id, suggestFor(w, t.id)]));
  for (const [t, ids] of Object.entries(retained)) assert.equal(retentionProblemFor(w, ids), null, t);
  applyRetentions(w, retained);
  buildAuction(w, s26.teams);
  const scn = scenarioFromWorld(w, s26);
  assert.equal(scn.kind, 'mega');
  assert.equal(scn.players[scn.pool[0]].setCode, 'M1');
  for (const t of scn.teams) assert.equal(t.rtm, 6 - t.retained.length);
  const a = simulateRest(createAuction(scn, { userTeam: 'MI', seed: 5 }), scn);
  for (const t of Object.values(a.teams)) assert.between(t.squad.length, 18, 25, `${t.id} ${t.squad.length}`);
});

test('projected 2027: starts from the real 2026 squads with ages a year on', () => {
  const w = worldFromRealSquads(s26, { seed: 2 });
  assert.equal(w.year, 2027);
  assert.equal(nextKind(w), 'mini');
  assert.equal(w.players['cameron-green'].team, 'KKR');
  assert.equal(w.players['cameron-green'].price, 2520);
  assert.equal(w.players['ms-dhoni'].age, s26.players['ms-dhoni'].age + 1);
});

// ---------- form, fitness, chemistry, injuries ----------
const a26 = simulateRest(createAuction(s26, { userTeam: 'RCB', seed: 12 }), s26);

test('status: form, fitness and chemistry change through a season and feed match ratings', () => {
  const s = playSeason(s26, a26, 'RCB', 12, 30);
  const forms = Object.values(s.status).map((x) => x.form);
  assert.ok(forms.some((f) => f > 2) && forms.some((f) => f < -2), 'form moves both ways');
  const fits = Object.values(s.status).map((x) => x.fit);
  assert.ok(fits.some((f) => f < 95), 'fitness drops with workload');
  const chem = Object.values(s.chem).map((c) => c.value);
  assert.ok(new Set(chem.map(Math.round)).size > 2, 'chemistry differs between teams');
  const ids = s.squads.RCB;
  const mods = matchMods(s, 'RCB', ids);
  assert.ok(Object.values(mods).some((m) => m.bat !== 0));
  assert.ok(fitnessPenalty(50) < -5 && fitnessPenalty(90) === 0);
});

test('status: injuries happen, keep players out, and allow replacements', () => {
  let injured = 0, ruledOut = 0;
  for (const seed of [1, 2, 3]) {
    const s = playSeason(s26, a26, 'RCB', 40 + seed);
    injured += (s.injuryLog || []).length;
    ruledOut += s.replacements.length;
    for (const fx of s.fixtures.filter((f) => f.result && !f.result.noResult)) {
      for (const t of [fx.home, fx.away]) for (const id of fx.result.lineups[t].xi) assert.ok(!fx.result.lineups[t].unavailable?.includes(id));
    }
    // AI teams signed replacements; ruled-out players left their season squad.
    for (const r of s.replacements.filter((x) => x.team !== 'RCB')) {
      assert.ok(r.done);
      if (r.in) { assert.ok(s.squads[r.team].includes(r.in)); assert.ok(!s.squads[r.team].includes(r.out)); }
    }
  }
  assert.ok(injured >= 6, `injuries over 3 seasons: ${injured}`);
  assert.ok(ruledOut >= 1, `ruled out: ${ruledOut}`);
});

test('status: injured players are never picked', () => {
  const s = playSeason(s26, a26, 'RCB', 77, 25);
  const hurt = Object.entries(s.status).filter(([, st]) => st.inj > 0).map(([id]) => id);
  for (const t of Object.keys(s.squads)) {
    const l = autoLineup(s.squads[t], s26.players, 'balanced', { exclude: hurt });
    assert.ok(!l.xi.some((id) => hurt.includes(id)));
  }
});

test('replacement: fee capped at the injured player, overseas limit kept', () => {
  const s = playSeason(s26, a26, 'RCB', 5, 3);
  const out = s.squads.RCB.find((id) => s26.players[id].role === 'BAT');
  s.status[out].inj = RULED_OUT; s.replacements.push({ team: 'RCB', out, injury: 'Test', in: null, done: false });
  const pool = replacementPool(s, s26, 'RCB', out);
  assert.ok(pool.length > 0);
  const fee = s.prices[out] ?? s26.players[out].price ?? 30;
  assert.ok(pool.every((p) => (p.base ?? 30) <= Math.max(fee, 30)));
  signReplacement(s, s26, 'RCB', out, pool[0].id);
  assert.ok(s.squads.RCB.includes(pool[0].id) && !s.squads.RCB.includes(out));
  assert.equal(pendingReplacements(s, 'RCB').length, 0);
});

// ---------- lineups ----------
test('two impact players: one batter, one bowler, both from the bench', () => {
  const l = autoLineup(a26.teams.CSK.squad, s26.players);
  assert.ok(l.impact.bat && l.impact.bowl && l.impact.bat !== l.impact.bowl);
  assert.ok(!l.xi.includes(l.impact.bat) && !l.xi.includes(l.impact.bowl));
  assert.ok(s26.players[l.impact.bowl].bowl >= s26.players[l.impact.bat].bowl);
  assert.equal(lineupProblem(l, a26.teams.CSK.squad, s26.players), null);
  assert.ok(lineupProblem({ xi: l.xi, impact: { bat: l.xi[0], bowl: l.impact.bowl } }, a26.teams.CSK.squad, s26.players));
});

test('XI carry-over: the next match keeps the XI, swapping only unavailable players', () => {
  const squads = Object.fromEntries(Object.values(a26.teams).map((t) => [t.id, t.squad]));
  const s = createSeason(s26, squads, { userTeam: 'RCB', seed: 9 });
  const fx = simToUserGame(s, s26);
  const mine = { xi: autoLineup(s.squads.RCB, s26.players).xi.slice().reverse(), impact: autoLineup(s.squads.RCB, s26.players).impact };
  playFixture(s, s26, fx, mine);
  simToUserGame(s, s26);
  const next = carriedLineup(s, s26, 'balanced');
  assert.ok(next.carried);
  const hurt = mine.xi.filter((id) => statusOf(s, id).inj > 0);
  assert.equal(next.changes.length, hurt.length);
  const kept = next.lineup.xi.filter((id) => mine.xi.includes(id)).length;
  assert.equal(kept, 11 - hurt.length);
  // The user's own batting order is kept.
  assert.equal(next.lineup.xi.find((id) => !hurt.includes(id)), mine.xi.find((id) => !hurt.includes(id)));
});

test('repairLineup fills a gap with a bench player', () => {
  const sq = a26.teams.MI.squad;
  const l = autoLineup(sq, s26.players);
  const r = repairLineup(l, sq, s26.players, { exclude: [l.xi[0]] });
  assert.equal(r.lineup.xi.length, 11);
  assert.ok(!r.lineup.xi.includes(l.xi[0]));
  assert.equal(r.changes.length, 1);
});

// ---------- fast forward and bowling types ----------
import { fastForward, teamsInRunning, aiWillingBidders } from '../js/engine/auction.js';
import { BOWL_TYPES, typeOf, attackVariety } from '../js/engine/bowling.js';
import { simulateInnings } from '../js/engine/match.js';
import { adjustPlayers } from '../js/engine/conditions.js';

test('fast forward: the bidding war runs until two teams are left', () => {
  const a = createAuction(s26, { userTeam: 'MI', seed: 4 });
  a.queue = ['cameron-green'];
  beginLot(a, s26);
  const before = teamsInRunning(a, s26).length;
  assert.ok(before > 2, `${before} teams interested in Green`);
  const bids = fastForward(a, s26, { leave: 2 });
  assert.ok(bids > 0);
  assert.ok(teamsInRunning(a, s26).length <= 2, `left: ${teamsInRunning(a, s26).length}`);
  assert.ok(a.lot.bid > s26.players['cameron-green'].base);
});

test('bowling types: every bowler in the data has one', () => {
  for (const p of Object.values(s26.players)) if (p.bowl >= 55) assert.ok(BOWL_TYPES[p.bt], `${p.name} ${p.bt}`);
  assert.equal(s26.players['kuldeep-yadav'].bt, 'LWS');
  assert.equal(s26.players['mitchell-starc'].bt, 'LF');
  assert.equal(typeOf(s26.players['bhuvneshwar-kumar']).label, 'Right-arm medium');
});

test('bowling types: wrist spin takes more wickets and costs more than finger spin', () => {
  const bowlerOf = (bt) => ({ id: 'b', name: 'B', bat: 10, bowl: 75, bowlType: 'spin', bt, role: 'BOWL', pos: ['tail'] });
  const bats = Object.values(s26.players).filter((p) => p.role === 'BAT').slice(0, 11).map((p) => p.id);
  const run = (bt) => {
    const players = { ...s26.players, b: bowlerOf(bt) };
    const rng = createRng(3); let w = 0, r = 0;
    for (let i = 0; i < 300; i++) { const inn = simulateInnings(rng, { battingOrder: bats, bowlers: ['b'], fielders: ['b'], players, balls: 6 }); w += inn.wkts; r += inn.runs; }
    return { w, r };
  };
  const ls = run('LB'), ob = run('OB');
  assert.ok(ls.w > ob.w, `wickets LB ${ls.w} vs OB ${ob.w}`);
  assert.ok(ls.r > ob.r, `runs LB ${ls.r} vs OB ${ob.r}`);
});

test('bowling types: pitches help some types more than others', () => {
  const ids = ['kuldeep-yadav', 'axar-patel', 'trent-boult', 'bhuvneshwar-kumar'];
  const turn = adjustPlayers(s26.players, ids, 'turning'), green = adjustPlayers(s26.players, ids, 'green'), flat = adjustPlayers(s26.players, ids, 'flat');
  const gain = (adj, id) => adj[id].bowl - s26.players[id].bowl;
  assert.ok(gain(turn, 'axar-patel') > gain(turn, 'kuldeep-yadav'), 'finger spin gains more on a turner');
  assert.ok(gain(green, 'trent-boult') > gain(green, 'bhuvneshwar-kumar'), 'swing gains more on a green top');
  assert.ok(gain(flat, 'bhuvneshwar-kumar') < gain(flat, 'trent-boult'), 'medium pace suffers most on a flat deck');
});

test('bowling types: varied attacks score higher', () => {
  const P = { a: { bowl: 70, bt: 'RFM' }, b: { bowl: 70, bt: 'RFM' }, c: { bowl: 70, bt: 'RFM' }, d: { bowl: 70, bt: 'LFM' }, e: { bowl: 70, bt: 'LB' }, f: { bowl: 70, bt: 'RF' } };
  assert.ok(attackVariety(['d', 'e', 'f'], P) > attackVariety(['a', 'b', 'c'], P));
});

// ---------- fixtures, icons, specialists, archetypes ----------
import { generateFixtures } from '../js/engine/season.js';
import { ICONS, isIcon, suggestRetentions as suggestMini } from '../js/engine/dynasty.js';
import { styleEffect } from '../js/engine/batting.js';
import { roleBonus } from '../js/engine/bowling.js';

test('fixtures: champions host the opener, 7 home games each, no long home or away runs', () => {
  for (const seed of [1, 5, 9]) {
    const f = generateFixtures(s26.teams, seed, { champion: 'RCB', runnerUp: 'PBKS' });
    assert.equal(f[0].home, 'RCB');
    assert.equal(f[0].away, 'PBKS');
    for (const t of s26.teams) {
      const mine = f.filter((x) => x.home === t.id || x.away === t.id);
      assert.equal(mine.filter((x) => x.home === t.id).length, 7, `${t.id} home`);
      let run = 0, prev = null;
      for (const x of mine) { const h = x.home === t.id; run = h === prev ? run + 1 : 1; prev = h; assert.ok(run <= 3, `${t.id} run of ${run}`); }
    }
  }
});

test('fixtures: playoffs are at neutral venues', () => {
  const s = playSeason(s26, a26, 'RCB', 21);
  assert.ok(s.playoffs.every((p) => p.neutral && p.conditions === 'balanced'));
});

test('icons: Kohli and Bumrah are never released, even when the AI would let them go', () => {
  const w = startWorld(s26);
  w.year = 2027;
  for (const p of Object.values(w.players)) p.team = null;
  w.players['virat-kohli'].team = 'RCB'; w.players['virat-kohli'].price = 9999;   // absurd salary
  w.players['jasprit-bumrah'].team = 'MI'; w.players['jasprit-bumrah'].price = 9999;
  assert.ok(isIcon(w, 'virat-kohli') && isIcon(w, 'jasprit-bumrah'));
  assert.ok(suggestMini(w, 'RCB').includes('virat-kohli'));
  const retained = Object.fromEntries(s26.teams.map((t) => [t.id, []]));
  w.players['virat-kohli'].price = 1800; w.players['jasprit-bumrah'].price = 1800;
  applyRetentions(w, retained);   // nobody picked: icons stay anyway
  assert.equal(w.players['virat-kohli'].team, 'RCB');
  assert.equal(w.players['jasprit-bumrah'].team, 'MI');
  assert.ok(Object.keys(ICONS).length >= 10);
});

test('specialists: new-ball and death bowlers gain in their phase', () => {
  assert.ok(s26.players['jasprit-bumrah'].br.includes('death'));
  assert.equal(roleBonus(s26.players['trent-boult'], 'pp'), 4);
  assert.equal(roleBonus(s26.players['trent-boult'], 'death'), 0);
  assert.equal(roleBonus(s26.players['t-natarajan'], 'death'), 4);
});

test('archetypes: sloggers hit and get out more, anchors the reverse', () => {
  assert.equal(s26.players['vaibhav-sooryavanshi'].bs, 'slogger');
  assert.equal(s26.players['virat-kohli'].bs, 'anchor');
  const sl = styleEffect(s26.players['vaibhav-sooryavanshi'], 'mid', false);
  const an = styleEffect(s26.players['virat-kohli'], 'mid', false);
  assert.ok(sl.boundary > 1 && sl.wicket > 1);
  assert.ok(an.boundary < 1 && an.wicket < 1);
  assert.ok(styleEffect(s26.players['rinku-singh'], 'death', false).boundary > 1);
  assert.ok(styleEffect(s26.players['suryakumar-yadav'], 'mid', true).boundary > styleEffect(s26.players['suryakumar-yadav'], 'mid', false).boundary);
});

// ---------- trades ----------
import { tradeProblem, evaluateTrade, executeTrade, salaryOf } from '../js/engine/trades.js';

test('trades: legal swap moves players and settles purses at their fees', () => {
  const a = simulateRest(createAuction(s26, { userTeam: 'CSK', seed: 31 }), s26);
  const give = a.teams.CSK.squad.find((id) => s26.players[id].role === 'BOWL' && id !== 'ms-dhoni');
  const get = a.teams.KKR.squad.find((id) => s26.players[id].role === 'BOWL' && !['sunil-narine', 'rinku-singh'].includes(id) && s26.players[id].overseas === s26.players[give].overseas);
  const offer = { partner: 'KKR', give: [give], get: [get], cash: 0 };
  assert.equal(tradeProblem(a, s26, offer), null);
  const before = { csk: a.teams.CSK.purse, kkr: a.teams.KKR.purse };
  const fg = salaryOf(a, s26, give), fr = salaryOf(a, s26, get);
  // Sweeten until accepted so the swap itself is tested.
  const ev = evaluateTrade(a, s26, offer);
  if (!ev.accept) offer.cash = ev.cashNeeded;
  if (tradeProblem(a, s26, offer)) return;   // cannot afford the sweetener in this seed
  executeTrade(a, s26, offer);
  assert.ok(a.teams.CSK.squad.includes(get) && a.teams.KKR.squad.includes(give));
  assert.equal(a.teams.CSK.purse, before.csk + fg - fr - offer.cash);
  assert.equal(a.teams.KKR.purse, before.kkr - fg + fr + offer.cash);
  assert.equal(salaryOf(a, s26, get), fr, 'fee travels with the player');
});

test('trades: icons, squad limits and lopsided deals are refused', () => {
  const a = simulateRest(createAuction(s26, { userTeam: 'RR', seed: 32 }), s26);
  assert.ok(/icon/.test(tradeProblem(a, s26, { partner: 'RCB', give: [], get: ['virat-kohli'], cash: 0 })));
  const four = a.teams.RR.squad.filter((id) => id !== 'yashasvi-jaiswal').slice(0, 4);
  assert.ok(/At most 3/.test(tradeProblem(a, s26, { partner: 'MI', give: four, get: [], cash: 0 })));
  // Asking for a star for nothing is turned down.
  const star = a.teams.SRH.squad.filter((id) => id !== 'abhishek-sharma').sort((x, y) => s26.players[y].ovr - s26.players[x].ovr)[0];
  const small = a.teams.RR.squad.filter((id) => id !== 'yashasvi-jaiswal').sort((x, y) => s26.players[x].ovr - s26.players[y].ovr)[0];
  const offer = { partner: 'SRH', give: [small], get: [star], cash: 0 };
  if (!tradeProblem(a, s26, offer)) assert.ok(!evaluateTrade(a, s26, offer).accept);
});

import { worldTradeState, applyWorldTrade } from '../js/engine/trades.js';
test('pre-retention trades: players change teams in the world at their fees, icons stay put', () => {
  const w = startWorld(s26);
  const state = worldTradeState(w, 'SRH', s26.teams, 'easy');
  assert.ok(state.preRetention);
  assert.ok(/icon/.test(tradeProblem(state, { players: w.players }, { partner: 'RCB', give: [], get: ['virat-kohli'], cash: 0 })));
  const mine = state.teams.SRH.squad.filter((id) => !w.players[id].overseas && !isIconId(id)).sort((x, y) => w.players[y].ovr - w.players[x].ovr)[1];
  const theirs = state.teams.CSK.squad.filter((id) => !w.players[id].overseas && !isIconId(id)).sort((x, y) => w.players[x].ovr - w.players[y].ovr)[0];
  const offer = { partner: 'CSK', give: [mine], get: [theirs], cash: 0 };
  const scn = { players: w.players };
  assert.equal(tradeProblem(state, scn, offer), null);   // no 18-player minimum before retentions
  const fee = w.players[mine].price;
  assert.ok(evaluateTrade(state, scn, offer).accept, 'a good player for a weak one is accepted');
  executeTrade(state, scn, offer);
  applyWorldTrade(w, state);
  assert.equal(w.players[mine].team, 'CSK');
  assert.equal(w.players[mine].tradedFrom, 'SRH');
  assert.equal(w.players[theirs].team, 'SRH');
  assert.equal(w.players[mine].price, fee);
});
const isIconId = (id) => ['virat-kohli', 'jasprit-bumrah', 'ms-dhoni', 'ruturaj-gaikwad', 'abhishek-sharma'].includes(id);
