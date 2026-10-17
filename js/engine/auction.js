// Auction state machine. No UI code. The state is plain JSON so a game can be saved and resumed.
//
// Flow: main phase (opening sets in lot order) -> nominate -> accelerated round -> ... -> done.
// Each lot: beginLot, then any mix of aiAct/placeBid, then hammer.
// Mega auctions add right-to-match (RTM): when the hammer would fall, the player's previous team may
// match the price. The winning bidder then gets one final raise, which the RTM team must match again.
//   rtmCandidate -> useRtm -> (rtmRaise | skip) -> rtmDecide
import { MODES, SQUAD_MIN, SQUAD_MAX, MIN_PRICE, bidBlocker, nextBid, maxAllowedBid, openSlots, overseasSlots, increment } from './rules.js';
import { aiCeiling, marketValue, needMultiplier, marketInflation, AI_TARGET_SIZE } from './valuation.js';
import { teamStrength } from './squad.js';
import { createRng } from './rng.js';

// scn = { players: {id: player}, teams: [team], pool: [ids], kind: 'mini' | 'mega', mainLastSet: {full, quick} }
export function createAuction(scn, { userTeam, mode = 'full', difficulty = 'medium', seed = 1 }) {
  const m = MODES[mode];
  const kind = scn.kind || 'mini';
  const teams = {};
  for (const t of scn.teams) {
    const cappedKept = t.retained.filter((id) => scn.players[id].capped).length;
    const rtm = kind === 'mega' ? (t.rtm ?? Math.max(0, 6 - t.retained.length)) : 0;
    // RTM cards can be used on capped players only while the team is under five capped retentions.
    teams[t.id] = { id: t.id, purse: t.purse, squad: t.retained.slice(), bought: [], rtm, rtmCapped: Math.min(rtm, t.rtmCapped ?? Math.max(0, 5 - cappedKept)) };
  }
  const lastSet = scn.mainLastSet?.[mode] ?? m.mainLastSet;
  const queue = scn.pool.filter((id) => scn.players[id].set <= lastSet)
    .sort((a, b) => scn.players[a].set - scn.players[b].set || scn.players[a].lot - scn.players[b].lot);
  const inflation = marketInflation(scn.teams, scn.teams.reduce((n, t) => n + SQUAD_MAX - t.retained.length, 0));
  return {
    version: 2, seed, rngState: seed >>> 0, mode, difficulty, userTeam, inflation, kind, year: scn.year,
    teams, phase: 'main', round: 0, queue, mainTotal: queue.length,
    called: [], sold: [], unsold: [], lot: null, ceilings: {}, log: [],
  };
}

function withRng(state, fn) {
  const rng = createRng(state.rngState);
  const out = fn(rng);
  state.rngState = rng.state;
  return out;
}

export function remainingPool(state, scn) {
  const done = new Set(state.sold.map((s) => s.id));
  return scn.pool.filter((id) => !done.has(id) && !state.queue.includes(id) && state.lot?.playerId !== id);
}

const auctionComplete = (state) => Object.values(state.teams).every((t) => openSlots(t) === 0 || t.purse < MIN_PRICE);

// Start the next lot. Moves the phase on when the queue is empty. Returns the lot or null.
export function beginLot(state, scn) {
  if (state.lot) return state.lot;
  while (state.queue.length) {
    if (auctionComplete(state)) { state.queue = []; break; }
    const id = state.queue.shift();
    const p = scn.players[id];
    // Skip lots nobody can legally buy.
    const anyone = Object.values(state.teams).some((t) => !bidBlocker(t, p, p.base, scn.players));
    if (!anyone) { markUnsold(state, id); continue; }
    state.called.push(id);
    state.lot = { playerId: id, bid: 0, bidder: null, history: [], userPassed: false };
    state.ceilings = {};
    state.strength = state.strength || {};
    for (const t of Object.values(state.teams)) {
      if (t.id === state.userTeam) continue;
      // Team strength only changes when the squad does, so cache it by squad size.
      const c = state.strength[t.id];
      const base = c && c.n === t.squad.length ? c.v : (state.strength[t.id] = { n: t.squad.length, v: teamStrength(t.squad, scn.players).overall }).v;
      state.ceilings[t.id] = aiCeiling(t, p, scn.players, { seed: state.seed, difficulty: state.difficulty, baseStrength: base, phase: state.phase, inflation: state.inflation ?? 1, affinity: !!state.affinity?.[t.id]?.includes(id) });
    }
    return state.lot;
  }
  advancePhase(state, scn);
  return null;
}

function advancePhase(state, scn) {
  const m = MODES[state.mode];
  if (state.phase === 'main' || state.phase === 'accelerated') {
    if (state.round < m.acceleratedRounds && !auctionComplete(state) && remainingPool(state, scn).length) {
      state.round += 1;
      state.phase = 'nominate';
      state.log.push({ type: 'phase', text: `Accelerated round ${state.round}: teams nominate players` });
    } else {
      finish(state, scn);
    }
  }
}

// AI teams that would bid now, with their headroom.
export function aiWillingBidders(state, scn) {
  const lot = state.lot;
  if (!lot) return [];
  const p = scn.players[lot.playerId];
  const amount = nextBid(lot, p);
  return Object.values(state.teams)
    .filter((t) => t.id !== state.userTeam && t.id !== lot.bidder)
    .filter((t) => (state.ceilings[t.id] ?? 0) >= amount && !bidBlocker(t, p, amount, scn.players))
    .map((t) => ({ team: t.id, headroom: state.ceilings[t.id] - amount, amount }));
}

// One AI bid, if any AI wants to bid. Returns { team, amount } or null.
export function aiAct(state, scn) {
  const willing = aiWillingBidders(state, scn);
  if (!willing.length) return null;
  return withRng(state, (rng) => {
    const pick = rng.weighted(willing, (w) => 1 + Math.sqrt(w.headroom + 1));
    placeBid(state, scn, pick.team);
    return { team: pick.team, amount: pick.amount };
  });
}

// Teams still in the running on this lot: the current bidder, every AI team that would bid the next
// amount, and the user unless they passed or cannot afford it.
export function teamsInRunning(state, scn) {
  const lot = state.lot;
  if (!lot) return [];
  const live = new Set(aiWillingBidders(state, scn).map((w) => w.team));
  if (lot.bidder) live.add(lot.bidder);
  if (!lot.userPassed && lot.bidder !== state.userTeam && !userBidBlocker(state, scn)) live.add(state.userTeam);
  return [...live];
}

// Fast forward: let the AI bidding war run instantly until only `leave` teams are left in it.
// Returns how many bids were made.
export function fastForward(state, scn, { leave = 2 } = {}) {
  let bids = 0;
  while (state.lot && bids < 500 && teamsInRunning(state, scn).length > leave) {
    if (!aiAct(state, scn)) break;
    bids++;
  }
  return bids;
}

// Place the next bid for a team. Throws with a readable reason if the bid is illegal.
export function placeBid(state, scn, teamId) {
  const lot = state.lot;
  if (!lot) throw new Error('No player is up for bidding');
  if (lot.bidder === teamId) throw new Error('You already hold the highest bid');
  const p = scn.players[lot.playerId];
  const amount = nextBid(lot, p);
  const why = bidBlocker(state.teams[teamId], p, amount, scn.players);
  if (why) throw new Error(why);
  lot.bid = amount;
  lot.bidder = teamId;
  lot.history.push({ team: teamId, amount });
  return amount;
}

export function userBidBlocker(state, scn) {
  const lot = state.lot;
  if (!lot) return 'No player is up for bidding';
  if (lot.bidder === state.userTeam) return 'You hold the highest bid';
  const p = scn.players[lot.playerId];
  return bidBlocker(state.teams[state.userTeam], p, nextBid(lot, p), scn.players);
}

// ---------- right to match ----------
// The team that may use an RTM card on this lot, or null.
export function rtmCandidate(state, scn) {
  const lot = state.lot;
  if (!lot || !lot.bidder || lot.rtm || state.kind !== 'mega') return null;
  const p = scn.players[lot.playerId];
  const prev = p.prevTeam;
  const t = prev && state.teams[prev];
  if (!t || prev === lot.bidder || t.rtm <= 0) return null;
  if (p.capped && t.rtmCapped <= 0) return null;
  if (bidBlocker(t, p, lot.bid, scn.players)) return null;
  return prev;
}

// AI previous team: match if the price is close to what it would have paid.
export function aiWantsRtm(state, scn, teamId, price) {
  return (state.ceilings[teamId] ?? 0) >= price * 0.85;
}

export function useRtm(state, scn, teamId) {
  const lot = state.lot;
  if (rtmCandidate(state, scn) !== teamId) throw new Error('That team cannot use a right-to-match card here');
  lot.rtm = { team: teamId, winner: lot.bidder, price: lot.bid, raised: false, stage: 'raise' };
  return lot.rtm;
}

// The winning bidder's one final raise (any legal amount above the matched price).
export function rtmRaise(state, scn, amount) {
  const lot = state.lot, r = lot?.rtm;
  if (!r || r.stage !== 'raise') throw new Error('No raise is open');
  const p = scn.players[lot.playerId];
  if (amount <= r.price) throw new Error('A raise must be higher than the matched price');
  const why = bidBlocker(state.teams[r.winner], p, amount, scn.players);
  if (why) throw new Error(why);
  r.price = amount; r.raised = true; r.stage = 'match';
  lot.bid = amount;
  lot.history.push({ team: r.winner, amount, final: true });
  return amount;
}

export function rtmSkipRaise(state) {
  const r = state.lot?.rtm;
  if (r && r.stage === 'raise') r.stage = 'match';
}

// AI winner's final raise: up to its ceiling, at most about 20% above the matched price.
export function aiRtmRaise(state, scn) {
  const lot = state.lot, r = lot.rtm;
  const ceil = state.ceilings[r.winner] ?? 0;
  const step = increment(r.price);
  if (ceil < r.price + step) return null;
  let amt = Math.min(ceil, Math.round(r.price * 1.2));
  amt = Math.max(r.price + step, Math.floor(amt / step) * step);
  const p = scn.players[lot.playerId];
  if (bidBlocker(state.teams[r.winner], p, amt, scn.players)) return null;
  return amt;
}

// Can the RTM team still afford to match the (possibly raised) price?
export function rtmCanMatch(state, scn) {
  const lot = state.lot, r = lot?.rtm;
  return !!r && !bidBlocker(state.teams[r.team], scn.players[lot.playerId], r.price, scn.players);
}

// The RTM team's decision. Without a raise, using the card already secured the player.
export function rtmDecide(state, scn, match) {
  const lot = state.lot, r = lot.rtm;
  const toRtm = r.raised ? match && rtmCanMatch(state, scn) : true;
  lot.bidder = toRtm ? r.team : r.winner;
  lot.bid = r.price;
  if (toRtm) {
    const t = state.teams[r.team];
    t.rtm -= 1;
    if (scn.players[lot.playerId].capped) t.rtmCapped -= 1;
    t.rtmCapped = Math.min(t.rtmCapped, t.rtm);
  }
  r.stage = 'done';
  return hammer(state, scn, { rtm: toRtm });
}

// Run the RTM steps for AI teams (and decline for a user who is not choosing).
function resolveRtmAI(state, scn) {
  const t = rtmCandidate(state, scn);
  if (!t || t === state.userTeam || !aiWantsRtm(state, scn, t, state.lot.bid)) return null;
  useRtm(state, scn, t);
  const winnerIsUser = state.lot.rtm.winner === state.userTeam;
  const raise = winnerIsUser ? null : aiRtmRaise(state, scn);
  if (raise) rtmRaise(state, scn, raise); else rtmSkipRaise(state);
  return rtmDecide(state, scn, aiWantsRtm(state, scn, t, state.lot.rtm.price / 0.95));
}

// Close the lot: sold to the highest bidder, or unsold.
export function hammer(state, scn, { rtm = false } = {}) {
  const lot = state.lot;
  if (!lot) return null;
  let result;
  if (lot.bidder) {
    const t = state.teams[lot.bidder];
    t.purse -= lot.bid;
    t.squad.push(lot.playerId);
    t.bought.push({ id: lot.playerId, price: lot.bid, ...(rtm ? { rtm: true } : {}) });
    result = { type: 'sold', id: lot.playerId, team: lot.bidder, price: lot.bid, phase: state.phase, bids: lot.history.length, ...(rtm ? { rtm: true } : {}) };
    state.sold.push({ id: lot.playerId, team: lot.bidder, price: lot.bid, phase: state.phase, ...(rtm ? { rtm: true } : {}) });
    state.unsold = state.unsold.filter((x) => x !== lot.playerId);
  } else {
    markUnsold(state, lot.playerId);
    result = { type: 'unsold', id: lot.playerId };
  }
  state.log.push(result);
  state.lot = null;
  return result;
}

function markUnsold(state, id) {
  if (!state.unsold.includes(id)) state.unsold.push(id);
}

// Run the current lot with AI teams only (the user does not bid). Used for "sim" controls and tests.
export function simulateLot(state, scn) {
  if (!state.lot) beginLot(state, scn);
  if (!state.lot) return null;
  let guard = 0;
  while (aiAct(state, scn) && guard++ < 500);
  return resolveRtmAI(state, scn) || hammer(state, scn);
}

// AI nominations for an accelerated round: each AI names the players it values most that it can afford.
export function aiNominations(state, scn) {
  const m = MODES[state.mode];
  const pool = remainingPool(state, scn);
  const picks = new Set();
  for (const t of Object.values(state.teams)) {
    if (t.id === state.userTeam) continue;
    const want = Math.min(openSlots(t), Math.max(0, AI_TARGET_SIZE - t.squad.length));
    if (!want) continue;
    const base = teamStrength(t.squad, scn.players).overall;
    // Only the best 80 affordable candidates get the (slower) squad-fit check.
    const scored = pool
      .map((id) => scn.players[id])
      .filter((p) => p.base <= maxAllowedBid(t) && !(p.overseas && overseasSlots(t, scn.players) <= 0))
      .sort((x, y) => marketValue(y) - marketValue(x)).slice(0, 80)
      .map((p) => ({ id: p.id, score: marketValue(p) * needMultiplier(t, p, scn.players, base) }))
      .sort((a, b) => b.score - a.score);
    scored.slice(0, want * m.nominationsPerSlot).forEach((s) => picks.add(s.id));
  }
  return [...picks];
}

// Start the accelerated round with the AI picks plus the user's picks.
export function startAccelerated(state, scn, userPicks = []) {
  if (state.phase !== 'nominate') throw new Error('Not in a nomination phase');
  const ids = new Set(aiNominations(state, scn).concat(userPicks));
  state.queue = [...ids].sort((a, b) => scn.players[a].set - scn.players[b].set || scn.players[a].lot - scn.players[b].lot);
  state.phase = 'accelerated';
  state.unsold = state.unsold.filter((id) => !ids.has(id));
  return state.queue.length;
}

// End of auction: any team still under 18 players must sign unsold players at reserve price.
// It gets the cheapest ones (best first within a price), so sitting out the bidding is never a shortcut to stars.
export function finish(state, scn) {
  const pool = () => remainingPool(state, scn).map((id) => scn.players[id]).sort((a, b) => a.base - b.base || b.ovr - a.ovr);
  for (const t of Object.values(state.teams)) {
    while (t.squad.length < SQUAD_MIN) {
      const p = pool().find((x) => !bidBlocker(t, x, x.base, scn.players));
      if (!p) break;
      t.purse -= p.base;
      t.squad.push(p.id);
      t.bought.push({ id: p.id, price: p.base });
      state.sold.push({ id: p.id, team: t.id, price: p.base, phase: 'fill' });
      state.unsold = state.unsold.filter((x) => x !== p.id);
      state.log.push({ type: 'sold', id: p.id, team: t.id, price: p.base, phase: 'fill' });
    }
  }
  state.phase = 'done';
  state.queue = [];
  state.log.push({ type: 'phase', text: 'Auction complete' });
}

// Simulate everything that is left with no user bids. Nominations are AI-only.
export function simulateRest(state, scn) {
  let guard = 0;
  while (state.phase !== 'done' && guard++ < 5000) {
    if (state.phase === 'nominate') { startAccelerated(state, scn, []); continue; }
    if (!state.lot && !beginLot(state, scn)) continue;
    simulateLot(state, scn);
  }
  return state;
}
