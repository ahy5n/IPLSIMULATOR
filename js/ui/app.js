// App shell: loads data, keeps the saved game, and switches between screens.
import { loadScenario, loadRetentions, SCENARIOS } from '../data.js';
import { createAuction } from '../engine/auction.js';
import { createSeason } from '../engine/season.js';
import { marketInflation } from '../engine/valuation.js';
import { startWorld, endSeason, suggestFor, applyRetentions, applyRealRetentions, buildAuction, scenarioFromWorld, teamPlayers, worldFromRealSquads, nextKind } from '../engine/dynasty.js';
import * as setupScreen from './setup.js';
import * as preScreen from './pre.js';
import * as auctionScreen from './auction.js';
import * as resultsScreen from './results.js';
import * as seasonScreen from './season.js';
import * as retainScreen from './retain.js';
import * as tradeScreen from './trade.js';

const SAVE_KEY = 'ipl-auction-sim:save:v1';
const SCREENS = { setup: setupScreen, pre: preScreen, auction: auctionScreen, results: resultsScreen, season: seasonScreen, retain: retainScreen, trade: tradeScreen };

const root = document.getElementById('app');
const cache = {};
let current = null;

// The real data folder behind each scenario (derived ones are built from IPL 2026).
const dataFor = (id) => (SCENARIOS.find((s) => s.id === id)?.derived ? 'ipl-2026' : id);

const ctx = {
  scn: null,
  game: null,
  async scenario(id) { return cache[id] || (cache[id] = await loadScenario(id)); },
  base() { return cache[dataFor(ctx.game.setup.scenario)]; },
  save() {
    try { if (ctx.game) localStorage.setItem(SAVE_KEY, JSON.stringify(ctx.game)); } catch { /* storage unavailable */ }
  },
  loadSave() {
    try { const s = localStorage.getItem(SAVE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  },
  clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } },

  async newGame(setup) {
    const meta = SCENARIOS.find((s) => s.id === setup.scenario);
    const base = await ctx.scenario(dataFor(setup.scenario));
    const seed = (Math.random() * 2 ** 31) >>> 0;
    ctx.game = { v: 2, setup: { ...setup, seed }, auction: null, season: null, world: null, speed: 'normal', screen: 'pre' };
    if (meta.derived) {
      // Projected 2027 and custom mega: start from the real 2026 squads, choose retentions first.
      const w = worldFromRealSquads(base, { kind: meta.derived === 'custom' ? 'mega' : 'mini', seed });
      ctx.game.world = w;
      ctx.scn = base;
      const real = meta.derived === 'projected' ? await loadRetentions(2027) : null;
      if (real) {
        // The real 2027 retentions are out: use them and go straight to the auction.
        applyRealRetentions(w, real);
        buildAuction(w, base.teams);
        ctx.scn = scenarioFromWorld(w, base);
        ctx.game.realRetentions = true;
        ctx.game.auction = createAuction(ctx.scn, { userTeam: setup.team, mode: setup.mode, difficulty: setup.difficulty, seed });
        ctx.save();
        ctx.go('pre');
        return;
      }
      ctx.game.offseason = { before: {}, retiredMine: [], retiredStars: [], prospects: 28, intro: meta.derived };
      ctx.game.retainPicks = suggestFor(w, setup.team);
      ctx.save();
      ctx.go('retain');
      return;
    }
    ctx.scn = base;
    ctx.game.auction = createAuction(base, { userTeam: setup.team, mode: setup.mode, difficulty: setup.difficulty, seed });
    ctx.save();
    ctx.go('pre');
  },

  async resume(saved) {
    const base = await ctx.scenario(dataFor(saved.setup.scenario));
    // Dynasty and derived games run on their own evolving copy of the world.
    ctx.scn = saved.world?.current ? scenarioFromWorld(saved.world, base) : base;
    if (saved.auction && saved.auction.inflation == null) {
      saved.auction.inflation = marketInflation(ctx.scn.teams, ctx.scn.teams.reduce((n, t) => n + 25 - t.retained.length, 0));
    }
    ctx.game = saved;
    ctx.go(saved.screen || 'pre');
  },

  // After the auction: the season, with contract fees (for replacement limits) and squad continuity.
  startSeason() {
    const g = ctx.game, a = g.auction, scn = ctx.scn;
    const squads = Object.fromEntries(Object.values(a.teams).map((t) => [t.id, t.squad]));
    const prices = {};
    for (const t of scn.teams) for (const id of t.retained) prices[id] = scn.players[id].price ?? 30;
    for (const t of Object.values(a.teams)) for (const b of t.bought) prices[b.id] = b.price;
    g.season = createSeason(scn, squads, { userTeam: g.setup.team, seed: (g.setup.seed + (scn.year || 0)) >>> 0, prices });
    ctx.save();
  },

  // Dynasty: the season is over. Age and develop players, then go to retentions for next year.
  startOffseason(finish) {
    const g = ctx.game;
    if (!g.world) g.world = startWorld(ctx.scn);
    const me = g.setup.team;
    const before = {};
    for (const id of g.season.squads[me].concat(g.auction.teams[me].squad)) before[id] = g.world.players[id].ovr;
    const out = endSeason(g.world, { auction: g.auction, season: g.season, userTeam: me, finish, seed: g.setup.seed });
    const P = g.world.players;
    g.offseason = {
      before,
      retiredMine: out.retired.filter((id) => P[id].team === me),
      retiredStars: out.retired.filter((id) => P[id].ovr >= 72).sort((a, b) => P[b].ovr - P[a].ovr).slice(0, 8),
      prospects: out.prospects.length,
    };
    g.retainPicks = suggestFor(g.world, me);
    g.season = null; g.prediction = null;
    ctx.save();
    ctx.go('retain');
  },

  confirmRetentions(ids) {
    const g = ctx.game, w = g.world, me = g.setup.team, base = ctx.base();
    const retained = {};
    for (const t of base.teams) retained[t.id] = t.id === me ? ids : suggestFor(w, t.id);
    applyRetentions(w, retained);
    buildAuction(w, base.teams);
    ctx.scn = scenarioFromWorld(w, base);
    g.auction = createAuction(ctx.scn, { userTeam: me, mode: g.setup.mode, difficulty: g.setup.difficulty, seed: (g.setup.seed + w.year) >>> 0 });
    g.offseason = null; g.retainPicks = null;
    ctx.save();
    ctx.go('pre');
  },

  nextKind() { return ctx.game.world ? nextKind(ctx.game.world) : ctx.scn.kind; },
  teamPlayers(teamId) { return teamPlayers(ctx.game.world, teamId); },

  go(screen) {
    if (current?.unmount) current.unmount();
    if (ctx.game && screen !== 'setup') { ctx.game.screen = screen; ctx.save(); }
    current = SCREENS[screen];
    root.innerHTML = '';
    window.scrollTo(0, 0);
    current.render(root, ctx);
  },
};

// Masthead "new game" link goes back to setup without losing the save.
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-nav="home"]');
  if (a) { e.preventDefault(); ctx.go('setup'); }
});

(async () => {
  try {
    await ctx.scenario('ipl-2026');
    ctx.go('setup');
  } catch (err) {
    root.innerHTML = `<div class="notice bad" style="margin-top:24px">Could not load the auction data: ${err.message}. Serve this folder over HTTP (for example <code>python3 tools/serve.py</code>) rather than opening the file directly.</div>`;
  }
})();
