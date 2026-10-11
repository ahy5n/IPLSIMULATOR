// Player form, fitness, injuries and team chemistry through a season. Plain JSON on the season object:
//   season.status[playerId] = { form, fit, inj, injury }   form -10..+10, fit 0..100, inj = matches left out
//   season.chem[teamId] = { value 0..100, lastXI: [ids] }
// All of it turns into rating changes for each match through matchMods().

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const INJURIES = [
  // name, min matches, max matches, weight, which players it tends to hit
  ['Bruised hand', 1, 1, 14, 'any'],
  ['Back spasm', 1, 2, 10, 'bowl'],
  ['Ankle sprain', 1, 3, 10, 'any'],
  ['Hamstring strain', 2, 5, 14, 'any'],
  ['Side strain', 3, 6, 10, 'bowl'],
  ['Groin strain', 2, 4, 8, 'any'],
  ['Finger fracture', 4, 7, 7, 'any'],
  ['Shoulder injury', 4, 9, 5, 'any'],
  ['Stress fracture in the back', 14, 14, 3, 'bowl'],
  ['Torn knee ligament', 14, 14, 2, 'any'],
];
// Out for this many team matches or more = ruled out of the season; the team may sign a replacement.
export const RULED_OUT = 6;

export function initStatus(season, scn, continuity = {}) {
  season.status = {};
  season.chem = {};
  for (const [teamId, squad] of Object.entries(season.squads)) {
    for (const id of squad) season.status[id] = { form: 0, fit: 100, inj: 0, injury: null };
    // Teams that kept their core start with better chemistry.
    const cont = continuity[teamId] ?? 0.5;
    season.chem[teamId] = { value: Math.round(45 + cont * 30), lastXI: [] };
  }
  season.replacements = [];
}

export function statusOf(season, id) {
  return season.status?.[id] || (season.status ? (season.status[id] = { form: 0, fit: 100, inj: 0, injury: null }) : { form: 0, fit: 100, inj: 0, injury: null });
}

export function isAvailable(season, id) { return !season.status || statusOf(season, id).inj <= 0; }
export function unavailable(season, squad) { return squad.filter((id) => !isAvailable(season, id)); }

// Fitness below 75 costs skill; form adds or takes away up to 3; chemistry is worth up to about ±2 for the XI.
export function fitnessPenalty(fit) { return fit < 75 ? -Math.min(10, (75 - fit) * 0.3) : 0; }

export function matchMods(season, teamId, ids) {
  if (!season.status) return {};
  const chem = season.chem?.[teamId]?.value ?? 50;
  const chemBonus = (chem - 50) * 0.045;
  const mods = {};
  for (const id of ids) {
    const st = statusOf(season, id);
    const d = st.form * 0.3 + fitnessPenalty(st.fit) + chemBonus;
    mods[id] = { bat: d, bowl: d };
  }
  return mods;
}

// How a lineup change would move chemistry (for the selection screen).
export function chemistryChange(season, teamId, xi) {
  const last = season.chem?.[teamId]?.lastXI || [];
  if (!last.length) return { changes: 0, delta: 0 };
  const changes = xi.filter((id) => !last.includes(id)).length;
  return { changes, delta: changes <= 1 ? 1.5 : -1.5 * changes + 1.5 };
}

function perfScore(id, innings) {
  let s = 0, any = false;
  for (const inn of innings) {
    const bt = inn.batting.find((x) => x.id === id && x.batted);
    if (bt) {
      any = true;
      s += (bt.r - 22) / 12;
      if (bt.b >= 8) s += ((bt.r / bt.b) * 100 - 140) / 40;
    }
    const bw = inn.bowling.find((x) => x.id === id);
    if (bw) {
      any = true;
      s += (bw.w - 1) * 1.4;
      if (bw.balls >= 12) s += (8.8 - (bw.r / bw.balls) * 6) / 1.2;
    }
  }
  return any ? clamp(s, -4, 4) : null;
}

function rollInjury(rng, p, st, bowledBalls) {
  let chance = p.bowlType === 'pace' && bowledBalls > 0 ? 0.012 : bowledBalls > 0 ? 0.006 : 0.004;
  if (st.fit < 70) chance *= 1 + (70 - st.fit) / 15;
  if (rng.next() >= chance) return null;
  const options = INJURIES.filter(([, , , , kind]) => kind === 'any' || (kind === 'bowl' && bowledBalls > 0));
  const [name, lo, hi] = rng.weighted(options, (x) => x[3]);
  return { name, matches: rng.int(lo, hi) };
}

// After a match: form from performance, fitness from workload, injuries, chemistry. Returns new injuries.
export function afterMatch(season, scn, fx, res, rng) {
  if (!season.status) return [];
  const news = [];
  for (const teamId of [fx.home, fx.away]) {
    const squad = season.squads[teamId];
    const lineup = res.lineups?.[teamId];
    const played = new Set(lineup ? lineup.xi.concat(Object.values(res.impact || {}).filter((s) => s && squad.includes(s.in)).map((s) => s.in)) : []);
    for (const id of squad) {
      const st = statusOf(season, id);
      const p = scn.players[id];
      // Injured players count down one match; everyone else recovers some fitness between games.
      if (st.inj > 0) { st.inj -= 1; if (st.inj <= 0) { st.injury = null; st.fit = Math.max(st.fit, 85); } continue; }
      if (!played.has(id)) { st.fit = clamp(st.fit + 12, 0, 100); st.form *= 0.9; continue; }
      const perf = res.noResult ? null : perfScore(id, res.innings);
      if (perf != null) st.form = clamp(st.form * 0.65 + perf * 1.1, -10, 10);
      const bowled = res.innings?.reduce((n, inn) => n + (inn.bowling.find((x) => x.id === id)?.balls || 0), 0) || 0;
      const faced = res.innings?.reduce((n, inn) => n + (inn.batting.find((x) => x.id === id)?.b || 0), 0) || 0;
      const load = 3 + bowled * (p.bowlType === 'pace' ? 0.55 : 0.35) + faced * 0.1 + (p.role === 'WK' ? 3 : 0);
      st.fit = clamp(st.fit - load + 8, 0, 100);   // +8: recovery before the next game
      const inj = res.noResult ? null : rollInjury(rng, p, st, bowled);
      if (inj) {
        st.inj = inj.matches;
        st.injury = inj.name;
        news.push({ id, team: teamId, injury: inj.name, matches: inj.matches, ruledOut: inj.matches >= RULED_OUT, match: fx.no });
        if (inj.matches >= RULED_OUT) season.replacements.push({ team: teamId, out: id, injury: inj.name, in: null, done: false, match: fx.no });
      }
    }
    // Chemistry: settled sides and winning sides gel; wholesale changes and defeats unsettle them.
    const ch = season.chem[teamId];
    if (lineup) {
      const { delta } = chemistryChange(season, teamId, lineup.xi);
      const result = res.noResult ? 0 : res.winner === teamId ? 1.5 : -1;
      ch.value = clamp(Math.round((ch.value + delta + result) * 10) / 10, 25, 92);
      ch.lastXI = lineup.xi.slice();
    }
  }
  season.injuryLog = (season.injuryLog || []).concat(news).slice(-60);
  return news;
}

// Players a team may sign as an injury replacement: registered, unsigned, not retired, and paid no more
// than the injured player (the IPL rule). Overseas only if the squad would stay within 8.
export function replacementPool(season, scn, teamId, outId) {
  const taken = new Set(Object.values(season.squads).flat());
  for (const r of season.replacements) taken.add(r.out);
  const out = scn.players[outId];
  const fee = Math.max(season.prices?.[outId] ?? out.price ?? out.base ?? 30, 30);
  const osInSquad = season.squads[teamId].filter((id) => id !== outId && scn.players[id].overseas).length;
  return scn.pool.map((id) => scn.players[id]).filter((p) => p && !taken.has(p.id) && !p.retired && (p.base ?? 30) <= fee && !(p.overseas && osInSquad >= 8))
    .sort((a, b) => b.ovr - a.ovr);
}

// Sign the replacement: he takes the injured player's place in the season squad.
export function signReplacement(season, scn, teamId, outId, inId) {
  const r = season.replacements.find((x) => x.team === teamId && x.out === outId && !x.done);
  if (!r) throw new Error('No replacement is due for that player');
  if (inId) {
    const ok = replacementPool(season, scn, teamId, outId).some((p) => p.id === inId);
    if (!ok) throw new Error('That player cannot be signed as a replacement');
    season.squads[teamId] = season.squads[teamId].filter((id) => id !== outId).concat(inId);
    season.status[inId] = { form: 0, fit: 100, inj: 0, injury: null };
    r.in = inId;
    r.fee = scn.players[inId].base ?? 30;
  }
  r.done = true;
  return r;
}

// AI teams sign the best available replacement, preferring the same role.
export function aiReplacements(season, scn, userTeam) {
  for (const r of season.replacements) {
    if (r.done || r.team === userTeam) continue;
    const role = scn.players[r.out].role;
    const pool = replacementPool(season, scn, r.team, r.out);
    const pick = pool.slice(0, 40).sort((a, b) => (b.ovr + (b.role === role ? 6 : 0)) - (a.ovr + (a.role === role ? 6 : 0)))[0];
    signReplacement(season, scn, r.team, r.out, pick?.id || null);
  }
}

export function pendingReplacements(season, teamId) {
  return (season.replacements || []).filter((r) => r.team === teamId && !r.done);
}
