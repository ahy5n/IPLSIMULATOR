// New game: five choices on one screen, then straight into the auction (or retentions first).
import { SCENARIOS, loadRetentions } from '../data.js';
import { MODES } from '../engine/rules.js';
import { DIFFICULTY } from '../engine/valuation.js';
import { esc, money } from '../format.js';
import { badge } from './components.js';
import { masthead, footer } from './shell.js';
import { LEAGUES, LEAGUE_IDS } from '../engine/league.js';
import { fmtDate } from '../engine/career.js';

const choice = { game: 'career', scenario: 'ipl-2026', team: null, mode: 'full', difficulty: 'medium', length: 'single', league: 'ipl', cteam: null, offers: 'offers' };

const LEAGUE_TEXT = {
  ipl: '10 teams · 25-man squads, 8 overseas · two impact players · auction every December, mega every third year.',
  psl: '8 teams · 16 to 20 players, up to 7 overseas · first auction in 2026, two-year contracts.',
  sa20: '6 teams · 17 to 19 players, 7 overseas · January season, auction in October.',
  hundred: '8 teams · 100-ball matches, 3 overseas in the XI · auction in March, season in July and August.',
};

const MODE_TEXT = {
  mini: {
    full: 'The opening 10 sets are called in order, then two accelerated rounds of nominated players, as on 16 Dec 2025.',
    quick: 'The five capped marquee sets live, then one accelerated round. About a third of the lots.',
  },
  mega: {
    full: 'Two marquee sets, then capped and uncapped sets to lot 116, then two accelerated rounds, as in Jeddah 2024. Right-to-match cards in play.',
    quick: 'Marquee and capped sets live, then one accelerated round. Right-to-match cards in play.',
  },
};
const DIFF_TEXT = {
  easy: 'Rivals misjudge value and blow their purse early.',
  medium: 'Rivals value players sensibly with some mistakes.',
  hard: 'Rivals price accurately, chase their needs and pace their purse.',
};

const dataFor = (id) => (SCENARIOS.find((s) => s.id === id)?.derived ? 'ipl-2026' : id);

function teamLine(sc, t, data) {
  if (sc.derived === 'custom') return `₹130 Cr · retain up to 6`;
  if (sc.derived === 'projected') {
    const squad = t.retained.length + Object.values(data.actual).filter((a) => a.team === t.id).length;
    return `${squad} in 2026 squad`;
  }
  return `${money(t.purse)} · ${25 - t.retained.length} slots${t.rtm != null ? ` · ${t.rtm} RTM` : ''}`;
}

export function render(root, ctx) {
  const saved = ctx.loadSave();
  const draw = async () => {
    // Once the scheduled update has published real 2027 retentions, the 2027 card says so.
    const real2027 = await loadRetentions(2027);
    const p27 = SCENARIOS.find((s) => s.id === 'ipl-2027');
    if (real2027 && p27.derived === 'projected') {
      p27.when = 'Real retentions published';
      p27.blurb = 'Every team\'s real 2027 retentions, applied to the 2026 squads. The auction pool is everyone released plus unsold players and new prospects.';
      p27.real = true;
    }
    const sc = SCENARIOS.find((s) => s.id === choice.scenario);
    const data = await ctx.scenario(dataFor(choice.scenario));
    const world = await ctx.worldData();
    const savedData = saved && !saved.career ? await ctx.scenario(dataFor(saved.setup.scenario)) : null;
    const savedTeam = saved && (saved.career ? careerTeam(saved) : savedData.teamById[saved.setup.team]);
    const gameSwitch = `<div class="seg" role="group" aria-label="Game"><button data-game="career" aria-pressed="${choice.game === 'career'}">Career · four leagues</button><button data-game="single" aria-pressed="${choice.game === 'single'}">Single auction</button></div>`;
    const resumeCard = saved && savedTeam ? `<section class="panel spread">
        <div class="row">${badge(savedTeam)}<div><strong>Saved ${saved.career ? 'career' : 'game'}: ${esc(savedTeam.name)}</strong><div class="muted" style="font-size:.86rem">${describeSave(saved)}</div></div></div>
        <button class="btn btn-primary" data-act="resume">Continue</button>
      </section>` : '';
    if (choice.game === 'career') {
      const teams = world.teams[choice.league];
      const coachOf = (tid) => world.coaches.find((c) => c.jobs[choice.league] === tid);
      root.innerHTML = `${masthead()}
      <main class="stack-lg">
        <section class="stack" style="padding-top:14px">
          ${gameSwitch}
          <h1>Coach across four leagues</h1>
          <p class="muted">Take over one franchise as head coach. The IPL, PSL, SA20 and The Hundred run on one calendar with the same players: retentions, auctions, trade windows and seasons, in date order. Win and other clubs come calling; lose and the board can sack you. Squads, fees and coaches are as of ${fmtDate(world.date.split('-').map(Number))}.</p>
        </section>
        ${resumeCard}
        <section class="stack">
          <div class="section-head"><h3>League</h3></div>
          <div class="tabs" role="tablist">${LEAGUE_IDS.map((id) => `<button role="tab" data-league="${id}" aria-selected="${choice.league === id}">${LEAGUES[id].short}</button>`).join('')}</div>
          <p class="muted" style="font-size:.88rem">${LEAGUE_TEXT[choice.league]}</p>
        </section>
        <section class="stack">
          <div class="section-head"><h3>Your club</h3><span class="muted" style="font-size:.85rem">You replace its current head coach</span></div>
          <div class="team-grid">${teams.map((t) => `
            <button class="team-pick" data-cteam="${t.id}" aria-pressed="${choice.cteam === t.id}" style="--c1:${t.color};--c2:${t.color2}">
              ${badge(t)}<span><strong>${t.id}</strong><span class="nm" style="display:block">${esc(t.name)}${coachOf(t.id) ? ` · ${esc(coachOf(t.id).name)}` : ''}</span></span>
            </button>`).join('')}</div>
        </section>
        <section class="stack">
          <div class="section-head"><h3>Jobs</h3></div>
          <div class="choice-grid">
            <button class="choice" data-offers="offers" aria-pressed="${choice.offers === 'offers'}"><span class="title">Offers on merit</span><small>Clubs in any league offer you jobs when your results earn them. Accept or decline; you can hold one job per league.</small></button>
            <button class="choice" data-offers="free" aria-pressed="${choice.offers === 'free'}"><span class="title">Free choice</span><small>Take any job in any league whenever its season isn't running.</small></button>
          </div>
        </section>
        <section class="grid-2">
          <div class="stack">
            <div class="section-head"><h3>Your auctions</h3></div>
            <div class="seg" role="group" aria-label="Rules">${Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}" aria-pressed="${choice.mode === k}">${m.label}</button>`).join('')}</div>
          </div>
          <div class="stack">
            <div class="section-head"><h3>Difficulty</h3></div>
            <div class="seg" role="group" aria-label="Difficulty">${Object.entries(DIFFICULTY).map(([k, d]) => `<button data-diff="${k}" aria-pressed="${choice.difficulty === k}">${d.label}</button>`).join('')}</div>
            <p class="muted" style="font-size:.86rem">${DIFF_TEXT[choice.difficulty]}</p>
          </div>
        </section>
        <div class="stack">
          <button class="btn btn-primary btn-block bid-btn" data-act="career" ${choice.cteam ? '' : 'disabled'}>${choice.cteam ? `Start as head coach of ${esc(teams.find((t) => t.id === choice.cteam).name)}` : 'Pick a club to start'}</button>
          ${saved ? '<p class="muted" style="font-size:.85rem">Starting a new game replaces your saved game.</p>' : ''}
        </div>
      </main>${footer()}`;
      return;
    }
    const later = sc.derived ? 'after this auction' : `after ${data.year}`;
    root.innerHTML = `${masthead()}
    <main class="stack-lg">
      <section class="stack" style="padding-top:14px">
        ${gameSwitch}
        <h1>Pick a franchise and run its auction</h1>
        <p class="muted">You run one team against nine AI franchises, using the real retentions and purses. After the auction you play the season: pick the XI and impact players, choose your home pitch, and manage form, fitness and injuries.</p>
      </section>

      ${resumeCard}

      <section class="stack">
        <div class="section-head"><h3>Scenario</h3></div>
        <div class="choice-grid">${SCENARIOS.map((s) => `
          <button class="choice" data-scenario="${s.id}" aria-pressed="${choice.scenario === s.id}" ${s.ready ? '' : 'disabled'}>
            <span class="title">${esc(s.name)}</span>
            <small class="when">${s.kind === 'mega' ? 'Mega auction' : 'Mini auction'} · ${esc(s.when)}</small><small>${esc(s.blurb)}</small>
          </button>`).join('')}</div>
      </section>

      <section class="stack">
        <div class="section-head"><h3>Your franchise</h3><span class="muted" style="font-size:.85rem">The other nine are AI</span></div>
        <div class="team-grid">${data.teams.map((t) => `
          <button class="team-pick" data-team="${t.id}" aria-pressed="${choice.team === t.id}" style="--c1:${t.color};--c2:${t.color2}">
            ${badge(t)}<span><strong>${t.id}</strong><span class="nm" style="display:block">${teamLine(sc, t, data)}</span></span>
          </button>`).join('')}</div>
        <p class="muted" style="font-size:.86rem">${choice.team ? esc(data.teamById[choice.team].name) + ' selected.' : sc.id === 'ipl-2025' ? 'Pick a team. PBKS start with ₹110.5 Cr and four RTM cards; RR and KKR kept six and have none.' : 'Pick a team to continue.'}</p>
      </section>

      <section class="grid-2">
        <div class="stack">
          <div class="section-head"><h3>Rules</h3></div>
          <div class="seg" role="group" aria-label="Rules">${Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}" aria-pressed="${choice.mode === k}">${m.label}</button>`).join('')}</div>
          <p class="muted" style="font-size:.86rem">${MODE_TEXT[sc.kind][choice.mode]}</p>
        </div>
        <div class="stack">
          <div class="section-head"><h3>Difficulty</h3></div>
          <div class="seg" role="group" aria-label="Difficulty">${Object.entries(DIFFICULTY).map(([k, d]) => `<button data-diff="${k}" aria-pressed="${choice.difficulty === k}">${d.label}</button>`).join('')}</div>
          <p class="muted" style="font-size:.86rem">${DIFF_TEXT[choice.difficulty]}</p>
        </div>
      </section>

      <section class="stack">
        <div class="section-head"><h3>Length</h3></div>
        <div class="choice-grid">
          <button class="choice" data-length="single" aria-pressed="${choice.length === 'single'}"><span class="title">Single season</span><small>One auction, one season.</small></button>
          <button class="choice" data-length="dynasty" aria-pressed="${choice.length === 'dynasty'}"><span class="title">Dynasty</span><small>Keep going ${later}: players age and develop, you choose retentions, and the IPL cycle runs two mini auctions then a mega auction.</small></button>
        </div>
      </section>

      <div class="stack">
        <button class="btn btn-primary btn-block bid-btn" data-act="start" ${choice.team ? '' : 'disabled'}>${choice.team ? (sc.derived && !sc.real ? `Choose ${choice.team}'s retentions` : `Start the auction as ${choice.team}`) : 'Pick a team to start'}</button>
        ${saved ? '<p class="muted" style="font-size:.85rem">Starting a new game replaces your saved game.</p>' : ''}
      </div>
    </main>${footer()}`;
  };

  root.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.game) choice.game = b.dataset.game;
    else if (b.dataset.league) { choice.league = b.dataset.league; choice.cteam = null; }
    else if (b.dataset.cteam) choice.cteam = b.dataset.cteam;
    else if (b.dataset.offers) choice.offers = b.dataset.offers;
    else if (b.dataset.act === 'career') { root.onclick = null; return ctx.newCareer({ league: choice.league, team: choice.cteam, mode: choice.offers, difficulty: choice.difficulty, auctionMode: choice.mode }); }
    else if (b.dataset.scenario) choice.scenario = b.dataset.scenario;
    else if (b.dataset.team) choice.team = b.dataset.team;
    else if (b.dataset.mode) choice.mode = b.dataset.mode;
    else if (b.dataset.diff) choice.difficulty = b.dataset.diff;
    else if (b.dataset.length) choice.length = b.dataset.length;
    else if (b.dataset.act === 'start') { root.onclick = null; return ctx.newGame({ ...choice }); }
    else if (b.dataset.act === 'resume') { root.onclick = null; return ctx.resume(saved); }
    else return;
    const y = window.scrollY;
    await draw();
    window.scrollTo(0, y);
  };
  draw();
}

export function unmount() { document.getElementById('app').onclick = null; }

function careerTeam(g) {
  const lg = Object.keys(g.career.coaches.you.jobs)[0];
  return lg ? g.career.teams[lg].find((t) => t.id === g.career.coaches.you.jobs[lg]) : { name: 'Out of work', color: '#888', color2: '#bbb' };
}

function describeSave(g) {
  if (g.career) {
    const you = g.career.coaches.you;
    const jobs = Object.entries(you.jobs).map(([lg, t]) => `${LEAGUES[lg].short} ${t}`).join(', ') || 'no job';
    const d = g.career.date;
    return `${fmtDate(d)} · ${jobs} · reputation ${Math.round(you.rep)}`;
  }
  const where = { pre: 'Before the auction', auction: 'In the auction room', results: 'Auction finished', trade: 'Trade window', season: 'In the season', retain: 'Choosing retentions' }[g.screen] || '';
  const extra = g.season ? ` · ${g.season.fixtures.filter((f) => f.result).length}/70 league games played` : g.auction ? ` · ${g.auction.sold.length} players sold` : '';
  const year = g.world ? `IPL ${g.world.year} · ` : g.auction?.year ? `IPL ${g.auction.year} · ` : '';
  const sc = SCENARIOS.find((s) => s.id === g.setup.scenario);
  return `${year}${where}${extra} · ${sc ? sc.name + ', ' : ''}${MODES[g.setup.mode].label}, ${DIFFICULTY[g.setup.difficulty].label}${g.setup.length === 'dynasty' ? ', dynasty' : ''}`;
}
