// Career mode: you are a head coach in a world of four leagues (IPL, PSL, SA20, The Hundred) that share
// one set of players. A calendar runs every league's retentions, auction, trade window and season in
// date order; the ones in leagues you coach are yours to play, the rest are simulated.
//
// The career object is plain JSON (it is the saved game):
//   date [y, m, d]           today
//   players { id: player }   ratings, age, personality (loyal 0..1), tenure per league, bonds with coaches
//   contracts { lg: { id: { team, price, since } } }   price in IPL-scale lakh (see league.js)
//   teams { lg: [team] }     coaches { id: coach }    leagues { lg: { lastFull, history } }
//   events [event]           inbox [item]             news [item]
//   fitness { id }, form { id }, yearStats { id }  carried between leagues
//
// Coaches have a reputation (0-100) and, for each job, the board's confidence (0-100). After every
// season boards compare results with what the squad should have achieved; coaches who fall short get
// sacked, and vacancies go to the best available coach, which can be you (job offers), or you can pick
// any job yourself ("free choice").
import { createRng, hash32 } from './rng.js';
import { LEAGUES, LEAGUE_IDS, GROUPS, RIVALS, activateLeague, leagueCap } from './league.js';
import { createAuction, simulateRest } from './auction.js';
import { createSeason, playFixture, nextFixture, standings, finalOf } from './season.js';
import { teamStrength } from './squad.js';
import { marketValue } from './valuation.js';
import { tradeProblem, evaluateTrade, executeTrade, isTradeIcon } from './trades.js';
import * as D from './dynasty.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const USER = 'you';
const KIND_ORDER = { develop: 0, trade: 1, retain: 2, auction: 3, season: 4 };

// ---------- dates ----------
export const dateKey = (d) => d[0] * 10000 + d[1] * 100 + d[2];
export const daysBetween = (a, b) => Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (d) => `${d[2]} ${MONTHS[d[1] - 1]} ${d[0]}`;
export const fmtMonth = (d) => `${MONTHS[d[1] - 1]} ${d[0]}`;

// The calendar date of a league event for a season year. Events in months after the season's start
// month belong to the previous calendar year (the IPL's December auction is for next year's season).
export function eventDate(lg, kind, year) {
  const cal = LEAGUES[lg].calendar;
  const [m, d] = cal[kind];
  return [m > cal.season[0] ? year - 1 : year, m, d];
}

// ---------- start ----------
function personality(p) {
  // Loyalty leaning from the player's id (stable), older players a little more settled.
  const h = (hash32(`loyal:${p.id}`) % 1000) / 1000;
  return clamp(0.15 + h * 0.7 + Math.max(0, (p.age ?? 26) - 30) * 0.03 + (D.ICONS[p.id] ? 0.35 : 0), 0, 1);
}

export function createCareer(data, { league, team, mode = 'offers', difficulty = 'medium', auctionMode = 'quick', seed = 1, name = 'You' }) {
  const date = data.date.split('-').map(Number);
  const players = {};
  for (const p of data.players) {
    players[p.id] = { ...p, br: p.br || [], pos: p.pos || ['middle'], loyal: 0, tenure: {}, bonds: {} };
    players[p.id].loyal = personality(players[p.id]);
  }
  const contracts = {};
  for (const lg of LEAGUE_IDS) {
    contracts[lg] = {};
    const rate = LEAGUES[lg].currency.rate;
    for (const [tid, rows] of Object.entries(data.contracts[lg])) {
      for (const r of rows) {
        // A player can't be under IPL and PSL contract at once (the seasons clash): the IPL deal stands.
        if (lg === 'psl' && Object.values(data.contracts.ipl).some((rs) => rs.some((x) => x.id === r.id))) continue;
        contracts[lg][r.id] = { team: tid, price: Math.max(LEAGUES[lg].minPrice, Math.round((r.price ?? 0) / rate)), since: 2026 };
      }
    }
  }
  const teams = {};
  for (const lg of LEAGUE_IDS) {
    teams[lg] = data.teams[lg].map((t) => ({
      ...t,
      group: GROUPS[lg] ? (GROUPS[lg].A.includes(t.id) ? 'A' : 'B') : null,
      rival: RIVALS[lg]?.[t.id] || null,
    }));
  }
  const coaches = {};
  for (const c of data.coaches) coaches[c.id] = { ...c, security: Object.fromEntries(Object.keys(c.jobs).map((lg) => [lg, 60])), history: [] };
  coaches[USER] = { id: USER, name, country: '', rep: 58, jobs: {}, security: {}, history: [], user: true };
  const leagues = {};
  for (const lg of LEAGUE_IDS) {
    const ch = data.champions[lg];
    leagues[lg] = { lastFull: LEAGUES[lg].cycle.last, history: [{ year: ch.year, champion: ch.champion, runnerUp: ch.runnerUp, real: true }] };
  }
  const career = {
    v: 1, seed, rngState: seed >>> 0, date, mode, difficulty, auctionMode,
    players, contracts, teams, coaches, leagues, events: [], inbox: [], news: [], fitness: {}, form: {}, yearStats: {},
    nextProspect: 1, nextId: 1, pending: null,
  };
  // Starting tenure and bonds: everyone has done at least a season with his current team and coach.
  for (const lg of LEAGUE_IDS) {
    for (const [id, c] of Object.entries(contracts[lg])) {
      const p = players[id];
      p.tenure[lg] = { team: c.team, seasons: 1 };
      const coach = coachOf(career, lg, c.team);
      if (coach) p.bonds[coach.id] = (p.bonds[coach.id] || 0) + 1;
    }
  }
  takeJob(career, league, team, { reason: 'start' });
  for (let y = date[0]; y <= date[0] + 2; y++) schedule(career, y);
  return career;
}

// ---------- calendar ----------
function addEvent(career, ev) {
  const id = `${ev.kind}:${ev.lg || 'all'}:${ev.year}`;
  if (career.events.some((e) => e.id === id)) return;
  if (dateKey(ev.date) < dateKey(career.date)) return;   // already happened in the real world
  career.events.push({ id, done: false, ...ev });
}

// Every event for the seasons that start in calendar year `y` (and their off-season before).
export function schedule(career, y) {
  for (const lg of LEAGUE_IDS) {
    for (const kind of ['trade', 'retain', 'auction', 'season']) {
      addEvent(career, { kind, lg, year: y, date: eventDate(lg, kind, y) });
    }
  }
  addEvent(career, { kind: 'develop', lg: null, year: y, date: [y, 10, 1] });
  career.events.sort((a, b) => dateKey(a.date) - dateKey(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export function nextEvent(career) { return career.events.find((e) => !e.done) || null; }
export function upcoming(career, n = 12) { return career.events.filter((e) => !e.done).slice(0, n); }

// Interactive events: the ones in a league you coach (retentions, auction, season).
export function isUserEvent(career, ev) {
  return !!ev.lg && ['retain', 'auction', 'season'].includes(ev.kind) && !!career.coaches[USER].jobs[ev.lg];
}

export function eventTitle(ev) {
  const L = ev.lg ? LEAGUES[ev.lg] : null;
  const label = { trade: 'trade window', retain: 'retentions', auction: 'auction', season: 'season' }[ev.kind];
  if (ev.kind === 'develop') return 'Player development and new prospects';
  if (ev.kind === 'season') return `${L.short} ${ev.year} season`;
  return `${L.short} ${ev.year} ${label}`;
}

// ---------- helpers ----------
const withRng = (career, fn) => {
  const rng = createRng(career.rngState);
  const out = fn(rng);
  career.rngState = rng.state;
  return out;
};
export const isRetired = (p) => !!p.retired;
export function coachOf(career, lg, teamId) { return Object.values(career.coaches).find((c) => c.jobs[lg] === teamId) || null; }
export function teamSquad(career, lg, teamId) { return Object.entries(career.contracts[lg]).filter(([, c]) => c.team === teamId).map(([id]) => id); }
export function contractOf(career, lg, id) { return career.contracts[lg][id] || null; }
const news = (career, item) => {
  career.news.unshift({ date: career.date.slice(), ...item });
  career.news.sort((a, b) => dateKey(b.date) - dateKey(a.date));
  career.news = career.news.slice(0, 120);
};
const inbox = (career, item) => { career.inbox.unshift({ id: `m${career.nextId++}`, date: career.date.slice(), ...item }); };

// Can this player sign in this league now? Pakistani players are not picked in the IPL, the BCCI does
// not release Indian players for overseas leagues, and the IPL and PSL seasons overlap, so nobody holds
// both contracts.
export function eligible(career, lg, id) {
  const p = career.players[id];
  if (!p || p.retired) return false;
  if (lg !== 'ipl' && p.country === 'India') return false;
  if (lg === 'ipl' && p.country === 'Pakistan') return false;
  if (lg === 'ipl' && career.contracts.psl[id]) return false;
  if (lg === 'psl' && career.contracts.ipl[id]) return false;
  return true;
}

// The players one league sees: copies with `team`, `price` and `overseas` from this league's point of view.
// Players who can't sign here (and aren't already here) are left out.
export function leaguePlayers(career, lg) {
  const L = LEAGUES[lg];
  const out = {};
  for (const [id, p] of Object.entries(career.players)) {
    const c = career.contracts[lg][id];
    if (!c && !eligible(career, lg, id)) continue;
    const country = p.country === 'Wales' ? 'England' : p.country;
    // Ratings on this league's scale (see league.js).
    const off = L.ratingOffset || 0;
    const bat = Math.min(99, Math.round(p.bat + off)), bowl = Math.min(99, Math.round(p.bowl + off));
    out[id] = { ...p, bat, bowl, ovr: off ? D.overall(p.role, bat, bowl) : p.ovr, overseas: country !== L.home, team: c ? c.team : null, price: c ? c.price : null, releasedBy: p.releasedBy?.[lg] || null };
  }
  return out;
}

// A dynasty-style world for one league (the rules in dynasty.js work on it), for a season `year`.
export function leagueWorld(career, lg, year) {
  const L = LEAGUES[lg];
  const st = career.leagues[lg];
  const hist = st.history;
  return {
    league: lg, year, players: leaguePlayers(career, lg), history: hist, current: null, nextProspect: 1,
    lastMega: st.lastFull, cycle: L.cycle.every, megaMax: L.cycle.megaMax, forceKind: null,
    cap: lg === 'ipl' ? D.purseCap(year) : leagueCap(lg, year),
  };
}

export function leagueBase(career, lg) {
  const teams = career.teams[lg].map((t) => ({ ...t, retained: teamSquad(career, lg, t.id) }));
  return { id: lg, teams, teamById: Object.fromEntries(teams.map((t) => [t.id, t])) };
}

// Scenario (the shape the auction and season engines take) for a league view.
export function leagueScenario(career, lg, w) {
  const base = leagueBase(career, lg);
  const last = career.leagues[lg].history[career.leagues[lg].history.length - 1];
  const scn = w.current ? D.scenarioFromWorld(w, base) : {
    id: lg, year: w.year, kind: 'mini', cap: w.cap, players: w.players, teams: base.teams, pool: [], actual: {},
    teamById: base.teamById, champion: last?.champion || null, runnerUp: last?.runnerUp || null,
  };
  scn.league = LEAGUES[lg];
  scn.lg = lg;
  scn.champion = last?.champion || null; scn.runnerUp = last?.runnerUp || null;
  return scn;
}

// Write a league view's teams and fees back into the career's contracts.
function commitWorld(career, lg, w, year) {
  const C = career.contracts[lg];
  for (const [id, p] of Object.entries(w.players)) {
    const before = C[id];
    if (p.team) {
      C[id] = { team: p.team, price: p.price ?? before?.price ?? LEAGUES[lg].minPrice, since: before && before.team === p.team ? before.since : year };
    } else if (before) {
      delete C[id];
      const cp = career.players[id];
      cp.releasedBy = { ...(cp.releasedBy || {}), [lg]: before.team };
    }
  }
}

// ---------- off-season: retentions ----------
// Returns { world, base, kind, suggested } for the retention screen (or the AI).
export function beginRetain(career, ev) {
  activateLeague(ev.lg);
  const w = leagueWorld(career, ev.lg, ev.year);
  return { world: w, base: leagueBase(career, ev.lg), kind: D.nextKind(w) };
}

export function finishRetain(career, ev, w, userIds = null) {
  activateLeague(ev.lg);
  const me = career.coaches[USER].jobs[ev.lg];
  const retained = {};
  for (const t of career.teams[ev.lg]) {
    retained[t.id] = t.id === me && userIds ? userIds : D.suggestFor(w, t.id);
    // Loyal players who are not kept stay unhappy with the team (they're less likely to come back).
  }
  D.applyRetentions(w, retained);
  if (D.nextKind(w) === 'mega') career.leagues[ev.lg].lastFull = ev.year;
  career.leagues[ev.lg].rtm = w.rtm || {};
  commitWorld(career, ev.lg, w, ev.year);
  const released = Object.values(w.players).filter((p) => p.releasedBy && !p.team && p.ovr >= 75).sort((a, b) => b.ovr - a.ovr).slice(0, 4);
  if (released.length) news(career, { lg: ev.lg, text: `${LEAGUES[ev.lg].short} retentions: ${released.map((p) => `${p.name} (${p.releasedBy})`).join(', ')} released.` });
  ev.done = true;
}

// ---------- auction ----------
// Builds the auction for a league. Returns { scn, state }. The pool and lot order are stored on
// career.pending so a saved game can rebuild the same scenario.
export function beginAuction(career, ev, { userTeam = null } = {}) {
  activateLeague(ev.lg);
  const w = leagueWorld(career, ev.lg, ev.year);
  if (career.leagues[ev.lg].lastFull === ev.year) w.forceKind = 'mega';   // retentions this year were the capped kind
  else w.forceKind = 'mini';
  w.rtm = career.leagues[ev.lg].rtm || {};
  const cur = D.buildAuction(w, career.teams[ev.lg]);
  // Keep the pool to a sensible size for the open slots.
  const open = cur.teams.reduce((n, t) => n + Math.max(0, LEAGUES[ev.lg].squad.max - t.retained.length), 0);
  cur.pool = cur.pool.slice(0, Math.max(60, open * 4));
  const scn = leagueScenario(career, ev.lg, w);
  scn.pool = cur.pool.slice();
  const meta = Object.fromEntries(cur.pool.map((id) => [id, { base: w.players[id].base, set: w.players[id].set, setCode: w.players[id].setCode, lot: w.players[id].lot, prevTeam: w.players[id].prevTeam }]));
  // Your auctions use your chosen rules; simulated ones always run the full process.
  const mode = userTeam ? career.auctionMode : 'full';
  const state = createAuction(scn, { userTeam, mode, difficulty: career.difficulty, seed: (career.seed + hash32(ev.id)) >>> 0 });
  // Head coaches bid harder for players they've worked with before.
  state.affinity = {};
  for (const t of career.teams[ev.lg]) {
    const coach = coachOf(career, ev.lg, t.id);
    if (coach) state.affinity[t.id] = cur.pool.filter((id) => (career.players[id].bonds[coach.id] || 0) >= 2);
  }
  career.pending = { ev: ev.id, kind: 'auction', lg: ev.lg, current: { year: cur.year, kind: cur.kind, teams: cur.teams, mainLastSet: cur.mainLastSet }, meta };
  return { scn, state };
}

// Rebuild the auction scenario after loading a saved game.
export function auctionScenario(career) {
  const pd = career.pending;
  activateLeague(pd.lg);
  const w = leagueWorld(career, pd.lg, pd.current.year);
  for (const [id, m] of Object.entries(pd.meta)) Object.assign(w.players[id] || {}, m);
  w.current = { ...pd.current, pool: Object.keys(pd.meta).sort((a, b) => pd.meta[a].lot - pd.meta[b].lot) };
  const scn = leagueScenario(career, pd.lg, w);
  scn.pool = w.current.pool.slice();
  return scn;
}

export function finishAuction(career, ev, state) {
  activateLeague(ev.lg);
  const C = career.contracts[ev.lg];
  for (const t of Object.values(state.teams)) {
    // New signings at their auction price; anyone traded after the hammer moves with his fee.
    const fee = Object.fromEntries(t.bought.map((b) => [b.id, b.price]));
    for (const id of t.squad) {
      const before = C[id];
      C[id] = { team: t.id, price: fee[id] ?? before?.price ?? LEAGUES[ev.lg].minPrice, since: before && before.team === t.id ? before.since : ev.year };
    }
  }
  fillShortSquads(career, ev.lg, ev.year);
  const top = state.sold.slice().sort((a, b) => b.price - a.price).slice(0, 3);
  if (top.length) news(career, { lg: ev.lg, text: `${LEAGUES[ev.lg].short} auction: ${top.map((s) => `${career.players[s.id].name} to ${s.team}`).join(', ')} were the biggest buys.`, money: top.map((s) => s.price) });
  career.pending = null;
  ev.done = true;
}

// ---------- season ----------
export function beginSeason(career, ev, { userTeam = null } = {}) {
  activateLeague(ev.lg);
  const lg = ev.lg;
  const w = leagueWorld(career, lg, ev.year);
  const scn = leagueScenario(career, lg, w);
  const squads = Object.fromEntries(career.teams[lg].map((t) => [t.id, teamSquad(career, lg, t.id)]));
  // Over-size squads (old contracts) are trimmed to the league maximum, weakest first.
  for (const [t, sq] of Object.entries(squads)) {
    if (sq.length > LEAGUES[lg].squad.max) squads[t] = sq.sort((a, b) => scn.players[b].ovr - scn.players[a].ovr).slice(0, LEAGUES[lg].squad.max);
  }
  const prices = Object.fromEntries(Object.entries(career.contracts[lg]).map(([id, c]) => [id, c.price]));
  const continuity = Object.fromEntries(Object.entries(squads).map(([t, sq]) => [t, sq.filter((id) => (career.players[id].tenure[lg]?.team === t)).length / Math.max(1, sq.length)]));
  scn.pool = Object.keys(scn.players).filter((id) => !scn.players[id].team);
  for (const id of scn.pool) scn.players[id].base = scn.players[id].base ?? LEAGUES[lg].minPrice;
  const season = createSeason(scn, squads, { userTeam, seed: (career.seed + hash32(ev.id)) >>> 0, prices, continuity });
  // Carried over from other leagues: fitness (recovering since the player's last game) and some form.
  for (const sq of Object.values(squads)) for (const id of sq) {
    const st = season.status[id];
    st.fit = fitnessAt(career, id, ev);
    st.form = clamp((career.form[id] || 0) * 0.5, -5, 5);
  }
  // A respected coach settles a dressing room.
  for (const t of career.teams[lg]) {
    const coach = coachOf(career, lg, t.id);
    if (coach) season.chem[t.id].value = clamp(season.chem[t.id].value + (coach.rep - 65) * 0.15, 30, 85);
  }
  // What each squad should achieve, for the board's verdict at the end.
  const strengths = Object.entries(squads).map(([t, sq]) => [t, teamStrength(sq, scn.players).overall]).sort((a, b) => b[1] - a[1]);
  season.expected = Object.fromEntries(strengths.map(([t], i) => [t, i + 1]));
  season.lg = lg; season.year = ev.year;
  career.pending = { ev: ev.id, kind: 'season', lg };
  return { scn, season };
}

export function seasonScenario(career) {
  const pd = career.pending;
  const ev = career.events.find((e) => e.id === pd.ev);
  activateLeague(pd.lg);
  const w = leagueWorld(career, pd.lg, ev.year);
  const scn = leagueScenario(career, pd.lg, w);
  scn.pool = Object.keys(scn.players).filter((id) => !scn.players[id].team);
  for (const id of scn.pool) scn.players[id].base = scn.players[id].base ?? LEAGUES[pd.lg].minPrice;
  return scn;
}

// Fitness at the start of a season: back to full over about seven weeks of rest, but players on their
// third league in twelve months start a little short (workload).
export function fitnessAt(career, id, ev) {
  const f = career.fitness[id];
  if (!f) return 100;
  const rest = Math.max(0, daysBetween(f.date, ev.date));
  const leagues = new Set((career.players[id].played || []).filter((x) => daysBetween(x.date, ev.date) <= 365).map((x) => x.lg)).size;
  const cap = 100 - Math.max(0, leagues - 1) * 6;
  return Math.round(clamp(f.fit + rest * 0.7, 0, cap));
}

// Finish position: 1 champion, 2 runner-up, then playoff losers and the rest by league table.
function finishOrder(season) {
  const table = standings(season).map((r) => r.id);
  const fin = finalOf(season);
  const order = [];
  if (season.champion) order.push(season.champion);
  if (fin?.result) order.push(fin.result.winner === fin.home ? fin.away : fin.home);
  for (const t of table) if (!order.includes(t)) order.push(t);
  return order;
}

export function finishSeason(career, ev, season, scn) {
  const lg = ev.lg;
  const order = finishOrder(season);
  const st = career.leagues[lg];
  const fin = finalOf(season);
  const me = career.coaches[USER].jobs[lg] || null;
  const myPos = me ? order.indexOf(me) + 1 : null;
  st.history.push({
    year: ev.year, champion: season.champion, runnerUp: order[1], table: order, userTeam: me, finish: myPos,
    orange: season.awards?.orange ? { id: season.awards.orange.id, r: season.awards.orange.r } : null,
    purple: season.awards?.purple ? { id: season.awards.purple.id, w: season.awards.purple.w } : null,
  });
  ev.done = true;   // before the board review, so job offers point at the next event, not this one
  const end = eventDateEnd(lg, ev.year);
  news(career, { lg, date: end, text: `${scn.teamById[season.champion].name} won the ${LEAGUES[lg].short} ${ev.year}${fin?.result ? `, beating ${scn.teamById[order[1]].name} in the final` : ''}.` });
  // Carry fitness, form and the year's numbers into the rest of the calendar.
  for (const [id, s] of Object.entries(season.status || {})) {
    career.fitness[id] = { fit: s.fit, date: end };
    career.form[id] = s.form;
  }
  for (const [id, x] of Object.entries(season.stats)) {
    const y = career.yearStats[id] || (career.yearStats[id] = { m: 0, inns: 0, r: 0, b: 0, w: 0, bb: 0, rc: 0 });
    for (const k of Object.keys(y)) y[k] += x[k] || 0;
    const p = career.players[id];
    p.played = (p.played || []).filter((q) => daysBetween(q.date, end) <= 400).concat({ lg, date: end });
  }
  // Tenure and coach bonds grow with every season played together.
  for (const t of career.teams[lg]) {
    const coach = coachOf(career, lg, t.id);
    for (const id of season.squads[t.id]) {
      const p = career.players[id];
      const ten = p.tenure[lg];
      p.tenure[lg] = ten && ten.team === t.id ? { team: t.id, seasons: ten.seasons + 1 } : { team: t.id, seasons: 1 };
      if (coach) p.bonds[coach.id] = (p.bonds[coach.id] || 0) + 1;
    }
  }
  boardReview(career, lg, season, order);
  withRng(career, (rng) => approaches(career, lg, myPos, rng));
  career.pending = null;
  ev.done = true;
  return { order, myPos };
}

function eventDateEnd(lg, year) {
  const cal = LEAGUES[lg].calendar;
  return [cal.seasonEnd[0] < cal.season[0] ? year + 1 : year, cal.seasonEnd[0], cal.seasonEnd[1]];
}

// ---------- coaches: board reviews, sackings and the job market ----------
function boardReview(career, lg, season, order) {
  const n = order.length;
  withRng(career, (rng) => {
    for (const t of career.teams[lg]) {
      const coach = coachOf(career, lg, t.id);
      if (!coach) continue;
      const actual = order.indexOf(t.id) + 1;
      const expected = season.expected?.[t.id] ?? Math.ceil(n / 2);
      const delta = expected - actual;   // positive = did better than the squad suggested
      const won = actual === 1, final = actual === 2;
      const sec = (coach.security[lg] ?? 60) + delta * 5 + (won ? 25 : 0) + (final ? 10 : 0) + (actual === n ? -8 : 0);
      coach.security[lg] = clamp(Math.round(sec), 0, 100);
      coach.rep = clamp(Math.round((coach.rep + delta * 0.8 + (won ? 4 : 0) + (final ? 2 : 0)) * 10) / 10, 30, 97);
      coach.history.push({ lg, team: t.id, year: season.year, finish: actual });
      const sacked = coach.security[lg] < 20 || (coach.security[lg] < 32 && !coach.user && rng.next() < 0.25);
      if (sacked) {
        leaveJob(career, coach, lg, { fired: true });
        news(career, { lg, text: `${t.name} have sacked ${coach.user ? 'you' : coach.name} after finishing ${ordinalText(actual)}.` });
        if (coach.user) inbox(career, { kind: 'fired', lg, team: t.id, text: `${t.name} have let you go after finishing ${ordinalText(actual)}. Your reputation takes a knock, but other boards will still call.` });
        if (coach.user) coach.rep = clamp(coach.rep - 3, 30, 97);
      } else if (!coach.user && rng.next() < 0.06) {
        leaveJob(career, coach, lg, { fired: false });
        news(career, { lg, text: `${coach.name} has stepped down at ${t.name}.` });
      }
    }
    fillVacancies(career, lg, rng);
  });
}

const ordinalText = (n) => n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

function leaveJob(career, coach, lg, { fired }) {
  const team = coach.jobs[lg];
  delete coach.jobs[lg];
  delete coach.security[lg];
  if (fired) coach.firedFrom = { ...(coach.firedFrom || {}), [`${lg}:${team}`]: career.date[0] };
}

// A team's standing: its recent finishes (champions count most).
export function teamPrestige(career, lg, teamId) {
  const recent = career.leagues[lg].history.slice(-4);
  let s = 50;
  for (const h of recent) {
    if (h.champion === teamId) s += 12;
    else if (h.runnerUp === teamId) s += 6;
    else if (h.table && h.table.indexOf(teamId) >= 0 && h.table.indexOf(teamId) < 4) s += 2;
  }
  return s;
}

function fillVacancies(career, lg, rng) {
  const vacant = career.teams[lg].filter((t) => !coachOf(career, lg, t.id)).sort((a, b) => teamPrestige(career, lg, b.id) - teamPrestige(career, lg, a.id));
  const you = career.coaches[USER];
  for (const t of vacant) {
    const recentlyFired = (c) => (c.firedFrom?.[`${lg}:${t.id}`] ?? -99) >= career.date[0] - 2;
    const pool = Object.values(career.coaches).filter((c) => !c.user && !c.jobs[lg] && !recentlyFired(c));
    const scored = pool.map((c) => ({ c, s: c.rep + rng.normal(0, 4) })).sort((a, b) => b.s - a.s);
    const best = scored[0];
    // You're offered the job if you have none in this league and your reputation meets the bar for this
    // club: bigger clubs in bigger leagues want proven coaches. Out-of-work coaches lower their sights.
    const jobless = !Object.keys(you.jobs).length;
    const yourScore = you.rep + rng.normal(0, 4) + (jobless ? 8 : 0);
    const canOffer = career.mode === 'offers' && !you.jobs[lg] && !recentlyFired(you) && yourScore >= requiredRep(career, lg, t.id);
    const interim = best?.c || null;
    if (canOffer) {
      const expires = nextLeagueEvent(career, lg)?.date || null;
      inbox(career, { kind: 'offer', lg, team: t.id, text: `${t.name} want you as head coach for ${LEAGUES[lg].short}.`, expires, interim: interim?.id || null });
      news(career, { lg, text: `${t.name} are looking for a new head coach.` });
      continue;   // the job is held open until you answer
    }
    if (interim) appoint(career, interim, lg, t.id);
  }
}

// The reputation a club wants in its next coach.
export function requiredRep(career, lg, teamId) {
  return 48 + (teamPrestige(career, lg, teamId) - 50) * 0.5 + (LEAGUES[lg].prestige - 70) * 0.35;
}

// After a strong season, ambitious owners elsewhere come calling, even with a coach in place.
function approaches(career, lg, myPos, rng) {
  const you = career.coaches[USER];
  if (career.mode !== 'offers' || !myPos || myPos > 2) return;
  if (rng.next() > (myPos === 1 ? 0.7 : 0.4)) return;
  const options = [];
  for (const other of LEAGUE_IDS) {
    if (you.jobs[other]) continue;
    for (const t of career.teams[other]) {
      const coach = coachOf(career, other, t.id);
      if ((coach?.security[other] ?? 0) < 65 && you.rep + 6 >= requiredRep(career, other, t.id)) options.push({ lg: other, t });
    }
  }
  if (!options.length) return;
  const { lg: other, t } = rng.pick(options);
  inbox(career, { kind: 'offer', lg: other, team: t.id, approach: true, text: `${t.name} (${LEAGUES[other].short}) want you as their head coach after your ${myPos === 1 ? 'title' : 'run to the final'} with ${career.teams[lg].find((x) => x.id === you.jobs[lg])?.name}.`, expires: nextLeagueEvent(career, other)?.date || null });
}

function nextLeagueEvent(career, lg) { return career.events.find((e) => !e.done && e.lg === lg && e.kind !== 'trade') || null; }

function appoint(career, coach, lg, teamId) {
  // Moving within a league leaves the old job open.
  if (coach.jobs[lg] && coach.jobs[lg] !== teamId) leaveJob(career, coach, lg, { fired: false });
  coach.jobs[lg] = teamId;
  coach.security[lg] = coach.user ? 65 : 60;
  const team = career.teams[lg].find((t) => t.id === teamId);
  if (!coach.user) news(career, { lg, text: `${team.name} have appointed ${coach.name} as head coach.` });
}

// Take a job: at the start, by accepting an offer, or by choice in free-choice mode.
export function takeJob(career, lg, teamId, { reason = 'offer' } = {}) {
  const you = career.coaches[USER];
  const displaced = coachOf(career, lg, teamId);
  if (displaced && !displaced.user) leaveJob(career, displaced, lg, { fired: false });
  const old = you.jobs[lg];
  appoint(career, you, lg, teamId);
  const team = career.teams[lg].find((t) => t.id === teamId);
  if (reason !== 'start') news(career, { lg, text: `You are the new head coach of ${team.name}${old ? `, leaving ${career.teams[lg].find((t) => t.id === old).name}` : ''}.` });
  if (old && old !== teamId) withRng(career, (rng) => fillVacancies(career, lg, rng));
  if (displaced && reason !== 'start') withRng(career, () => {});
}

export function quitJob(career, lg) {
  const you = career.coaches[USER];
  const team = career.teams[lg].find((t) => t.id === you.jobs[lg]);
  leaveJob(career, you, lg, { fired: false });
  news(career, { lg, text: `You have left ${team.name}.` });
  withRng(career, (rng) => fillVacancies(career, lg, rng));
}

// Answer an inbox item (job offer or trade offer).
export function answer(career, itemId, accept) {
  const item = career.inbox.find((m) => m.id === itemId);
  if (!item || item.answered) return null;
  item.answered = accept ? 'accepted' : 'declined';
  if (item.kind === 'offer') {
    if (accept) {
      if (career.pending?.lg === item.lg) throw new Error(`Finish the ${LEAGUES[item.lg].short} ${career.pending.kind} first`);
      takeJob(career, item.lg, item.team);
    } else {
      const interim = item.interim && career.coaches[item.interim];
      if (interim && !interim.jobs[item.lg] && !coachOf(career, item.lg, item.team)) appoint(career, interim, item.lg, item.team);
      else if (!coachOf(career, item.lg, item.team)) withRng(career, (rng) => fillVacancies(career, item.lg, rng));
    }
  }
  if (item.kind === 'trade' && accept) {
    const st = tradeState(career, item.lg);
    const scn = { players: st.players };
    const offer = { partner: item.partner, give: item.give, get: item.get, cash: item.cash || 0 };
    const why = tradeProblem(st.state, scn, offer);
    if (why) { item.answered = 'lapsed'; throw new Error(`The deal is off: ${why}`); }
    executeTrade(st.state, scn, { ...offer, force: true });
    commitTrade(career, item.lg, st.state, offer, st.players);
  }
  return item;
}

// Offers you haven't answered by their deadline are declined.
function expireInbox(career) {
  for (const m of career.inbox) {
    if (m.answered || !m.expires || dateKey(m.expires) > dateKey(career.date)) continue;
    try { answer(career, m.id, false); } catch { /* ignore */ }
    m.answered = 'expired';
  }
}

// Free-choice mode: every job you could take now (not mid-season in that league).
export function jobMarket(career) {
  const out = [];
  for (const lg of LEAGUE_IDS) {
    if (career.pending?.lg === lg) continue;
    for (const t of career.teams[lg]) {
      if (career.coaches[USER].jobs[lg] === t.id) continue;
      out.push({ lg, team: t.id, coach: coachOf(career, lg, t.id)?.name || 'Vacant', prestige: teamPrestige(career, lg, t.id) });
    }
  }
  return out;
}

// ---------- loyalty ----------
// How keen a player is on moving to `toTeam` in league `lg`: positive = keen, negative = wants to stay.
// He weighs his years at the club, his bond with the current coach, any history with the new coach,
// and the two coaches' standing.
export function willingness(career, lg, id, toTeam) {
  const p = career.players[id];
  const c = career.contracts[lg][id];
  if (!c) return 1;
  const cur = coachOf(career, lg, c.team), next = coachOf(career, lg, toTeam);
  const tenure = p.tenure[lg]?.team === c.team ? p.tenure[lg].seasons : 0;
  const stay = 0.15 + p.loyal * 0.45 + Math.min(tenure, 6) * 0.06 + (cur ? (p.bonds[cur.id] || 0) : 0) * 0.05;
  const pull = (next ? (p.bonds[next.id] || 0) : 0) * 0.12 + ((next?.rep ?? 60) - (cur?.rep ?? 60)) / 120;
  return Math.round((pull - stay + 0.35) * 100) / 100;
}

export function willingnessLabel(w) {
  if (w >= 0.35) return { text: 'Wants to join', tone: 'good' };
  if (w >= 0) return { text: 'Open to a move', tone: '' };
  if (w >= -0.3) return { text: 'Reluctant', tone: 'warn' };
  return { text: "Won't move", tone: 'bad' };
}

// ---------- trades ----------
// A trade state (the shape js/engine/trades.js works on) for one league: each team's squad, and its
// room under the cap as the purse. Player willingness is checked through state.willing.
export function tradeState(career, lg, userTeam = career.coaches[USER].jobs[lg] || null) {
  activateLeague(lg);
  const players = leaguePlayers(career, lg);
  const year = nextSeasonYear(career, lg);
  const cap = lg === 'ipl' ? D.purseCap(year) : leagueCap(lg, year);
  const teams = {};
  for (const t of career.teams[lg]) {
    const squad = teamSquad(career, lg, t.id);
    teams[t.id] = { id: t.id, squad, bought: [], purse: cap - squad.reduce((n, id) => n + (players[id].price || 30), 0) };
  }
  const state = {
    teams, userTeam, difficulty: career.difficulty, inflation: 1, preRetention: true, trades: [],
    willing: (id, to) => willingness(career, lg, id, to),
    icon: (id) => lg === 'ipl' && D.ICONS[id] === career.contracts.ipl[id]?.team,
  };
  return { state, players };
}

export function nextSeasonYear(career, lg) {
  const ev = career.events.find((e) => !e.done && e.lg === lg && e.kind === 'season');
  return ev ? ev.year : career.date[0] + 1;
}

// Is the league's trade window open (not during its season or auction)?
export function tradeWindowOpen(career, lg) { return career.pending?.lg !== lg; }

export function commitTrade(career, lg, state, offer, players) {
  const C = career.contracts[lg];
  for (const t of Object.values(state.teams)) {
    for (const id of t.squad) {
      if (C[id] && C[id].team !== t.id) {
        C[id] = { ...C[id], team: t.id, since: career.date[0] };
        career.players[id].tenure[lg] = { team: t.id, seasons: 0 };
      }
    }
  }
  const T = Object.fromEntries(career.teams[lg].map((t) => [t.id, t]));
  const from = state.userTeam;
  const names = (ids) => ids.map((id) => players[id].name).join(', ');
  news(career, { lg, text: `Trade: ${T[from]?.name || from} send ${names(offer.give) || 'cash'} to ${T[offer.partner].name} for ${names(offer.get) || 'cash'}.` });
}

// Trades the AI suggests for you: deals the other side would accept that make your XI stronger.
export function suggestTrades(career, lg, { limit = 3 } = {}) {
  const me = career.coaches[USER].jobs[lg];
  if (!me) return [];
  const { state, players } = tradeState(career, lg, me);
  const scn = { players };
  const mine = state.teams[me].squad;
  const myStrength = teamStrength(mine, players).overall;
  const xi = new Set(teamStrength(mine, players).xi);
  // Offer players outside the XI first, then the weakest XI players.
  const giveable = mine.filter((id) => !state.icon(id)).sort((a, b) => (xi.has(a) - xi.has(b)) || players[a].ovr - players[b].ovr).slice(0, 8);
  const out = [];
  for (const t of Object.values(state.teams)) {
    if (t.id === me) continue;
    const targets = t.squad.filter((id) => !state.icon(id) && willingness(career, lg, id, me) > -0.3)
      .map((id) => ({ id, up: teamStrength(mine.concat(id), players).overall - myStrength }))
      .filter((x) => x.up > 0.3).sort((a, b) => b.up - a.up).slice(0, 3);
    for (const { id } of targets) {
      for (const g of giveable) {
        const offer = { partner: t.id, give: [g], get: [id], cash: 0 };
        if (tradeProblem(state, scn, offer)) continue;
        const ev = evaluateTrade(state, scn, offer);
        if (ev.myStrengthGain <= 0.2) continue;
        if (ev.accept) { out.push({ offer, ev }); break; }
        if (ev.cashNeeded && ev.cashNeeded <= state.teams[me].purse * 0.25) {
          const o2 = { ...offer, cash: ev.cashNeeded };
          if (!tradeProblem(state, scn, o2) && evaluateTrade(state, scn, o2).accept) { out.push({ offer: o2, ev: evaluateTrade(state, scn, o2) }); break; }
        }
      }
    }
  }
  return out.sort((a, b) => b.ev.myStrengthGain - a.ev.myStrengthGain).slice(0, limit);
}

// The trade window: AI teams trade with each other, and some make you offers.
export function runTradeWindow(career, ev) {
  const lg = ev.lg;
  const me = career.coaches[USER].jobs[lg] || null;
  withRng(career, (rng) => {
    const { state, players } = tradeState(career, lg, null);
    const scn = { players };
    const ids = career.teams[lg].map((t) => t.id).filter((t) => t !== me);
    let made = 0;
    for (let attempt = 0; attempt < ids.length * 2 && made < 3; attempt++) {
      const a = rng.pick(ids), b = rng.pick(ids.filter((x) => x !== a));
      const deal = aiDeal(career, lg, state, scn, a, b, rng);
      if (!deal) continue;
      state.userTeam = a;
      executeTrade(state, scn, { ...deal, force: true });
      commitTrade(career, lg, state, deal, players);
      made++;
    }
    // Offers to you.
    if (me) {
      const { state: s2, players: p2 } = tradeState(career, lg, me);
      for (const b of rng.shuffle(ids).slice(0, 3)) {
        const deal = aiOfferTo(career, lg, s2, { players: p2 }, me, b, rng);
        if (!deal) continue;
        const T = Object.fromEntries(career.teams[lg].map((t) => [t.id, t]));
        inbox(career, {
          kind: 'trade', lg, partner: b, give: deal.give, get: deal.get, cash: deal.cash,
          text: `${T[b].name} offer ${deal.get.map((id) => p2[id].name).join(', ')} for ${deal.give.map((id) => p2[id].name).join(', ')}.`,
          expires: nextLeagueEvent(career, lg)?.date || null,
        });
        break;
      }
    }
  });
  ev.done = true;
}

// A swap two AI teams would both sign off on, or null. Players bonded to the other side's coach (who
// followed him there in spirit) move most easily.
function aiDeal(career, lg, state, scn, a, b, rng) {
  const P = scn.players;
  const A = state.teams[a], B = state.teams[b];
  const baseA = teamStrength(A.squad, P).overall;
  const wanted = B.squad.filter((id) => !state.icon(id) && willingness(career, lg, id, a) > -0.3)
    .map((id) => ({ id, up: teamStrength(A.squad.concat(id), P).overall - baseA + willingness(career, lg, id, a) }))
    .filter((x) => x.up > 0.3).sort((x, y) => y.up - x.up).slice(0, 3);
  for (const { id } of wanted) {
    const v = marketValue({ ...P[id], base: 30 });
    const gives = A.squad.filter((g) => !state.icon(g) && willingness(career, lg, g, b) > -0.3)
      .sort((x, y) => Math.abs(marketValue({ ...P[x], base: 30 }) - v) - Math.abs(marketValue({ ...P[y], base: 30 }) - v)).slice(0, 4);
    for (const g of gives) {
      const offer = { partner: b, give: [g], get: [id], cash: 0 };
      state.userTeam = a;
      if (tradeProblem(state, scn, offer)) continue;
      const forB = evaluateTrade(state, scn, offer);
      state.userTeam = b;
      const back = { partner: a, give: [id], get: [g], cash: 0 };
      const forA = evaluateTrade(state, scn, back);
      if (forB.accept && forA.accept && rng.next() < 0.8) { state.userTeam = a; return offer; }
    }
  }
  return null;
}

// An offer from AI team b to you: they want one of your players and offer one of theirs.
function aiOfferTo(career, lg, state, scn, me, b, rng) {
  const P = scn.players;
  const B = state.teams[b];
  const base = teamStrength(B.squad, P).overall;
  const targets = state.teams[me].squad.filter((id) => !state.icon(id) && willingness(career, lg, id, b) > -0.3)
    .map((id) => ({ id, up: teamStrength(B.squad.concat(id), P).overall - base })).filter((x) => x.up > 0.4)
    .sort((x, y) => y.up - x.up).slice(0, 3);
  for (const { id } of targets) {
    const v = marketValue({ ...P[id], base: 30 });
    const options = B.squad.filter((g) => !state.icon(g) && willingness(career, lg, g, me) > -0.3)
      .sort((x, y) => Math.abs(marketValue({ ...P[x], base: 30 }) * 1.1 - v) - Math.abs(marketValue({ ...P[y], base: 30 }) * 1.1 - v)).slice(0, 4);
    for (const g of options) {
      const offer = { partner: b, give: [id], get: [g], cash: 0 };   // from your side: you give id, get g
      if (tradeProblem(state, scn, offer)) continue;
      const ev = evaluateTrade(state, scn, offer);
      if (ev.accept && ev.myStrengthGain > -1.2 && rng.next() < 0.85) return offer;
    }
  }
  return null;
}

// ---------- yearly development ----------
const NAMES = {
  Pakistan: [['Hamza', 'Usman', 'Shahzaib', 'Zain', 'Abdullah', 'Faizan', 'Haris', 'Arham', 'Rohail', 'Mubeen'], ['Khan', 'Afridi', 'Malik', 'Butt', 'Qureshi', 'Javed', 'Raza', 'Iqbal', 'Shah', 'Akhtar']],
  'South Africa': [['Kwena', 'Lhuan', 'Dewan', 'Nqaba', 'Jandre', 'Ruan', 'Thabo', 'Sipho', 'Wian', 'Connor'], ['Botha', 'van Wyk', 'Mokoena', 'Fortuin', 'Steyn', 'Nkosi', 'Pretorius', 'Dlamini', 'Coetzee', 'Smit']],
  England: [['Rehan', 'Josh', 'Tom', 'Ollie', 'Ben', 'Harry', 'Archie', 'Freddie', 'Jamie', 'Will'], ['Haynes', 'Price', 'Kohler', 'Aldridge', 'Moore', 'Hughes', 'Pepper', 'Lavelle', 'Abbott', 'Crane']],
  India: [['Aarav', 'Vihaan', 'Arjun', 'Kabir', 'Reyansh', 'Ishaan', 'Advik', 'Rudra', 'Atharv', 'Krish', 'Dhruv', 'Yuvraj'], ['Sharma', 'Patel', 'Yadav', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Chauhan', 'Desai', 'Kulkarni', 'Rawat', 'Thakur']],
};
// Each league's home country needs a steady supply: overseas limits mean most of every squad is local.
const PROSPECTS_PER_YEAR = { India: 28, Pakistan: 18, 'South Africa': 20, England: 20 };

// A fictional young (or, for domestic fill-ins, journeyman) player from `country`.
function makePlayer(career, rng, country, { level = clamp(rng.normal(54, 6), 42, 72), age = rng.int(18, 21), role = null } = {}) {
  const [first, last] = NAMES[country];
  role = role || rng.weighted(['BAT', 'WK', 'AR', 'BOWL'], (r) => ({ BAT: 3, WK: 1, AR: 3, BOWL: 4 }[r]));
  const bowlType = role === 'BOWL' || role === 'AR' ? (rng.next() < 0.4 ? 'spin' : 'pace') : null;
  let bat, bowl;
  if (role === 'BAT' || role === 'WK') { bat = level; bowl = 5; }
  else if (role === 'BOWL') { bat = 12 + rng.next() * 10; bowl = level; }
  else if (rng.next() < 0.5) { bat = level; bowl = level - 12; } else { bat = level - 12; bowl = level; }
  bat = Math.round(bat); bowl = Math.round(bowl);
  const bt = bowlType === 'pace' ? rng.pick(['RF', 'RFM', 'RFM', 'RM', 'LF', 'LFM']) : bowlType === 'spin' ? rng.pick(['OB', 'LB', 'SLA', 'LWS']) : null;
  const pos = role === 'BOWL' ? ['tail'] : role === 'AR' ? (bat >= bowl ? ['middle', 'lower'] : ['lower']) : rng.pick([['top'], ['top', 'middle'], ['middle']]);
  const id = `prospect-${career.date[0]}-${career.nextProspect++}`;
  const p = { id, name: `${rng.pick(first)} ${rng.pick(last)}`, country, role, bowlType, bt, bs: null, br: [], bat, bowl, ovr: D.overall(role, bat, bowl), pos, age, capped: false, prospect: true, tenure: {}, bonds: {} };
  p.loyal = personality(p);
  career.players[id] = p;
  return id;
}

function addProspects(career, rng) {
  const made = [];
  for (const [country, n] of Object.entries(PROSPECTS_PER_YEAR)) for (let i = 0; i < n; i++) made.push(makePlayer(career, rng, country));
  return made;
}

// A squad still short of the league minimum after its auction signs local domestic players at the
// minimum fee (real clubs do the same from their domestic system).
function fillShortSquads(career, lg, year) {
  const L = LEAGUES[lg];
  withRng(career, (rng) => {
    for (const t of career.teams[lg]) {
      let n = teamSquad(career, lg, t.id).length;
      while (n < L.squad.min) {
        const id = makePlayer(career, rng, L.home === 'England' ? 'England' : L.home, { level: clamp(rng.normal(50, 4), 42, 58), age: rng.int(22, 30) });
        career.players[id].prospect = false;
        career.contracts[lg][id] = { team: t.id, price: L.minPrice, since: year };
        n++;
      }
    }
  });
}

function formBonus(st) {
  if (!st || st.m < 5) return { bat: 0, bowl: 0 };
  let bat = 0, bowl = 0;
  if (st.inns >= 5 && st.b >= 60) bat = clamp((st.r / st.inns - 22) / 15 + ((st.r / st.b) * 100 - 140) / 60, -1.5, 1.5);
  if (st.bb >= 60) bowl = clamp((st.w / st.m - 1) + (9 - (st.rc / st.bb) * 6) / 2, -1.5, 1.5);
  return { bat, bowl };
}

export function runDevelop(career, ev) {
  withRng(career, (rng) => {
    const retired = [];
    for (const p of Object.values(career.players)) {
      if (p.retired) continue;
      p.age = (p.age ?? 27) + 1;
      const contracted = LEAGUE_IDS.some((lg) => career.contracts[lg][p.id]);
      if (rng.next() < D.retireChance({ ...p, team: contracted ? 'x' : null })) {
        p.retired = true; p.retiredYear = career.date[0];
        for (const lg of LEAGUE_IDS) delete career.contracts[lg][p.id];
        if (p.ovr >= 74) retired.push(p.name);
        continue;
      }
      // Young players improve faster under a highly rated coach.
      const coachBoost = p.age <= 25 ? LEAGUE_IDS.reduce((best, lg) => {
        const c = career.contracts[lg][p.id];
        const coach = c && coachOf(career, lg, c.team);
        return Math.max(best, coach ? (coach.rep - 65) * 0.04 : 0);
      }, 0) : 0;
      const form = formBonus(career.yearStats[p.id]);
      const base = D.ageCurve(p.age) + rng.normal(0, 1.6) + coachBoost;
      const pull = (x) => Math.max(0, x - 78) * 0.15;
      if (p.bat >= 40 || p.role === 'BAT' || p.role === 'WK') p.bat = Math.round(clamp(p.bat + base + form.bat * 0.7 - pull(p.bat), 5, 97));
      if (p.bowl >= 40 || p.role === 'BOWL') p.bowl = Math.round(clamp(p.bowl + base + form.bowl * 0.7 - pull(p.bowl), 5, 97));
      p.ovr = D.overall(p.role, p.bat, p.bowl);
      if (!p.capped && p.ovr >= 72) p.capped = true;
    }
    career.yearStats = {};
    const made = addProspects(career, rng);
    news(career, { lg: null, text: `${made.length} young players have registered for next season's auctions.${retired.length ? ` Retired: ${retired.slice(0, 6).join(', ')}.` : ''}` });
  });
  ev.done = true;
  schedule(career, ev.year + 2);
}

// ---------- the main loop ----------
// Simulate one non-interactive event (or an interactive one in a league you don't coach).
export function runEvent(career, ev) {
  career.date = ev.date.slice();
  expireInbox(career);
  if (ev.kind === 'develop') return runDevelop(career, ev);
  if (ev.kind === 'trade') return runTradeWindow(career, ev);
  if (ev.kind === 'retain') { const r = beginRetain(career, ev); return finishRetain(career, ev, r.world); }
  if (ev.kind === 'auction') { const { scn, state } = beginAuction(career, ev); simulateRest(state, scn); return finishAuction(career, ev, state); }
  if (ev.kind === 'season') {
    const { scn, season } = beginSeason(career, ev);
    let guard = 0;
    while (season.stage !== 'done' && guard++ < 200) playFixture(season, scn, nextFixture(season));
    return finishSeason(career, ev, season, scn);
  }
}

// Advance to the next event you need to act on (or the next one with news for you). Returns that event.
export function advance(career, { stopOnInbox = true } = {}) {
  let guard = 0;
  while (guard++ < 60) {
    const ev = nextEvent(career);
    if (!ev) return null;
    if (isUserEvent(career, ev)) { career.date = ev.date.slice(); expireInbox(career); return ev; }
    const before = career.inbox.filter((m) => !m.answered).length;
    runEvent(career, ev);
    if (stopOnInbox && career.inbox.filter((m) => !m.answered).length > before) return null;
  }
  return null;
}

// Your summary: jobs, reputation, the board's view.
export function userSummary(career) {
  const you = career.coaches[USER];
  return {
    rep: you.rep,
    jobs: Object.entries(you.jobs).map(([lg, team]) => ({ lg, team, security: you.security[lg] ?? 60, name: career.teams[lg].find((t) => t.id === team).name })),
  };
}
