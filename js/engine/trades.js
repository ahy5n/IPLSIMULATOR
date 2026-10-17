// Trade window after the auction. Players move at their current fee (auction price or retention price);
// the difference comes out of, or goes back into, each purse, and either side can add cash.
// Rules: up to three players each way, both squads stay within 18-25 players and 8 overseas, nobody
// goes over their purse, and franchise icons cannot be traded.
//
// offer = { partner: teamId, give: [ids from the user], get: [ids from the partner], cash: lakh the user pays (negative = receives) }
import { SQUAD_MIN, SQUAD_MAX, OVERSEAS_MAX } from './rules.js';
import { marketValue } from './valuation.js';
import { teamStrength } from './squad.js';
import { ICONS, teamPlayers, purseCap } from './dynasty.js';

export const MAX_PER_SIDE = 3;
// How much better than even a deal must be for the AI side, in crore-equivalent points.
const MARGIN = { easy: 0, medium: 0.6, hard: 1.5 };

export function salaryOf(state, scn, id) {
  for (const t of Object.values(state.teams)) {
    const b = t.bought.find((x) => x.id === id);
    if (b) return b.price;
  }
  const p = scn.players[id];
  return p.price ?? p.base ?? 30;
}

export function isTradeIcon(state, id) {
  if (state.icon) return state.icon(id);
  const owner = Object.values(state.teams).find((t) => t.squad.includes(id));
  return !!owner && ICONS[id] === owner.id;
}

const valueOf = (state, scn, id) => marketValue({ ...scn.players[id], base: 30 }) * (state.inflation ?? 1);

// Squads and purses as they would be after the trade.
function after(state, scn, offer) {
  const me = state.teams[state.userTeam], them = state.teams[offer.partner];
  const pay = (ids) => ids.reduce((n, id) => n + salaryOf(state, scn, id), 0);
  const cash = offer.cash || 0;
  return {
    mySquad: me.squad.filter((id) => !offer.give.includes(id)).concat(offer.get),
    theirSquad: them.squad.filter((id) => !offer.get.includes(id)).concat(offer.give),
    myPurse: me.purse + pay(offer.give) - pay(offer.get) - cash,
    theirPurse: them.purse + pay(offer.get) - pay(offer.give) + cash,
  };
}

// Null if the trade is legal, else the reason.
export function tradeProblem(state, scn, offer) {
  const me = state.teams[state.userTeam], them = state.teams[offer.partner];
  if (!them || offer.partner === state.userTeam) return 'Pick a team to trade with';
  if (!offer.give.length && !offer.get.length) return 'Choose at least one player';
  if (offer.give.length > MAX_PER_SIDE || offer.get.length > MAX_PER_SIDE) return `At most ${MAX_PER_SIDE} players each way`;
  if (offer.give.some((id) => !me.squad.includes(id))) return 'You can only offer your own players';
  if (offer.get.some((id) => !them.squad.includes(id))) return `That player is not with ${offer.partner}`;
  const icon = offer.give.concat(offer.get).find((id) => isTradeIcon(state, id));
  if (icon) return `${scn.players[icon].name} is a franchise icon and cannot be traded`;
  // Players have a say (career mode): someone settled with his coach may refuse to move.
  if (state.willing) {
    const no = offer.get.find((id) => state.willing(id, state.userTeam) < -0.3);
    if (no) return `${scn.players[no].name} doesn't want to leave ${offer.partner}`;
    const no2 = offer.give.find((id) => state.willing(id, offer.partner) < -0.3);
    if (no2) return `${scn.players[no2].name} doesn't want to go to ${offer.partner}`;
  }
  const a = after(state, scn, offer);
  const os = (sq) => sq.filter((id) => scn.players[id].overseas).length;
  const min = state.preRetention ? 0 : SQUAD_MIN;   // before retentions squads refill at the auction
  for (const [who, sq] of [['Your', a.mySquad], [`${offer.partner}'s`, a.theirSquad]]) {
    if (sq.length > SQUAD_MAX) return `${who} squad would have more than ${SQUAD_MAX} players`;
    if (sq.length < min) return `${who} squad would drop below ${SQUAD_MIN} players`;
    if (os(sq) > OVERSEAS_MAX) return `${who} squad would have more than ${OVERSEAS_MAX} overseas players`;
  }
  const room = state.preRetention ? 'room under the salary cap' : 'purse';
  if (a.myPurse < 0) return `You do not have the ${room} for this trade`;
  if (a.theirPurse < 0) return `${offer.partner} do not have the ${room} for this trade`;
  return null;
}

// How the AI side sees the deal. score > 0 means it accepts.
export function evaluateTrade(state, scn, offer) {
  const them = state.teams[offer.partner];
  const a = after(state, scn, offer);
  const before = teamStrength(them.squad, scn.players).overall;
  const strengthGain = teamStrength(a.theirSquad, scn.players).overall - before;
  const valueGain = (offer.give.reduce((n, id) => n + valueOf(state, scn, id), 0) - offer.get.reduce((n, id) => n + valueOf(state, scn, id), 0)) / 100;
  const salaryGain = (a.theirPurse - them.purse) / 100;   // purse freed up (incl. cash received)
  // A team values making its XI better most, then fair value, then money in the bank.
  // A reluctant player is harder to prise away: the other side wants more for the trouble.
  const reluctance = state.willing ? offer.get.reduce((n, id) => n + Math.min(0, state.willing(id, state.userTeam)), 0) : 0;
  const score = strengthGain * 3 + valueGain * 0.6 + salaryGain * 0.4 - (MARGIN[state.difficulty] ?? 0.6) + reluctance * 1.5;
  // Cash (in lakh) the user would need to add to make it acceptable, if money could do it.
  const cashNeeded = score >= 0 ? 0 : Math.ceil((-score / 0.4) * 100 / 25) * 25;
  return { accept: score >= 0, score, strengthGain, valueGain, cashNeeded, myStrengthGain: teamStrength(a.mySquad, scn.players).overall - teamStrength(state.teams[state.userTeam].squad, scn.players).overall };
}

// Carry out the trade. Throws if it is illegal or the AI side refuses.
export function executeTrade(state, scn, offer) {
  const why = tradeProblem(state, scn, offer);
  if (why) throw new Error(why);
  const ev = evaluateTrade(state, scn, offer);
  if (!ev.accept && !offer.force) throw new Error(`${offer.partner} turned it down`);
  const me = state.teams[state.userTeam], them = state.teams[offer.partner];
  const a = after(state, scn, offer);
  const move = (ids, from, to) => {
    for (const id of ids) {
      const price = salaryOf(state, scn, id);
      from.squad = from.squad.filter((x) => x !== id);
      from.bought = from.bought.filter((x) => x.id !== id);
      to.squad.push(id);
      to.bought.push({ id, price, traded: true });
    }
  };
  move(offer.give, me, them);
  move(offer.get, them, me);
  me.purse = a.myPurse; them.purse = a.theirPurse;
  state.trades = (state.trades || []).concat({ from: state.userTeam, partner: offer.partner, give: offer.give.slice(), get: offer.get.slice(), cash: offer.cash || 0 });
  state.strength = {};   // cached team strengths are stale now
  return ev;
}

// ---------- trade window before retentions (dynasty off-season) ----------
// A trade state built from the world: each team's current squad at current salaries, and its "purse"
// is its room under next year's salary cap.
export function worldTradeState(world, userTeam, teamsMeta, difficulty, trades = []) {
  const teams = {};
  const cap = purseCap(world.year);
  for (const t of teamsMeta) {
    const squad = teamPlayers(world, t.id);
    const salaries = squad.reduce((n, id) => n + (world.players[id].price || 30), 0);
    teams[t.id] = { id: t.id, squad, bought: [], purse: cap - salaries };
  }
  return { teams, userTeam, difficulty, inflation: 1, preRetention: true, trades: trades.slice() };
}

// Write a completed pre-retention trade back into the world (new teams, fees unchanged).
export function applyWorldTrade(world, state) {
  for (const t of Object.values(state.teams)) {
    for (const id of t.squad) {
      const p = world.players[id];
      if (p.team !== t.id) { p.tradedFrom = p.team; p.team = t.id; }
      const b = t.bought.find((x) => x.id === id);
      if (b) p.price = b.price;
    }
  }
}
