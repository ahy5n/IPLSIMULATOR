// The four leagues in career mode and their rules. activateLeague() switches every engine module
// (auction rules, squad limits, match format, injuries, currency) to one league before it runs.
//
// Money: every engine works in "lakh of the IPL scale". Each league converts with `rate` (local units
// per lakh), chosen so its real salary cap equals the IPL's ₹125 Cr: PSL 50.5 crore PKR (with the
// direct-signing extension), SA20 R41m, The Hundred £2.05m (men's 2026).
import { configureRules } from './rules.js';
import { configureSquad } from './squad.js';
import { configureFormat, FORMATS } from './match.js';
import { configureStatus } from './status.js';
import { configureValuation } from './valuation.js';
import { setCurrency } from '../format.js';

const IPL_CAP = 12500;

export const LEAGUES = {
  ipl: {
    id: 'ipl', short: 'IPL', name: 'Indian Premier League', home: 'India', nationality: 'Indian',
    currency: { sym: '₹', rate: 1, unit: 'crore' },
    squad: { min: 18, max: 25, overseas: 8 }, xiOverseas: 4, format: 't20', impact: true,
    minPrice: 30, overseasFeeCap: 1800, fixtures: 'ipl', playoffs: 'page', ruledOut: 6, games: 14,
    // Retention cycle: a mega auction every three years (last 2025), minis in between.
    cycle: { every: 3, last: 2025, megaMax: 6 },
    // Calendar (month, day). Retentions and the auction belong to next year's season.
    calendar: { retain: [11, 15], auction: [12, 16], season: [3, 28], seasonEnd: [5, 31], trade: [11, 1] },
    prestige: 100, valueScale: 1,
  },
  psl: {
    id: 'psl', short: 'PSL', name: 'Pakistan Super League', home: 'Pakistan', nationality: 'Pakistani',
    currency: { sym: 'PKR', rate: 5050 / IPL_CAP, unit: 'crore' },
    squad: { min: 16, max: 20, overseas: 7 }, xiOverseas: 4, format: 't20', impact: false,
    minPrice: Math.round(60 / (5050 / IPL_CAP)), overseasFeeCap: null, fixtures: 'psl', playoffs: 'page', ruledOut: 5, games: 10,
    // Two-year contracts since the first PSL auction (2026): retain up to four in an auction year.
    cycle: { every: 2, last: 2026, megaMax: 4 },
    calendar: { retain: [1, 20], auction: [2, 11], season: [3, 26], seasonEnd: [5, 3], trade: [3, 12] },
    prestige: 70, valueScale: 2.0,   // real 2026 fees run about 2x the IPL value curve
  },
  sa20: {
    id: 'sa20', short: 'SA20', name: 'SA20', home: 'South Africa', nationality: 'South African',
    currency: { sym: 'R', rate: 41000 / IPL_CAP, unit: 'thousand' },
    squad: { min: 17, max: 19, overseas: 7 }, xiOverseas: 4, format: 't20', impact: false,
    minPrice: Math.round(200 / (41000 / IPL_CAP)), overseasFeeCap: null, fixtures: 'double', playoffs: 'page', ruledOut: 5, games: 10,
    cycle: { every: 3, last: 2025, megaMax: 6 },
    // The season starts in January: its retentions and auction fall in the previous calendar year.
    calendar: { retain: [8, 5], auction: [10, 7], season: [1, 17], seasonEnd: [2, 21], trade: [7, 20] },
    prestige: 72, valueScale: 1.5,
  },
  hundred: {
    id: 'hundred', short: 'Hundred', name: 'The Hundred', home: 'England', nationality: 'English',
    currency: { sym: '£', rate: 2050 / IPL_CAP, unit: 'thousand' },
    squad: { min: 16, max: 18, overseas: 4 }, xiOverseas: 3, format: 'hundred', impact: false,
    minPrice: Math.round(30 / (2050 / IPL_CAP)), overseasFeeCap: null, fixtures: 'hundred', playoffs: 'top3', ruledOut: 4, games: 8,
    // Up to four pre-auction signings or retentions; a full auction every year since 2026.
    cycle: { every: 1, last: 2026, megaMax: 4 },
    calendar: { retain: [1, 31], auction: [3, 11], season: [7, 21], seasonEnd: [8, 16], trade: [11, 20] },
    prestige: 68, valueScale: 1.3,
  },
};
export const LEAGUE_IDS = Object.keys(LEAGUES);

// Groups and regional rivals the fixture lists use.
export const GROUPS = {
  ipl: { A: ['CSK', 'KKR', 'RR', 'RCB', 'PBKS'], B: ['MI', 'SRH', 'GT', 'DC', 'LSG'] },
  psl: { A: ['IU', 'LQ', 'MS', 'QG'], B: ['HK', 'KRK', 'PZ', 'RWP'] },
};
export const RIVALS = { hundred: { LS: 'MIL', MIL: 'LS', MSG: 'SRL', SRL: 'MSG', BPH: 'TR', TR: 'BPH', SB: 'WF', WF: 'SB' } };

let active = 'ipl';
export function activeLeague() { return LEAGUES[active]; }

export function activateLeague(id) {
  const L = LEAGUES[id];
  active = id;
  configureRules({ squadMin: L.squad.min, squadMax: L.squad.max, overseasMax: L.squad.overseas, minPrice: L.minPrice, overseasFeeCap: L.overseasFeeCap });
  configureSquad({ xiOverseas: L.xiOverseas, impact: L.impact });
  configureFormat(FORMATS[L.format]);
  configureStatus({ ruledOut: L.ruledOut });
  configureValuation({ valueScale: L.valueScale });
  setCurrency(id === 'ipl' ? null : L.currency);
  return L;
}

// Salary cap (IPL-scale lakh) for a season: every league's cap grows about 4% a year (the IPL's went from
// ₹120 Cr to ₹125 Cr between 2025 and 2026).
export function leagueCap(id, year) { return Math.round(IPL_CAP * Math.pow(1.04, Math.max(0, year - 2026)) / 5) * 5; }

// Is this an auction year with a capped number of retentions (the IPL's "mega", the PSL's two-year reset)?
export function isFullAuction(id, year) {
  const c = LEAGUES[id].cycle;
  return (year - c.last) % c.every === 0;
}

// Reserve price tiers by market value, in each league's own tiers converted to IPL-scale lakh.
export function reserveFor(id, value, capped) {
  const L = LEAGUES[id];
  if (id === 'ipl') {
    if (capped) return value >= 900 ? 200 : value >= 500 ? 150 : value >= 300 ? 125 : value >= 180 ? 100 : 75;
    return value >= 200 ? 50 : value >= 120 ? 40 : 30;
  }
  // Four tiers: about 7x, 3.7x, 1.8x and 1x the minimum fee (the PSL's 4.2 Cr / 2.2 Cr / 1.1 Cr / 60 L).
  const m = L.minPrice;
  return value >= m * 9 ? m * 7 : value >= m * 5 ? Math.round(m * 3.7) : value >= m * 2.4 ? Math.round(m * 1.8) : m;
}

export const leagueOf = (id) => LEAGUES[id];
