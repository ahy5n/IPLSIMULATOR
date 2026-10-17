// Dynasty mode: after each season, players age and develop, some retire, new prospects register,
// every franchise chooses its retentions, and a new auction is built from everyone released.
//
// The IPL's three-year cycle: a mega auction (2025), two mini auctions (2026, 2027), then a mega again
// (2028). Mini: retain any number at current salary, no RTM. Mega: retain at most six (five capped, two
// uncapped) at the fixed slabs below, and use the remaining cards as right-to-match in the auction.
//
// Assumptions (the IPL has not announced rules beyond 2026):
// - The salary cap rises by ₹5 Cr a year, as it did from 2025 (₹120 Cr) to 2026 (₹125 Cr).
// - Mega retention slabs stay at the 2025 values.
// - A player's salary stays at his retention or auction price while he is retained.
import { createRng } from './rng.js';
import { marketValue } from './valuation.js';
import { bestXI } from './squad.js';
import { SQUAD_MAX, OVERSEAS_MAX } from './rules.js';
import { reserveFor, LEAGUES } from './league.js';

// Mega-auction retention costs (₹ lakh), 2025 rules: capped players in order, uncapped at a flat ₹4 Cr.
export const MEGA_SLABS = [1800, 1400, 1100, 1800, 1400];
export const UNCAPPED_SLAB = 400;
export const MEGA_MAX = { total: 6, capped: 5, uncapped: 2 };

export const BASE_YEAR = 2026;
export function purseCap(year) { return 12500 + 500 * (year - BASE_YEAR); }

// Career mode runs these rules on a per-league view of the world: world.league names the league,
// world.cap its salary cap and world.cycle / world.megaMax its retention cycle. Without them, IPL rules.
const isIPL = (w) => !w.league || w.league === 'ipl';
const capOf = (w) => w.cap ?? purseCap(w.year);
const fullMax = (w) => (isIPL(w) ? MEGA_MAX.total : w.megaMax ?? LEAGUES[w.league].cycle.megaMax);

export function overall(role, bat, bowl) {
  if (role === 'BAT' || role === 'WK') return bat + (role === 'WK' ? 2 : 0);
  if (role === 'BOWL') return bowl;
  // Same formula as tools/build_data.py.
  const hi = Math.max(bat, bowl), lo = Math.min(bat, bowl);
  return Math.round(Math.max(hi * 0.75 + lo * 0.3, hi + Math.max(0, lo - 30) * 0.1));
}

const value = (p) => marketValue({ ...p, base: 30 });

// A dynasty world holds its own copy of every player, because ratings, ages and contracts change.
export function startWorld(scn) {
  const players = {};
  for (const [id, p] of Object.entries(scn.players)) players[id] = { ...p };
  const year = scn.year || BASE_YEAR;
  const lastMega = scn.kind === 'mega' ? year : 2025 + Math.floor((year - 2025) / 3) * 3;
  return { year, players, history: [], current: null, nextProspect: 1, lastMega, forceKind: null };
}

// Which kind of auction the world's current off-season leads to.
export function nextKind(world) {
  if (world.forceKind) return world.forceKind;
  return world.year - world.lastMega >= (world.cycle ?? 3) ? 'mega' : 'mini';
}

// A world built from the real IPL 2026 squads (retentions plus the actual auction buys), one year on.
// Used for the projected IPL 2027 auction and the custom mega auction.
export function worldFromRealSquads(scn2026, { kind = 'mini', seed = 1 } = {}) {
  const w = startWorld(scn2026);
  for (const p of Object.values(w.players)) { p.team = null; }
  for (const t of scn2026.teams) for (const id of t.retained) { w.players[id].team = t.id; }
  for (const [id, a] of Object.entries(scn2026.actual)) { w.players[id].team = a.team; w.players[id].price = a.price; }
  w.history.push({ year: 2026, champion: null, finish: 'Real season (not simulated)' });
  w.year = 2027;
  for (const p of Object.values(w.players)) p.age = (p.age ?? 27) + 1;
  if (kind === 'mega') w.forceKind = 'mega';
  generateProspects(w, 28, createRng(seed ^ 0x2027));
  return w;
}

// Contracts after an auction: each squad member's salary is his retention or auction price.
// Injury replacements signed during the season join the squad at their fee; the injured player
// stays under contract too.
export function signContracts(world, auction, season = null) {
  for (const p of Object.values(world.players)) { if (!p.retired) { p.team = null; } }
  for (const t of Object.values(auction.teams)) {
    const bought = Object.fromEntries(t.bought.map((b) => [b.id, b.price]));
    for (const id of t.squad) {
      const p = world.players[id];
      p.team = t.id;
      if (bought[id] != null) p.price = bought[id];
    }
  }
  for (const r of season?.replacements || []) {
    if (!r.in) continue;
    const p = world.players[r.in];
    p.team = r.team; p.price = r.fee ?? p.base ?? 30;
  }
}

// Change in rating from age alone, before form and luck.
export function ageCurve(age) {
  if (age <= 21) return 3.5;
  if (age <= 23) return 2.5;
  if (age <= 25) return 1.5;
  if (age <= 28) return 0.5;
  if (age <= 30) return 0;
  if (age <= 32) return -1;
  if (age <= 34) return -2;
  if (age <= 36) return -3;
  return -4.5;
}

export function retireChance(p) {
  const a = p.age;
  let c = a >= 40 ? 0.9 : a >= 39 ? 0.65 : a >= 38 ? 0.45 : a >= 37 ? 0.25 : a >= 36 ? 0.1 : 0;
  // Players still at the top of their game keep going for longer.
  if (p.ovr >= 82) c *= 0.3; else if (p.ovr >= 75) c *= 0.6;
  if (!p.team && a >= 31 && p.ovr < 52) c = Math.max(c, 0.35);   // fringe players drift out of the game
  return c;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Form bonus from the season just played, in rating points (about -1.5 to +1.5 for each skill).
function formBonus(st) {
  if (!st || st.m < 5) return { bat: 0, bowl: 0 };
  let bat = 0, bowl = 0;
  if (st.inns >= 5 && st.b >= 60) bat = clamp((st.r / st.inns - 22) / 15 + ((st.r / st.b) * 100 - 140) / 60, -1.5, 1.5);
  if (st.bb >= 60) bowl = clamp((st.w / st.m - 1) + (9 - (st.rc / st.bb) * 6) / 2, -1.5, 1.5);
  return { bat, bowl };
}

const FIRST = ['Aarav', 'Vihaan', 'Arjun', 'Kabir', 'Reyansh', 'Ishaan', 'Advik', 'Rudra', 'Atharv', 'Krish', 'Dhruv', 'Shaurya', 'Yuvraj', 'Ayaan', 'Harsh', 'Tanmay', 'Parth', 'Rohan', 'Siddhant', 'Veer', 'Aditya', 'Nikhil', 'Pranav', 'Om', 'Samarth', 'Ritvik', 'Lakshay', 'Divyansh'];
const LAST = ['Sharma', 'Patel', 'Yadav', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Chauhan', 'Desai', 'Kulkarni', 'Rawat', 'Thakur', 'Pandey', 'Mishra', 'Gill', 'Sandhu', 'Rao', 'Bhat', 'Menon', 'Joshi', 'Saini', 'Tiwari', 'Dubey', 'Rathore', 'Jadhav', 'Pillai'];
const OS_NAMES = [['Australia', ['Jake', 'Riley', 'Cooper', 'Mitch', 'Sam'], ['Walsh', 'Harper', 'Doggett', 'Kerr', 'Bryant']],
  ['England', ['Rehan', 'Josh', 'Tom', 'Ollie', 'Ben'], ['Haynes', 'Price', 'Kohler', 'Aldridge', 'Moore']],
  ['South Africa', ['Kwena', 'Dewan', 'Lhuan', 'Nqaba', 'Jason'], ['Botha', 'van Wyk', 'Mokoena', 'Fortuin', 'Steyn']],
  ['Afghanistan', ['Bashir', 'Noor', 'Hasan', 'Ijaz', 'Sharif'], ['Safi', 'Zadran', 'Ahmadzai', 'Omari', 'Stanikzai']]];

// Fictional uncapped players who register for each new auction, so the pool keeps renewing.
export function generateProspects(world, n, rng) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const overseas = rng.next() < 0.18;
    let name, country = 'India';
    if (overseas) { const [c, f, l] = rng.pick(OS_NAMES); country = c; name = `${rng.pick(f)} ${rng.pick(l)}`; }
    else name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    const role = rng.weighted(['BAT', 'WK', 'AR', 'BOWL'], (r) => ({ BAT: 3, WK: 1, AR: 3, BOWL: 4 }[r]));
    const level = clamp(rng.normal(55, 6), 42, 72);
    const bowlType = role === 'BOWL' || role === 'AR' ? (rng.next() < 0.45 ? 'spin' : 'pace') : null;
    let bat, bowl;
    if (role === 'BAT' || role === 'WK') { bat = level; bowl = 5; }
    else if (role === 'BOWL') { bat = 12 + rng.next() * 10; bowl = level; }
    else if (rng.next() < 0.5) { bat = level; bowl = level - 12; } else { bat = level - 12; bowl = level; }
    bat = Math.round(bat); bowl = Math.round(bowl);
    const bt = bowlType === 'pace' ? rng.pick(['RF', 'RFM', 'RFM', 'RM', 'LF', 'LFM']) : bowlType === 'spin' ? rng.pick(['OB', 'LB', 'SLA', 'LWS']) : null;
    const pos = role === 'BOWL' ? ['tail'] : role === 'AR' ? (bat >= bowl ? ['middle', 'lower'] : ['lower']) : rng.pick([['top'], ['top', 'middle'], ['middle']]);
    const id = `prospect-${world.year}-${world.nextProspect++}`;
    const p = { id, name, country, overseas, role, bowlType, bt, bat, bowl, ovr: overall(role, bat, bowl), pos, age: rng.int(18, 21), capped: false, prospect: true, team: null, price: null };
    world.players[id] = p;
    out.push(id);
  }
  return out;
}

// Season over: record it, then age, develop and retire players and add prospects. Advances world.year.
export function endSeason(world, { auction, season, userTeam, finish, seed }) {
  signContracts(world, auction, season);
  if (auction.kind === 'mega') world.lastMega = auction.year ?? world.year;
  world.forceKind = null;
  const last = season.playoffs?.[season.playoffs.length - 1];
  const fin = last?.stage === 'Final' ? last.result : null;
  const runnerUp = fin ? (fin.winner === last.home ? last.away : last.home) : null;
  world.history.push({ year: world.year, champion: season.champion, runnerUp, userTeam, finish });
  const rng = createRng((seed ^ (world.year * 2654435761)) >>> 0);
  const changes = [];
  const retired = [];
  for (const p of Object.values(world.players)) {
    if (p.retired) continue;
    p.age = (p.age ?? 27) + 1;
    if (rng.next() < retireChance(p)) {
      p.retired = true; p.retiredYear = world.year;
      retired.push(p.id);
      continue;
    }
    const form = formBonus(season.stats[p.id]);
    const base = ageCurve(p.age) + rng.normal(0, 1.6);
    // Elite ratings are hard to keep: the higher a skill, the stronger the pull back towards the pack.
    const pull = (x) => Math.max(0, x - 78) * 0.15;
    const before = p.ovr;
    if (p.bat >= 40 || p.role === 'BAT' || p.role === 'WK') p.bat = Math.round(clamp(p.bat + base + form.bat * 0.7 - pull(p.bat), 5, 97));
    if (p.bowl >= 40 || p.role === 'BOWL') p.bowl = Math.round(clamp(p.bowl + base + form.bowl * 0.7 - pull(p.bowl), 5, 97));
    p.ovr = overall(p.role, p.bat, p.bowl);
    // A big season can earn an India call-up, which makes an uncapped player capped.
    if (!p.capped && !p.overseas && p.ovr >= 72) p.capped = true;
    changes.push({ id: p.id, before, after: p.ovr });
  }
  world.year += 1;
  const prospects = generateProspects(world, 28, rng);
  return { retired, changes, prospects };
}

// Franchise icons: never released while they play for that team (they can still retire).
export const ICONS = {
  'virat-kohli': 'RCB', 'jasprit-bumrah': 'MI', 'rohit-sharma': 'MI', 'suryakumar-yadav': 'MI', 'ms-dhoni': 'CSK',
  'ruturaj-gaikwad': 'CSK', 'sunil-narine': 'KKR', 'rinku-singh': 'KKR', 'rashid-khan': 'GT', 'shubman-gill': 'GT',
  'yashasvi-jaiswal': 'RR', 'abhishek-sharma': 'SRH', 'axar-patel': 'DC', 'shreyas-iyer': 'PBKS', 'rishabh-pant': 'LSG',
};
export function isIcon(world, id) { const p = world.players[id]; return isIPL(world) && !!p && !p.retired && ICONS[id] === p.team; }
export function teamIcons(world, teamId) { return teamPlayers(world, teamId).filter((id) => isIcon(world, id)); }

export function teamPlayers(world, teamId) {
  return Object.values(world.players).filter((p) => p.team === teamId && !p.retired).map((p) => p.id);
}

// What the AI suggests keeping. Like real franchises, it keeps its first-choice XI even when a player
// is paid more than his market value, plus anyone else worth most of his salary and cheap young talent.
export function suggestRetentions(world, teamId) {
  const ids = teamPlayers(world, teamId);
  const P = world.players;
  const xi = new Set(bestXI(ids, P));
  const cap = capOf(world);
  const keepers = ids.filter((id) => {
    const p = P[id], v = value(p), sal = p.price || 30;
    return v >= sal * 0.75 || (xi.has(id) && v >= sal * 0.35) || (sal <= 50 && p.age <= 24 && p.ovr >= 60);
  // First-choice XI before anyone else (when the squad limit forces a cut), then best value for money.
  }).sort((a, b) => (xi.has(b) - xi.has(a)) || ((value(P[b]) - (P[b].price || 30)) - (value(P[a]) - (P[a].price || 30))));
  const out = teamIcons(world, teamId);
  let cost = retentionCost(world, out), os = out.filter((id) => P[id].overseas).length;
  for (const id of keepers) {
    if (out.includes(id)) continue;
    const p = P[id], sal = p.price || 30;
    if (out.length >= SQUAD_MAX || (p.overseas && os >= OVERSEAS_MAX) || cost + sal > cap * 0.85) continue;
    out.push(id); cost += sal; if (p.overseas) os++;
  }
  return out;
}

export function retentionCost(world, ids) { return ids.reduce((n, id) => n + (world.players[id].price || 30), 0); }

export function retentionProblem(world, ids) {
  const os = ids.filter((id) => world.players[id].overseas).length;
  if (ids.length > SQUAD_MAX) return `You can retain at most ${SQUAD_MAX} players`;
  if (os > OVERSEAS_MAX) return `At most ${OVERSEAS_MAX} overseas players (you have ${os})`;
  if (retentionCost(world, ids) > capOf(world)) return 'Retentions cost more than the salary cap';
  return null;
}

// ---------- mega retentions ----------
// Cost of each retained player in a mega year: capped players take the slabs in order of value,
// uncapped players cost a flat ₹4 Cr. Returns { total, each: { id: cost } }.
export function megaRetentionCost(world, ids) {
  const P = world.players;
  if (!isIPL(world)) {   // other leagues: retained players keep their current fee
    const each = Object.fromEntries(ids.map((id) => [id, P[id].price || 30]));
    return { total: Object.values(each).reduce((n, c) => n + c, 0), each };
  }
  const capped = ids.filter((id) => P[id].capped).sort((a, b) => value(P[b]) - value(P[a]));
  const each = {};
  capped.forEach((id, i) => { each[id] = MEGA_SLABS[i] ?? MEGA_SLABS[MEGA_SLABS.length - 1]; });
  ids.filter((id) => !P[id].capped).forEach((id) => { each[id] = UNCAPPED_SLAB; });
  return { total: Object.values(each).reduce((n, c) => n + c, 0), each };
}

export function megaRetentionProblem(world, ids) {
  if (!isIPL(world)) {
    const os = ids.filter((id) => world.players[id].overseas).length;
    if (ids.length > fullMax(world)) return `This auction allows at most ${fullMax(world)} retentions`;
    if (os > OVERSEAS_MAX) return `At most ${OVERSEAS_MAX} overseas players (you have ${os})`;
    return null;
  }
  const capped = ids.filter((id) => world.players[id].capped).length;
  if (ids.length > MEGA_MAX.total) return `A mega auction allows at most ${MEGA_MAX.total} retentions`;
  if (capped > MEGA_MAX.capped) return `At most ${MEGA_MAX.capped} capped players (you have ${capped})`;
  if (ids.length - capped > MEGA_MAX.uncapped) return `At most ${MEGA_MAX.uncapped} uncapped players`;
  return null;
}

// AI mega retentions: keep the most valuable players who are worth their slab.
export function suggestMegaRetentions(world, teamId) {
  const P = world.players;
  const ids = teamPlayers(world, teamId).sort((a, b) => value(P[b]) - value(P[a]));
  if (!isIPL(world)) {
    // Keep the most valuable players who are worth most of their fee, within the league's limit.
    const out = [];
    let os = 0, cost = 0;
    for (const id of ids) {
      const p = P[id], sal = p.price || 30;
      if (out.length >= fullMax(world) || (p.overseas && os >= OVERSEAS_MAX) || value(p) < sal * 0.8 || cost + sal > capOf(world) * 0.6) continue;
      out.push(id); cost += sal; if (p.overseas) os++;
    }
    return out;
  }
  const out = teamIcons(world, teamId).slice(0, MEGA_MAX.total);
  let capped = out.filter((id) => P[id].capped).length, uncapped = out.length - capped;
  for (const id of ids) {
    if (out.includes(id)) continue;
    if (out.length >= MEGA_MAX.total) break;
    const p = P[id];
    if (p.capped) {
      if (capped >= MEGA_MAX.capped || value(p) < MEGA_SLABS[capped] * 0.75) continue;
      capped++;
    } else {
      if (uncapped >= MEGA_MAX.uncapped || value(p) < UNCAPPED_SLAB * 0.6) continue;
      uncapped++;
    }
    out.push(id);
  }
  return out;
}

export function rtmCards(world, ids) {
  if (!isIPL(world)) return { rtm: 0, rtmCapped: 0 };
  const capped = ids.filter((id) => world.players[id].capped).length;
  const rtm = Math.max(0, MEGA_MAX.total - ids.length);
  return { rtm, rtmCapped: Math.min(rtm, Math.max(0, MEGA_MAX.capped - capped)) };
}

// Apply a published list of real retentions ({ teams: { CSK: [{ id, salary }] } }) to a world: those
// players stay (traded players move to their new team), everyone else on a squad is released.
export function applyRealRetentions(world, real) {
  const keep = new Map();
  for (const [teamId, rows] of Object.entries(real.teams)) for (const r of rows) keep.set(r.id, { teamId, salary: r.salary });
  for (const p of Object.values(world.players)) {
    const k = keep.get(p.id);
    if (k) { p.team = k.teamId; p.price = k.salary; continue; }
    if (p.team) { p.releasedBy = p.team; p.team = null; p.price = null; }
  }
}

// Kind-aware wrappers used by the retention screen.
export function suggestFor(world, teamId) { return nextKind(world) === 'mega' ? suggestMegaRetentions(world, teamId) : suggestRetentions(world, teamId); }
export function retentionCostFor(world, ids) { return nextKind(world) === 'mega' ? megaRetentionCost(world, ids).total : retentionCost(world, ids); }
export function retentionProblemFor(world, ids) {
  if (nextKind(world) !== 'mega') return retentionProblem(world, ids);
  return megaRetentionProblem(world, ids) || (megaRetentionCost(world, ids).total > capOf(world) ? 'Retentions cost more than the salary cap' : null);
}

// Release everyone not retained. retained: { teamId: [ids] }. In a mega year the retained players'
// salaries become their slab costs, and each team's unused cards become RTM cards.
export function applyRetentions(world, retained) {
  const mega = nextKind(world) === 'mega';
  world.rtm = {};
  for (const [teamId, picked] of Object.entries(retained)) {
    const ids = [...new Set(teamIcons(world, teamId).concat(picked))];
    retained[teamId] = ids;
    const why = retentionProblemFor(world, ids);
    if (why) throw new Error(`${teamId}: ${why}`);
    const keep = new Set(ids);
    for (const id of teamPlayers(world, teamId)) {
      if (!keep.has(id)) { const p = world.players[id]; p.team = null; p.price = null; p.releasedBy = teamId; }
    }
    if (mega) {
      const { each } = megaRetentionCost(world, ids);
      for (const id of ids) world.players[id].price = each[id];
      world.rtm[teamId] = rtmCards(world, ids);
    }
  }
}

// Reserve price for the new auction list.
export function reservePrice(p) {
  const v = value(p);
  if (p.capped) return v >= 900 ? 200 : v >= 500 ? 150 : v >= 300 ? 125 : v >= 180 ? 100 : 75;
  return v >= 200 ? 50 : v >= 120 ? 40 : 30;
}

const SET_ORDER = ['BA', 'AL', 'WK', 'FA', 'SP'];
const setGroup = (p) => (p.role === 'BAT' ? 'BA' : p.role === 'AR' ? 'AL' : p.role === 'WK' ? 'WK' : p.bowlType === 'spin' ? 'SP' : 'FA');

// Build the next auction: teams with their retentions and purses, and a pool of everyone available
// arranged into sets the way the BCCI list is: marquee sets first in a mega auction, then capped sets
// by role, then uncapped sets.
export function buildAuction(world, teamsMeta) {
  const P = world.players;
  const kind = nextKind(world);
  const cap = capOf(world);
  const teams = teamsMeta.map((t) => {
    const retained = teamPlayers(world, t.id);
    const cost = kind === 'mega' ? megaRetentionCost(world, retained).total : retentionCost(world, retained);
    const cards = kind === 'mega' ? (world.rtm?.[t.id] || rtmCards(world, retained)) : { rtm: 0, rtmCapped: 0 };
    return { id: t.id, purse: cap - cost, retained, ...cards };
  });
  const available = Object.values(P).filter((p) => !p.retired && !p.team)
    .sort((a, b) => value(b) - value(a)).slice(0, kind === 'mega' ? 600 : 320);
  const pool = [];
  let setNo = 0, lot = 0;
  const place = (list, code) => {
    setNo++;
    for (const p of list) { p.set = setNo; p.setCode = code; p.lot = ++lot; pool.push(p.id); }
  };
  for (const p of available) {
    p.base = isIPL(world) ? reservePrice(p) : reserveFor(world.league, value(p), p.capped);
    p.prevTeam = p.releasedBy || null;    // in a mega auction the releasing team may use an RTM card
  }
  let rest = available;
  if (kind === 'mega') {
    const marquee = available.filter((p) => p.capped).slice(0, 12);
    place(marquee.slice(0, 6), 'M1');
    place(marquee.slice(6, 12), 'M2');
    const used = new Set(marquee.map((p) => p.id));
    rest = available.filter((p) => !used.has(p.id));
  }
  const groups = {};
  for (const p of rest) {
    const key = (p.capped ? '' : 'U') + setGroup(p);
    (groups[key] || (groups[key] = [])).push(p);
  }
  const chunks = {};
  for (const [k, list] of Object.entries(groups)) {
    list.sort((a, b) => b.base - a.base || value(b) - value(a));
    const size = k.startsWith('U') ? 9 : 7;
    chunks[k] = [];
    for (let i = 0; i < list.length; i += size) chunks[k].push(list.slice(i, i + size));
  }
  for (let round = 0; ; round++) {
    let any = false;
    for (const prefix of ['', 'U']) {
      for (const g of SET_ORDER) {
        const chunk = chunks[prefix + g]?.[round];
        if (!chunk) continue;
        any = true;
        place(chunk, `${prefix}${g}${round + 1}`);
      }
    }
    if (!any) break;
  }
  // Opening sets: about 117 lots before the accelerated rounds in a mega auction (as in 2025), 70 in a mini.
  const lastSetFor = (lots) => {
    const p = P[pool[Math.min(pool.length, lots) - 1]];
    return p ? p.set : setNo;
  };
  const mainLastSet = kind === 'mega' ? { full: lastSetFor(117), quick: lastSetFor(60) } : { full: lastSetFor(70), quick: lastSetFor(34) };
  world.current = { year: world.year, kind, teams, pool, mainLastSet };
  return world.current;
}

// Scenario object (the shape the engines take) for the world's current auction.
export function scenarioFromWorld(world, baseScn) {
  const teams = baseScn.teams.map((t) => {
    const c = world.current.teams.find((x) => x.id === t.id);
    return { ...t, purse: c.purse, retained: c.retained.slice(), rtm: c.rtm, rtmCapped: c.rtmCapped };
  });
  const last = world.history[world.history.length - 1];
  return {
    id: baseScn.id, year: world.year, kind: world.current.kind || 'mini', mainLastSet: world.current.mainLastSet,
    champion: last?.champion || null, runnerUp: last?.runnerUp || null,
    cap: capOf(world), players: world.players, teams, pool: world.current.pool.slice(), actual: {},
    teamById: Object.fromEntries(teams.map((t) => [t.id, t])),
  };
}
