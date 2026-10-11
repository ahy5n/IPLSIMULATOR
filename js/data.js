// Scenario loading. Each real scenario is a folder under data/scenarios/ with the same five files.
// "derived" scenarios are built in the browser from the IPL 2026 data (see js/engine/dynasty.js).

export const SCENARIOS = [
  { id: 'ipl-2026', name: 'IPL 2026 auction', kind: 'mini', when: '16 Dec 2025 · Abu Dhabi', blurb: 'Real retentions and purses, 369 registered players, 77 slots.', ready: true },
  { id: 'ipl-2027', name: 'IPL 2027 auction', kind: 'mini', derived: 'projected', when: 'Projected · retentions due Nov 2026', blurb: 'Starts from the real 2026 squads. You choose your retentions; AI teams choose theirs. Replaced by the real list once it is published.', ready: true },
  { id: 'ipl-2025', name: 'IPL 2025 mega auction', kind: 'mega', when: '24–25 Nov 2024 · Jeddah', blurb: 'Historic replay. 575 players, 46 real retentions, real purses and right-to-match cards.', ready: true },
  { id: 'custom-mega', name: 'Custom mega auction', kind: 'mega', derived: 'custom', when: 'Full ₹130 Cr purses · 2027 rules', blurb: 'Every team starts from its real 2026 squad with a full purse. Retain up to six (you first); everyone else goes back in.', ready: true },
];

export async function loadScenario(id, base = '.') {
  const get = async (f) => {
    const r = await fetch(`${base}/data/scenarios/${id}/${f}`);
    if (!r.ok) throw new Error(`Could not load ${f} (${r.status})`);
    return r.json();
  };
  const [meta, players, teams, pool, actual] = await Promise.all(
    ['meta.json', 'players.json', 'teams.json', 'pool.json', 'actual.json'].map(get));
  const byId = {};
  for (const p of players) byId[p.id] = p;
  return {
    id, year: meta.year, kind: meta.kind, cap: meta.cap, venue: meta.venue, date: meta.date, mainLastSet: meta.mainLastSet,
    champion: meta.champion, runnerUp: meta.runnerUp,
    players: byId, teams, pool, actual, teamById: Object.fromEntries(teams.map((t) => [t.id, t])),
  };
}

// Real retentions published for a season whose auction list is not out yet (written by
// tools/build_data.py --retentions <year> in the scheduled update). Null until then.
const retentionCache = {};
export async function loadRetentions(year, base = '.') {
  if (year in retentionCache) return retentionCache[year];
  try {
    const r = await fetch(`${base}/data/scenarios/ipl-${year}/retentions.json`);
    retentionCache[year] = r.ok ? await r.json() : null;
  } catch { retentionCache[year] = null; }
  return retentionCache[year];
}
