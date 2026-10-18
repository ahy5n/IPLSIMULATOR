// Season: IPL fixtures (70 league games in two virtual groups), table with net run rate, playoffs, awards.
import { createRng } from './rng.js';
import { simulateMatch, applyMods, impactIds, FORMAT } from './match.js';
import { initStatus, matchMods, afterMatch, unavailable, isAvailable, aiReplacements } from './status.js';
import { bestXI, bestImpacts, xiScore, XI_OVERSEAS_MAX } from './squad.js';
import { adjustPlayers, aiChooseConditions, VENUE_DEFAULT } from './conditions.js';

// IPL format since 2022: each team plays the four others in its group twice (home and away), the team in
// the same row of the other group twice (home and away), and the other four teams in that group once,
// two at home and two away. 14 games each, 7 at home, 70 in all.
// Order: the defending champions host the opening game (against last year's runners-up when possible);
// then every team gets regular rest and no more than two home or two away games in a row where possible.
//
// Other leagues (format = the league's fixture style):
//   psl:     two groups of four; twice against your group, once against the other (10 games each)
//   double:  double round robin, home and away (SA20: 10 games each)
//   hundred: everyone once plus a second game against the regional rival (8 games each)
export function leagueGames(teams, format = 'ipl') {
  const ids = teams.map((t) => t.id);
  const games = [];
  const twice = (x, y) => { games.push([x, y], [y, x]); };
  // One game between i and j: alternate hosts so home games even out.
  const once = (i, j) => games.push((i + j) % 2 ? [ids[i], ids[j]] : [ids[j], ids[i]]);
  if (format === 'double') {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) twice(ids[i], ids[j]);
    return games;
  }
  if (format === 'hundred') {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) once(i, j);
    const done = new Set();
    for (const t of teams) {
      if (!t.rival || done.has(t.id)) continue;
      done.add(t.id); done.add(t.rival);
      const first = games.find(([h, a]) => (h === t.id && a === t.rival) || (h === t.rival && a === t.id));
      games.push([first[1], first[0]]);   // the return game, at the other ground
    }
    return games;
  }
  const A = teams.filter((t) => t.group === 'A').map((t) => t.id);
  const B = teams.filter((t) => t.group === 'B').map((t) => t.id);
  for (const g of [A, B]) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) twice(g[i], g[j]);
  const n = A.length;
  if (format === 'psl') {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) games.push((i + j) % 2 ? [A[i], B[j]] : [B[j], A[i]]);
    return games;
  }
  for (let i = 0; i < n; i++) {
    twice(A[i], B[i]);
    // Single games: A[i] hosts B[j] when (j - i) mod n is 1 or 2, so every team hosts exactly two.
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = (j - i + n) % n;
      games.push(d <= 2 ? [A[i], B[j]] : [B[j], A[i]]);
    }
  }
  return games;
}

export function generateFixtures(teams, seed, { champion = null, runnerUp = null, format = 'ipl' } = {}) {
  const ids = teams.map((t) => t.id);
  const games = leagueGames(teams, format);

  const build = (rng) => {
    let pool = rng.shuffle(games);
    const out = [];
    const last = Object.fromEntries(ids.map((t) => [t, -10]));
    const venues = Object.fromEntries(ids.map((t) => [t, []]));   // true = home
    const take = (i) => {
      const [h, a] = pool[i];
      pool = pool.filter((_, k) => k !== i);
      last[h] = last[a] = out.length;
      venues[h].push(true); venues[a].push(false);
      out.push({ no: out.length + 1, home: h, away: a, stage: 'league', result: null });
    };
    if (champion) {
      let i = pool.findIndex(([h, a]) => h === champion && a === runnerUp);
      if (i < 0) i = pool.findIndex(([h]) => h === champion);
      if (i >= 0) take(i);
    }
    // A third straight home (or away) game is penalised.
    const run3 = (t, home) => { const v = venues[t]; return v.length >= 2 && v[v.length - 1] === home && v[v.length - 2] === home; };
    while (pool.length) {
      let bi = 0, bs = -Infinity;
      pool.forEach(([h, a], i) => {
        const rh = out.length - last[h], ra = out.length - last[a];
        const sc = Math.min(rh, ra) * 10 + Math.max(rh, ra) - (run3(h, true) ? 40 : 0) - (run3(a, false) ? 40 : 0) + rng.next();
        if (sc > bs) { bs = sc; bi = i; }
      });
      take(bi);
    }
    return out;
  };

  // Several attempts; keep the one with the fewest scheduling faults.
  const faults = (fx) => {
    let f = 0;
    for (const t of ids) {
      const mine = fx.filter((x) => x.home === t || x.away === t);
      let run = 0, prev = null;
      mine.forEach((x, k) => {
        const home = x.home === t;
        run = home === prev ? run + 1 : 1; prev = home;
        if (run > 2) f += 3;
        if (k && x.no - mine[k - 1].no < 2) f += 5;
      });
    }
    return f;
  };
  const rng = createRng(seed);
  let best = null, bestF = Infinity;
  for (let attempt = 0; attempt < 30 && bestF > 0; attempt++) {
    const fx = build(rng);
    const fl = faults(fx);
    if (fl < bestF) { best = fx; bestF = fl; }
  }
  return best;
}

// prices: { id: lakh } contract fees (for injury-replacement limits).
// continuity: { teamId: 0..1 } share of the squad kept from last season (starting chemistry).
export function createSeason(scn, squads, { userTeam, seed = 1, prices = {}, continuity = null }) {
  const lg = scn.league || { fixtures: 'ipl', playoffs: 'page' };
  const table = {};
  for (const t of scn.teams) table[t.id] = { id: t.id, p: 0, w: 0, l: 0, nr: 0, pts: 0, rf: 0, bf: 0, ra: 0, bb: 0 };
  const season = {
    version: 2, seed, rngState: (seed * 7919) >>> 0, userTeam, squads: Object.fromEntries(Object.entries(squads).map(([k, v]) => [k, v.slice()])),
    fixtures: generateFixtures(scn.teams, seed, { champion: scn.champion, runnerUp: scn.runnerUp, format: lg.fixtures }), table, stats: {}, playoffs: [], champion: null, stage: 'league', prices, userXI: null,
    playoffFormat: lg.playoffs || 'page',
  };
  const cont = continuity || Object.fromEntries(scn.teams.map((t) => [t.id, Math.min(1, t.retained.length / Math.max(1, squads[t.id].length))]));
  initStatus(season, scn, cont);
  return season;
}

export function nrr(row) {
  if (!row.bf || !row.bb) return 0;
  return (row.rf / row.bf) * 6 - (row.ra / row.bb) * 6;
}

export function standings(season) {
  return Object.values(season.table).sort((a, b) => b.pts - a.pts || nrr(b) - nrr(a) || b.w - a.w || a.id.localeCompare(b.id));
}

// Best XI and both impact players for the conditions, leaving out unavailable players and weighing
// form and fitness (mods), so tired or out-of-form players get rested.
export function autoLineup(squad, players, conditions = 'balanced', { exclude = [], mods = null } = {}) {
  const avail = squad.filter((id) => !exclude.includes(id));
  const adj = adjustPlayers(applyMods(players, mods), avail, conditions);
  const xi = bestXI(avail, adj);
  return { xi, impact: bestImpacts(avail, xi, adj) };
}

// Keep the XI from last match, swapping out anyone now unavailable for the best fit from the bench.
// Returns { lineup, changes: [{ out, in }] }.
export function repairLineup(lineup, squad, players, { exclude = [], conditions = 'balanced' } = {}) {
  const ok = (id) => squad.includes(id) && !exclude.includes(id);
  const xi = lineup.xi.slice();
  const changes = [];
  const adj = adjustPlayers(players, squad, conditions);
  for (let i = 0; i < xi.length; i++) {
    if (ok(xi[i])) continue;
    const rest = xi.filter((id, k) => k !== i && ok(id));
    const os = rest.filter((id) => players[id].overseas).length;
    const bench = squad.filter((id) => ok(id) && !xi.includes(id) && !(players[id].overseas && os >= XI_OVERSEAS_MAX));
    const best = bench.reduce((b, id) => (b == null || xiScore(rest.concat(id), adj) > xiScore(rest.concat(b), adj) ? id : b), null);
    changes.push({ out: xi[i], in: best });
    xi[i] = best;
  }
  const clean = xi.filter(Boolean);
  let impact = lineup.impact && typeof lineup.impact === 'object' ? { ...lineup.impact } : { bat: null, bowl: null };
  const fresh = bestImpacts(squad.filter(ok), clean, adj);
  for (const k of ['bat', 'bowl']) if (!impact[k] || !ok(impact[k]) || clean.includes(impact[k])) impact[k] = fresh[k];
  if (impact.bat && impact.bat === impact.bowl) impact.bat = fresh.bat !== impact.bowl ? fresh.bat : null;
  return { lineup: { xi: clean, impact }, changes };
}

// The user's lineup for the next match: last match's XI carried over (repaired for injuries), or the
// best XI for the conditions if there is no previous XI.
export function carriedLineup(season, scn, conditions) {
  const squad = season.squads[season.userTeam];
  const exclude = unavailable(season, squad);
  if (!season.userXI) return { lineup: autoLineup(squad, scn.players, conditions, { exclude, mods: matchMods(season, season.userTeam, squad) }), changes: [], carried: false };
  const r = repairLineup(season.userXI, squad, scn.players, { exclude, conditions });
  return { ...r, carried: true };
}

// Conditions for a fixture. AI hosts choose (and the choice is stored so it is known in advance);
// the user's home games use the ground's usual conditions until the user picks.
export function fixtureConditions(season, scn, fx) {
  if (fx.conditions) return fx.conditions;
  if (fx.neutral) return (fx.conditions = 'balanced');   // playoffs are at neutral venues
  if (fx.home === season.userTeam) return VENUE_DEFAULT[fx.home] || 'balanced';
  const fit = (t) => season.squads[t].filter((id) => isAvailable(season, id));
  fx.conditions = aiChooseConditions(fx.home, fit(fx.home), fit(fx.away), scn.players);
  return fx.conditions;
}

// Checks a lineup the user picked. Returns null if legal, else the reason.
export function lineupProblem(lineup, squad, players, season = null) {
  const { xi } = lineup;
  if (xi.length !== 11) return `Pick 11 players (you have ${xi.length})`;
  if (new Set(xi).size !== 11) return 'A player is picked twice';
  if (xi.some((id) => !squad.includes(id))) return 'A picked player is not in your squad';
  const os = xi.filter((id) => players[id].overseas).length;
  if (os > XI_OVERSEAS_MAX) return `At most ${XI_OVERSEAS_MAX} overseas players in the XI (you have ${os})`;
  if (season) {
    const hurt = xi.find((id) => !isAvailable(season, id));
    if (hurt) return `${players[hurt].name} is injured`;
  }
  const imps = impactIds(lineup);
  if (new Set(imps).size !== imps.length) return 'Pick two different impact players';
  for (const imp of imps) {
    if (xi.includes(imp)) return 'Impact players must come from the bench';
    if (!squad.includes(imp)) return 'An impact player is not in your squad';
    if (season && !isAvailable(season, imp)) return `${players[imp].name} is injured`;
    if (os === XI_OVERSEAS_MAX && players[imp].overseas) return `With ${XI_OVERSEAS_MAX} overseas players in the XI, impact players must be local players`;
  }
  return null;
}

function addStats(season, inn) {
  const s = season.stats;
  const get = (id) => s[id] || (s[id] = { id, m: 0, inns: 0, no: 0, r: 0, b: 0, f4: 0, f6: 0, hs: 0, w: 0, bb: 0, rc: 0, best: [0, 0], fifties: 0, hundreds: 0 });
  for (const bt of inn.batting) {
    if (!bt.batted) continue;
    const x = get(bt.id);
    x.inns++; x.r += bt.r; x.b += bt.b; x.f4 += bt.f4; x.f6 += bt.f6;
    if (!bt.out) x.no++;
    x.hs = Math.max(x.hs, bt.r);
    if (bt.r >= 100) x.hundreds++; else if (bt.r >= 50) x.fifties++;
  }
  for (const bw of inn.bowling) {
    const x = get(bw.id);
    x.w += bw.w; x.bb += bw.balls; x.rc += bw.r;
    if (bw.w > x.best[0] || (bw.w === x.best[0] && bw.r < x.best[1])) x.best = [bw.w, bw.r];
  }
}

function recordLeague(season, fx, res) {
  const T = season.table;
  const [a, b] = [T[fx.home], T[fx.away]];
  a.p++; b.p++;
  if (res.noResult) { a.nr++; b.nr++; a.pts++; b.pts++; return; }
  const win = T[res.winner], lose = res.winner === fx.home ? b : a;
  win.w++; win.pts += 2; lose.l++;
  for (const inn of res.innings) {
    const bat = T[inn.team], bowl = inn.team === fx.home ? b : a;
    const balls = inn.allOut ? FORMAT.balls : inn.balls;     // all out counts as the full innings for NRR
    bat.rf += inn.runs; bat.bf += balls; bowl.ra += inn.runs; bowl.bb += balls;
  }
}

// Play one fixture. userLineup is used when the user's team is involved; AI teams auto-pick.
export function playFixture(season, scn, fx, userLineup = null, userConditions = null) {
  if (fx.result) return fx.result;
  if (userConditions && fx.home === season.userTeam && !fx.neutral) fx.conditions = userConditions;
  const conditions = fixtureConditions(season, scn, fx);
  fx.conditions = conditions;
  if (season.status) aiReplacements(season, scn, season.userTeam);
  const rng = createRng(season.rngState);
  const lineups = {};
  let mods = {};
  for (const t of [fx.home, fx.away]) {
    const squad = season.squads[t];
    const exclude = season.status ? unavailable(season, squad) : [];
    const teamMods = matchMods(season, t, squad);
    if (t === season.userTeam) {
      lineups[t] = userLineup ? repairLineup(userLineup, squad, scn.players, { exclude, conditions }).lineup : carriedLineup(season, scn, conditions).lineup;
    } else {
      lineups[t] = autoLineup(squad, scn.players, conditions, { exclude, mods: teamMods });
    }
    mods = { ...mods, ...teamMods };
  }
  const playoff = fx.stage !== 'league';
  const res = simulateMatch(rng, { teamA: fx.home, teamB: fx.away, lineups, players: scn.players, washoutChance: playoff ? 0 : 0.015, conditions, mods });
  // Store only what the UI needs, keeping saved games small.
  res.lineups = lineups;
  res.injuries = afterMatch(season, scn, fx, res, rng);
  season.rngState = rng.state;
  if (lineups[season.userTeam]) season.userXI = { xi: lineups[season.userTeam].xi.slice(), impact: { ...lineups[season.userTeam].impact } };
  fx.result = res;
  const usedImpacts = Object.values(res.impact || {}).filter(Boolean).map((x) => x.in);
  for (const t of [fx.home, fx.away]) for (const id of new Set([...lineups[t].xi, ...usedImpacts.filter((x) => season.squads[t].includes(x))])) {
    const st = season.stats[id] || (season.stats[id] = { id, m: 0, inns: 0, no: 0, r: 0, b: 0, f4: 0, f6: 0, hs: 0, w: 0, bb: 0, rc: 0, best: [0, 0], fifties: 0, hundreds: 0 });
    st.m++;
  }
  for (const inn of res.innings) addStats(season, inn);
  if (!playoff) recordLeague(season, fx, res);
  advance(season);
  return res;
}

export function nextFixture(season) {
  return season.fixtures.find((f) => !f.result) || season.playoffs.find((f) => !f.result) || null;
}

export function nextUserFixture(season) {
  return [...season.fixtures, ...season.playoffs].find((f) => !f.result && (f.home === season.userTeam || f.away === season.userTeam)) || null;
}

// Simulate every game before the user's next one (or to the end of the season).
export function simToUserGame(season, scn) {
  let guard = 0;
  while (guard++ < 200) {
    const fx = nextFixture(season);
    if (!fx || fx.home === season.userTeam || fx.away === season.userTeam) return fx;
    playFixture(season, scn, fx);
  }
  return null;
}

// The final of a finished season (the last playoff game).
export function finalOf(season) { return season.playoffs?.[season.playoffs.length - 1]; }

function advance(season) {
  const n = season.fixtures.length;
  if (season.stage === 'league' && season.fixtures.every((f) => f.result)) {
    const s = standings(season).map((r) => r.id);
    season.stage = 'playoffs';
    // The Hundred: second plays third in the eliminator; the winner meets the league leaders in the final.
    season.playoffs = season.playoffFormat === 'top3'
      ? [{ no: n + 1, stage: 'Eliminator', home: s[1], away: s[2], result: null, neutral: true }]
      : [
        { no: n + 1, stage: 'Qualifier 1', home: s[0], away: s[1], result: null, neutral: true },
        { no: n + 2, stage: 'Eliminator', home: s[2], away: s[3], result: null, neutral: true },
      ];
    return;
  }
  if (season.stage !== 'playoffs') return;
  if (season.playoffFormat === 'top3') {
    const [el, fin] = season.playoffs;
    if (el.result && !fin) {
      season.playoffs.push({ no: n + 2, stage: 'Final', home: standings(season)[0].id, away: el.result.winner, result: null, neutral: true });
      return;
    }
    if (fin?.result) { season.champion = fin.result.winner; season.stage = 'done'; season.awards = awards(season); }
    return;
  }
  const [q1, el, q2, fin] = season.playoffs;
  if (q1.result && el.result && !q2) {
    const q1Loser = q1.result.winner === q1.home ? q1.away : q1.home;
    season.playoffs.push({ no: n + 3, stage: 'Qualifier 2', home: q1Loser, away: el.result.winner, result: null, neutral: true });
  } else if (q2?.result && !fin) {
    season.playoffs.push({ no: n + 4, stage: 'Final', home: q1.result.winner, away: q2.result.winner, result: null, neutral: true });
  } else if (fin?.result) {
    season.champion = fin.result.winner;
    season.stage = 'done';
    season.awards = awards(season);
  }
}

export function teamOfPlayer(season, id) {
  return Object.keys(season.squads).find((t) => season.squads[t].includes(id));
}

// End-of-season awards from season stats.
export function awards(season) {
  const all = Object.values(season.stats);
  const top = (arr, key) => arr.slice().sort(key)[0] || null;
  const mvp = (x) => x.r + x.f4 * 1 + x.f6 * 2 + x.w * 25 + (x.bb >= 60 ? Math.max(0, (8.5 - (x.rc / x.bb) * 6)) * 10 : 0);
  return {
    orange: top(all, (a, b) => b.r - a.r || (b.r / Math.max(1, b.b)) - (a.r / Math.max(1, a.b))),
    purple: top(all, (a, b) => b.w - a.w || (a.rc / Math.max(1, a.bb)) - (b.rc / Math.max(1, b.bb))),
    mvp: top(all, (a, b) => mvp(b) - mvp(a)),
    sixes: top(all, (a, b) => b.f6 - a.f6 || b.r - a.r),
    strikeRate: top(all.filter((x) => x.b >= 100), (a, b) => b.r / b.b - a.r / a.b),
    economy: top(all.filter((x) => x.bb >= (FORMAT.balls === 100 ? 100 : 120)), (a, b) => a.rc / a.bb - b.rc / b.bb),
  };
}
