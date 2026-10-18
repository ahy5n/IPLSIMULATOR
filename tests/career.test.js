// Career mode: league rules, the shared player world, coaches, loyalty and trades.
import { test, assert } from './harness.js';
import { LEAGUES, activateLeague } from '../js/engine/league.js';
import { generateFixtures, createSeason, playFixture, nextFixture, standings } from '../js/engine/season.js';
import { simulateInnings, FORMAT } from '../js/engine/match.js';
import { createRng } from '../js/engine/rng.js';
import { SQUAD_MAX, OVERSEAS_MAX } from '../js/engine/rules.js';
import { XI_OVERSEAS_MAX, bestXI } from '../js/engine/squad.js';
import { moneyIn } from '../js/format.js';
import {
  createCareer, nextEvent, runEvent, eligible, leaguePlayers, teamSquad, willingness, tradeState, coachOf,
  isUserEvent, answer, takeJob, suggestTrades, USER, eventDate,
} from '../js/engine/career.js';
import { tradeProblem } from '../js/engine/trades.js';

const data = await (await fetch('../data/career/world.json', { cache: 'reload' })).json();
const fresh = (opts = {}) => createCareer(data, { league: 'ipl', team: 'SRH', seed: 5, ...opts });
const LGS = ['ipl', 'psl', 'sa20', 'hundred'];

test('leagues: each league switches squad limits, XI overseas, format and currency', () => {
  activateLeague('hundred');
  assert.equal(SQUAD_MAX, 18); assert.equal(OVERSEAS_MAX, 4); assert.equal(XI_OVERSEAS_MAX, 3);
  assert.equal(FORMAT.balls, 100); assert.equal(FORMAT.setBalls, 5);
  activateLeague('psl');
  assert.equal(SQUAD_MAX, 20); assert.equal(FORMAT.balls, 120);
  activateLeague('ipl');
  assert.equal(SQUAD_MAX, 25); assert.equal(XI_OVERSEAS_MAX, 4);
  // ₹125 Cr cap = PKR 50.5 Cr = R41m = £2.05m
  assert.equal(moneyIn(LEAGUES.psl.currency, 12500), 'PKR 50.5 Cr');
  assert.equal(moneyIn(LEAGUES.sa20.currency, 12500), 'R41m');
  assert.equal(moneyIn(LEAGUES.hundred.currency, 12500), '£2.05m');
});

test('fixtures: PSL 40 games (10 each), SA20 30 (10 each), Hundred 32 (8 each)', () => {
  const c = fresh();
  for (const [lg, total, each] of [['psl', 40, 10], ['sa20', 30, 10], ['hundred', 32, 8]]) {
    const f = generateFixtures(c.teams[lg], 3, { format: LEAGUES[lg].fixtures });
    assert.equal(f.length, total, `${lg} has ${f.length} games`);
    for (const t of c.teams[lg]) assert.equal(f.filter((x) => x.home === t.id || x.away === t.id).length, each, `${lg} ${t.id}`);
  }
  activateLeague('ipl');
});

test('The Hundred: 100-ball innings in sets of five, at most 20 balls a bowler', () => {
  const c = fresh();
  activateLeague('hundred');
  const P = leaguePlayers(c, 'hundred');
  const a = bestXI(teamSquad(c, 'hundred', 'MIL'), P), b = bestXI(teamSquad(c, 'hundred', 'TR'), P);
  for (let s = 1; s <= 20; s++) {
    const inn = simulateInnings(createRng(s), { battingOrder: a, bowlers: b.slice(-6), fielders: b, players: P });
    assert.ok(inn.balls <= 100, `${inn.balls} balls`);
    for (const bw of inn.bowling) assert.ok(bw.balls <= 20, `${bw.balls} balls for one bowler`);
  }
  activateLeague('ipl');
});

test('The Hundred season: top three, eliminator then a final against the league leaders', () => {
  const c = fresh();
  activateLeague('hundred');
  const P = leaguePlayers(c, 'hundred');
  const teams = c.teams.hundred.map((t) => ({ ...t, retained: teamSquad(c, 'hundred', t.id) }));
  const scn = { teams, players: P, teamById: Object.fromEntries(teams.map((t) => [t.id, t])), league: LEAGUES.hundred, pool: [] };
  const squads = Object.fromEntries(teams.map((t) => [t.id, t.retained]));
  const s = createSeason(scn, squads, { userTeam: null, seed: 9 });
  let g = 0;
  while (s.stage !== 'done' && g++ < 60) playFixture(s, scn, nextFixture(s));
  assert.equal(s.playoffs.length, 2);
  assert.equal(s.playoffs[1].stage, 'Final');
  assert.equal(s.playoffs[1].home, standings(s)[0].id);
  assert.ok(s.champion);
  activateLeague('ipl');
});

test('career start: real squads, no Indian players abroad, nobody in both the IPL and PSL', () => {
  const c = fresh();
  for (const lg of ['psl', 'sa20', 'hundred']) {
    assert.ok(!Object.keys(c.contracts[lg]).some((id) => c.players[id].country === 'India'), `Indian player in ${lg}`);
  }
  assert.ok(!Object.keys(c.contracts.psl).some((id) => c.contracts.ipl[id]), 'IPL and PSL contract at once');
  assert.equal(c.teams.psl.length, 8); assert.equal(c.teams.sa20.length, 6); assert.equal(c.teams.hundred.length, 8);
  assert.equal(coachOf(c, 'ipl', 'SRH').id, USER);
  assert.ok(!eligible(c, 'ipl', 'babar-azam'), 'Pakistani players are not picked in the IPL');
  assert.ok(!eligible(c, 'hundred', 'virat-kohli'));
});

test('calendar: events in date order; the IPL auction for 2027 falls in December 2026', () => {
  const c = fresh();
  assert.deepEqual(eventDate('ipl', 'auction', 2027), [2026, 12, 16]);
  assert.deepEqual(eventDate('hundred', 'season', 2027), [2027, 7, 21]);
  const keys = c.events.map((e) => e.date[0] * 10000 + e.date[1] * 100 + e.date[2]);
  assert.ok(keys.every((k, i) => i === 0 || k >= keys[i - 1]), 'events sorted');
  assert.ok(isUserEvent(c, c.events.find((e) => e.kind === 'retain' && e.lg === 'ipl')));
  assert.ok(!isUserEvent(c, c.events.find((e) => e.kind === 'retain' && e.lg === 'psl')));
});

test('loyalty: long service with a coach makes a player reluctant; history with the new coach pulls him', () => {
  const c = fresh();
  const id = teamSquad(c, 'psl', 'IU')[0];
  const p = c.players[id];
  p.loyal = 0.9; p.tenure.psl = { team: 'IU', seasons: 6 }; p.bonds[coachOf(c, 'psl', 'IU').id] = 6;
  const stay = willingness(c, 'psl', id, 'KRK');
  assert.ok(stay < -0.3, `settled player willingness ${stay}`);
  p.bonds[coachOf(c, 'psl', 'KRK').id] = 6;
  assert.ok(willingness(c, 'psl', id, 'KRK') > stay + 0.5, 'a coach he knows makes a move easier');
});

test('trades: a player who will not move blocks the deal', () => {
  const c = fresh({ league: 'psl', team: 'LQ' });
  const id = teamSquad(c, 'psl', 'IU').find((x) => c.players[x].ovr >= 60);
  const p = c.players[id];
  p.loyal = 1; p.tenure.psl = { team: 'IU', seasons: 8 }; p.bonds[coachOf(c, 'psl', 'IU').id] = 8;
  const { state, players } = tradeState(c, 'psl');
  const mine = teamSquad(c, 'psl', 'LQ').find((x) => !c.players[x].loyal || c.players[x].loyal < 0.5) || teamSquad(c, 'psl', 'LQ')[5];
  const why = tradeProblem(state, { players }, { partner: 'IU', give: [mine], get: [id], cash: 0 });
  assert.ok(/doesn't want to leave/.test(why || ''), `got: ${why}`);
  activateLeague('ipl');
});

test('coaches: a sacked coach is replaced; free-choice mode lets you take any job', () => {
  const c = fresh({ mode: 'free' });
  takeJob(c, 'hundred', 'WF');
  assert.equal(c.coaches[USER].jobs.hundred, 'WF');
  assert.equal(c.coaches[USER].jobs.ipl, 'SRH');
  assert.ok(!Object.values(c.coaches).some((x) => !x.user && x.jobs.hundred === 'WF'), 'old coach left');
  // One job per league: taking another Hundred job leaves Welsh Fire.
  takeJob(c, 'hundred', 'LS');
  assert.equal(c.coaches[USER].jobs.hundred, 'LS');
  assert.ok(coachOf(c, 'hundred', 'WF'), 'Welsh Fire found a new coach');
});

test('career: a year of all four leagues runs, squads stay within limits, offers can be answered', () => {
  const c = fresh({ league: 'sa20', team: 'PR', seed: 77 });
  c.coaches[USER].rep = 82;   // a big name: offers should come
  let guard = 0;
  while (c.date[0] < 2027 || c.date[1] < 9) { const ev = nextEvent(c); runEvent(c, ev); if (guard++ > 40) break; }
  for (const lg of LGS) {
    assert.ok(c.leagues[lg].history.length >= 2, `${lg} played a season`);
    activateLeague(lg);
    for (const t of c.teams[lg]) assert.ok(teamSquad(c, lg, t.id).length <= LEAGUES[lg].squad.max + 5, `${lg} ${t.id} squad size`);
  }
  activateLeague('ipl');
  const offer = c.inbox.find((m) => m.kind === 'offer');
  assert.ok(offer, 'a well-known coach gets job offers');
  if (!offer.answered) {
    answer(c, offer.id, true);
    assert.equal(c.coaches[USER].jobs[offer.lg], offer.team);
  }
});

test('trade ideas: suggestions are deals the other side accepts and that help you', () => {
  const c = fresh({ league: 'ipl', team: 'SRH' });
  const ideas = suggestTrades(c, 'ipl', { limit: 3 });
  for (const x of ideas) {
    assert.ok(x.ev.accept, 'other side accepts');
    assert.ok(x.ev.myStrengthGain > 0, 'your team gets stronger');
  }
  activateLeague('ipl');
});

test('ratings: each league reads on its own scale, and Babar Azam is the PSL\'s top-rated player', () => {
  const c = fresh();
  activateLeague('psl');
  const P = leaguePlayers(c, 'psl');
  const top = Object.keys(c.contracts.psl).sort((a, b) => P[b].ovr - P[a].ovr)[0];
  assert.equal(top, 'babar-azam', `top PSL player is ${P[top].name}`);
  assert.equal(P['babar-azam'].bat, Math.round(c.players['babar-azam'].bat + LEAGUES.psl.ratingOffset));
  activateLeague('ipl');
  const I = leaguePlayers(c, 'ipl');
  assert.equal(I['virat-kohli'].bat, c.players['virat-kohli'].bat, 'IPL ratings are the underlying scale');
});

test('calendar: the IPL\'s retentions, auction and season come before the PSL\'s; the SA20 off-season follows The Hundred', () => {
  const key = (d) => d[0] * 10000 + d[1] * 100 + d[2];
  for (const kind of ['retain', 'auction', 'season']) assert.ok(key(eventDate('ipl', kind, 2028)) < key(eventDate('psl', kind, 2028)), `IPL ${kind} first`);
  const hundredEnd = [2027, ...LEAGUES.hundred.calendar.seasonEnd];
  for (const kind of ['trade', 'retain', 'auction']) assert.ok(key(eventDate('sa20', kind, 2028)) > key(hundredEnd), `SA20 ${kind} after The Hundred`);
});

test('overseas: as each league registers players (Scots and UK passport holders are local in The Hundred)', () => {
  const c = fresh();
  activateLeague('hundred');
  const P = leaguePlayers(c, 'hundred');
  for (const id of ['scott-currie', 'sean-dickson', 'daniel-worrall', 'asa-tribe']) assert.ok(P[id] && !P[id].overseas, `${id} should be local`);
  for (const id of ['rashid-khan', 'heinrich-klaasen']) assert.ok(P[id].overseas, `${id} should be overseas`);
  for (const t of c.teams.hundred) {
    const os = teamSquad(c, 'hundred', t.id).filter((id) => P[id].overseas).length;
    assert.ok(os <= 4, `${t.id} has ${os} overseas`);
  }
  activateLeague('sa20');
  const S = leaguePlayers(c, 'sa20');
  assert.ok(S['jos-buttler'].overseas && !S['aiden-markram'].overseas);
  activateLeague('ipl');
});

test('data: nobody is listed twice in a league, and one player is one person across leagues', () => {
  const c = fresh();
  for (const lg of LGS) {
    const ids = Object.keys(c.contracts[lg]);
    assert.equal(new Set(ids).size, ids.length);
  }
  const names = {};
  for (const p of Object.values(c.players)) (names[p.name.toLowerCase()] ||= []).push(p.id);
  const dupes = Object.entries(names).filter(([, v]) => v.length > 1).map(([k]) => k);
  assert.deepEqual(dupes, ['abdul samad'], `same-name players: ${dupes.join(', ')}`);   // two real people
});

test('The Hundred auction: reserves £30k–£75k, bids in £5k steps', async () => {
  const { reserveFor } = await import('../js/engine/league.js');
  const { increment } = await import('../js/engine/rules.js');
  activateLeague('hundred');
  const rate = LEAGUES.hundred.currency.rate;
  const local = (x) => Math.round(x * rate);
  assert.equal(local(reserveFor('hundred', 5000, true)), 75);
  assert.equal(local(reserveFor('hundred', 10, false)), 30);
  assert.equal(local(increment(50 / rate)), 5);
  assert.equal(local(increment(300 / rate)), 25);
  activateLeague('ipl');
  assert.equal(increment(150), 10, 'IPL steps unchanged');
});
