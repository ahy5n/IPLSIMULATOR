// IPL auction rules as used for the 2026 mini auction. All money is in lakh (₹1 crore = 100 lakh).

export const SQUAD_MIN = 18;
export const SQUAD_MAX = 25;
export const OVERSEAS_MAX = 8;
export const MIN_PRICE = 30;            // lowest reserve price, used to keep enough purse to reach SQUAD_MIN
// Mini-auction rule: an overseas player's fee is capped at the top retention slab (₹18 Cr).
// The franchise pays the full bid from its purse; anything above the cap goes to the BCCI's player welfare fund.
export const OVERSEAS_FEE_CAP = 1800;

// Bid increments by current price band.
export function increment(price) {
  if (price < 100) return 5;
  if (price < 200) return 10;
  if (price < 500) return 20;
  return 25;
}

// The amount the next bid must be: the reserve price if nobody has bid yet.
export function nextBid(lot, player) {
  return lot.bidder == null ? player.base : lot.bid + increment(lot.bid);
}

export function overseasCount(team, players) {
  return team.squad.reduce((n, id) => n + (players[id].overseas ? 1 : 0), 0);
}

export function openSlots(team) { return SQUAD_MAX - team.squad.length; }

export function overseasSlots(team, players) { return OVERSEAS_MAX - overseasCount(team, players); }

// Highest bid a team may make while keeping ₹30 L for every slot it still must fill to reach 18 players.
export function maxAllowedBid(team) {
  const stillNeeded = Math.max(0, SQUAD_MIN - (team.squad.length + 1));
  return team.purse - stillNeeded * MIN_PRICE;
}

// Returns null if the team can bid `amount` for `player`, else a reason the UI can show.
export function bidBlocker(team, player, amount, players) {
  if (team.squad.length >= SQUAD_MAX) return 'Squad is full (25 players)';
  if (player.overseas && overseasCount(team, players) >= OVERSEAS_MAX) return 'All 8 overseas slots are filled';
  if (amount > team.purse) return 'Not enough purse left';
  if (amount > maxAllowedBid(team)) return `Must keep ₹30 L for each slot needed to reach ${SQUAD_MIN} players`;
  return null;
}

// The cap applies only in mini auctions; in a mega auction the player receives the full price.
export function playerFee(player, price, kind = 'mini') {
  return player.overseas && kind === 'mini' ? Math.min(price, OVERSEAS_FEE_CAP) : price;
}

// Auction phases for each rules mode.
// Full rules follow the real 2026 auction: the opening sets are called in order, then teams nominate
// names for accelerated rounds from everyone left (round 1), then from the unsold players (round 2).
// Quick auction calls only the capped marquee sets live, then one accelerated round.
export const MODES = {
  full: { label: 'Full rules', mainLastSet: 10, acceleratedRounds: 2, nominationsPerSlot: 3 },
  quick: { label: 'Quick auction', mainLastSet: 5, acceleratedRounds: 1, nominationsPerSlot: 2 },
};
