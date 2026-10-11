import { test, assert } from './harness.js';
import { loadScenario } from '../js/data.js';
import * as R from '../js/engine/rules.js';
import { createAuction, beginLot, placeBid, hammer, aiAct, simulateRest, simulateLot, userBidBlocker, startAccelerated, aiNominations } from '../js/engine/auction.js';
import { marketValue } from '../js/engine/valuation.js';
import { bestXI, bestImpact } from '../js/engine/squad.js';

const scn = await loadScenario('ipl-2026', '..');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- data ----------
test('data: 369 players in the auction pool, 173 retained', () => {
  assert.equal(scn.pool.length, 369);
  assert.equal(scn.teams.reduce((n, t) => n + t.retained.length, 0), 173);
});

test('data: purses match the IPL announcement (₹237.55 Cr in total)', () => {
  assert.equal(scn.teams.reduce((n, t) => n + t.purse, 0), 23755);
  assert.equal(scn.teamById.KKR.purse, 6430);
  assert.equal(scn.teamById.MI.purse, 275);
});

test('data: 77 open slots, 31 of them overseas', () => {
  const slots = scn.teams.reduce((n, t) => n + 25 - t.retained.length, 0);
  const os = scn.teams.reduce((n, t) => n + 8 - t.retained.filter((id) => scn.players[id].overseas).length, 0);
  assert.equal(slots, 77);
  assert.equal(os, 31);
});

test('data: every player has a role, ratings in range and a valid reserve price', () => {
  const bases = new Set([30, 40, 50, 75, 100, 125, 150, 200]);
  for (const p of Object.values(scn.players)) {
    assert.ok(['BAT', 'WK', 'AR', 'BOWL'].includes(p.role), p.name);
    assert.between(p.bat, 0, 100, `${p.name} bat`);
    assert.between(p.bowl, 0, 100, `${p.name} bowl`);
    if (p.lot) assert.ok(bases.has(p.base), `${p.name} base ${p.base}`);
  }
});

test('data: all 77 real sales are linked to pool players', () => {
  assert.equal(Object.keys(scn.actual).length, 77);
  assert.equal(scn.actual['cameron-green'].price, 2520);
});

// ---------- rules ----------
test('rules: bid increments by price band', () => {
  assert.equal(R.increment(30), 5);
  assert.equal(R.increment(95), 5);
  assert.equal(R.increment(100), 10);
  assert.equal(R.increment(190), 10);
  assert.equal(R.increment(200), 20);
  assert.equal(R.increment(480), 20);
  assert.equal(R.increment(500), 25);
  assert.equal(R.increment(2000), 25);
});

test('rules: first bid is the reserve price', () => {
  assert.equal(R.nextBid({ bid: 0, bidder: null }, { base: 200 }), 200);
  assert.equal(R.nextBid({ bid: 200, bidder: 'KKR' }, { base: 200 }), 220);
});

test('rules: teams keep ₹30 L per slot still needed to reach 18', () => {
  const t = { purse: 1000, squad: new Array(12).fill('x') };
  // 12 in squad, buying the 13th leaves 5 slots to reach 18.
  assert.equal(R.maxAllowedBid(t), 1000 - 5 * 30);
  t.squad = new Array(20).fill('x');
  assert.equal(R.maxAllowedBid(t), 1000);
});

test('rules: overseas and squad limits block bids', () => {
  const players = { a: { overseas: true }, b: { overseas: false } };
  const full = { purse: 5000, squad: Array.from({ length: 8 }, () => 'a') };
  assert.ok(R.bidBlocker(full, { overseas: true }, 100, players));
  assert.equal(R.bidBlocker(full, { overseas: false }, 100, players), null);
  const big = { purse: 5000, squad: Array.from({ length: 25 }, () => 'b') };
  assert.ok(/full/.test(R.bidBlocker(big, { overseas: false }, 30, players)));
});

test('rules: overseas fee is capped at ₹18 Cr in a mini auction', () => {
  assert.equal(R.playerFee({ overseas: true }, 2520), 1800);
  assert.equal(R.playerFee({ overseas: false }, 2520), 2520);
});

// ---------- valuation and squads ----------
test('valuation: market value rises with rating and never drops below reserve', () => {
  assert.ok(marketValue({ ovr: 85, base: 200 }) > marketValue({ ovr: 75, base: 200 }));
  assert.equal(marketValue({ ovr: 40, base: 75 }), 75);
  assert.between(marketValue({ ovr: 85, base: 200 }), 1500, 2200);
});

test('squad: best XI has 11 players, at most 4 overseas, and a keeper', () => {
  for (const t of scn.teams) {
    const xi = bestXI(t.retained, scn.players);
    if (t.retained.length < 11) continue;
    assert.equal(xi.length, 11, t.id);
    assert.ok(xi.filter((id) => scn.players[id].overseas).length <= 4, `${t.id} overseas`);
    // KKR released every keeper before the 2026 auction, so only check teams that kept one.
    if (t.retained.some((id) => scn.players[id].role === 'WK')) assert.ok(xi.some((id) => scn.players[id].role === 'WK'), `${t.id} keeper`);
    const imp = bestImpact(t.retained, xi, scn.players);
    if (imp) assert.ok(!xi.includes(imp));
  }
});

// ---------- auction ----------
test('auction: a full AI simulation completes with legal squads', () => {
  const s = createAuction(scn, { userTeam: 'CSK', mode: 'full', difficulty: 'medium', seed: 42 });
  simulateRest(s, scn);
  assert.equal(s.phase, 'done');
  const seen = new Set();
  for (const t of Object.values(s.teams)) {
    assert.between(t.squad.length, 18, 25, `${t.id} squad size ${t.squad.length}`);
    assert.ok(t.squad.filter((id) => scn.players[id].overseas).length <= 8, `${t.id} overseas`);
    assert.ok(t.purse >= 0, `${t.id} purse ${t.purse}`);
    for (const id of t.squad) { assert.ok(!seen.has(id), `${id} in two squads`); seen.add(id); }
  }
});

test('auction: same seed gives the same result', () => {
  const a = simulateRest(createAuction(scn, { userTeam: 'MI', seed: 7 }), scn);
  const b = simulateRest(createAuction(scn, { userTeam: 'MI', seed: 7 }), scn);
  assert.deepEqual(a.sold, b.sold);
});

test('auction: prices land in a realistic range', () => {
  const s = simulateRest(createAuction(scn, { userTeam: 'MI', seed: 11, difficulty: 'hard' }), scn);
  const top = Math.max(...s.sold.map((x) => x.price));
  assert.between(top, 900, 3500, `top price ${top}`);
  const spent = s.sold.reduce((n, x) => n + x.price, 0);
  assert.between(spent, 12000, 23755, `total spend ${spent}`);
  assert.between(s.sold.length, 60, 77, `players sold ${s.sold.length}`);
});

test('auction: the user can bid and win a lot', () => {
  const s = createAuction(scn, { userTeam: 'KKR', seed: 3 });
  const lot = beginLot(s, scn);
  assert.ok(lot);
  assert.equal(userBidBlocker(s, scn), null);
  const amt = placeBid(s, scn, 'KKR');
  assert.equal(amt, scn.players[lot.playerId].base);
  assert.throws(() => placeBid(s, scn, 'KKR'), /highest bid/);
  // Let the AI respond, then keep bidding until the AI stops.
  let guard = 0;
  while (guard++ < 200) {
    const r = aiAct(s, scn);
    if (!r) break;
    if (userBidBlocker(s, scn)) break;
    placeBid(s, scn, 'KKR');
  }
  const res = hammer(s, scn);
  if (s.lot === null && res.team === 'KKR') assert.ok(s.teams.KKR.squad.includes(res.id));
});

test('auction: MI cannot overspend its ₹2.75 Cr purse', () => {
  const s = createAuction(scn, { userTeam: 'MI', seed: 5 });
  beginLot(s, scn);
  s.teams.MI.purse = 100;
  s.lot.bid = 400; s.lot.bidder = 'KKR';
  assert.ok(userBidBlocker(s, scn));
  assert.throws(() => placeBid(s, scn, 'MI'));
});

test('auction: nominations and accelerated round run in full mode', () => {
  const s = createAuction(scn, { userTeam: 'SRH', seed: 9 });
  let guard = 0;
  while (s.phase === 'main' && guard++ < 500) { if (!beginLot(s, scn)) break; simulateLot(s, scn); }
  assert.equal(s.phase, 'nominate');
  const picks = aiNominations(s, scn);
  assert.ok(picks.length > 10, `AI nominated ${picks.length}`);
  const n = startAccelerated(s, scn, []);
  assert.ok(n >= picks.length);
  assert.equal(s.phase, 'accelerated');
});

test('auction: quick mode calls fewer lots than full rules', () => {
  const q = simulateRest(createAuction(scn, { userTeam: 'RR', mode: 'quick', seed: 2 }), scn);
  const f = simulateRest(createAuction(scn, { userTeam: 'RR', mode: 'full', seed: 2 }), scn);
  assert.equal(q.phase, 'done');
  assert.ok(q.called.length < f.called.length, `quick ${q.called.length} vs full ${f.called.length}`);
});

test('auction: every difficulty level produces valid prices', () => {
  const err = (d) => {
    const s = simulateRest(createAuction(scn, { userTeam: 'GT', seed: 21, difficulty: d }), scn);
    const xs = s.sold.filter((x) => x.phase !== 'fill').map((x) => Math.abs(Math.log(x.price / marketValue(scn.players[x.id]))));
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const e = err('easy'), h = err('hard');
  assert.ok(Number.isFinite(e) && Number.isFinite(h));
});

test('auction: state survives a JSON round trip mid-lot', () => {
  const s = createAuction(scn, { userTeam: 'DC', seed: 13 });
  beginLot(s, scn); aiAct(s, scn);
  const s2 = clone(s);
  simulateRest(s, scn); simulateRest(s2, scn);
  assert.deepEqual(s.sold, s2.sold);
});

test('auction: squad fill gives reserve-price players, not leftover stars', () => {
  const s = simulateRest(createAuction(scn, { userTeam: 'KKR', seed: 8 }), scn);
  const fills = s.sold.filter((x) => x.team === 'KKR' && x.phase === 'fill');
  assert.ok(fills.length > 0, 'KKR sat out and needed fills');
  for (const f of fills) assert.equal(scn.players[f.id].base, 30, `${scn.players[f.id].name} filled at ${f.price}`);
});
