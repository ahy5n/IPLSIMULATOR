// Season: next match, team selection, scorecards, table, fixtures, stats, squad condition, injuries,
// replacement signings, playoffs and awards.
import { esc, money, oversText, ordinal, ROLE_LABEL } from '../format.js';
import { standings, nrr, playFixture, nextFixture, nextUserFixture, simToUserGame, autoLineup, lineupProblem, teamOfPlayer, fixtureConditions, carriedLineup } from '../engine/season.js';
import { statusOf, isAvailable, matchMods, chemistryChange, pendingReplacements, replacementPool, signReplacement, unavailable } from '../engine/status.js';
import { XI_OVERSEAS_MAX, IMPACT } from '../engine/squad.js';
import { FORMAT } from '../engine/match.js';
import { CONDITIONS, VENUE_DEFAULT, adjustPlayers } from '../engine/conditions.js';
import { bandsLabel, bandsRange, positionFit, arrangeOrder, orderPenalty, styleLabel } from '../engine/batting.js';
import { typeLabel, rolesLabel } from '../engine/bowling.js';
import { badge, teamChip, osTag, roleTag, meter, formMeter, fitMeter, groupByPosition } from './components.js';
import { masthead, footer } from './shell.js';

export function unmount() {}

export function render(root, ctx) {
  const { scn, game } = ctx;
  const s = game.season;
  const me = game.setup.team;
  const T = scn.teamById;
  const P = scn.players;
  const ui = { view: s.stage === 'done' ? 'end' : 'home', tab: 'table', match: null, lineup: null, carried: null, repl: { role: 'ALL' } };

  const involves = (fx) => fx.home === me || fx.away === me;
  const allFx = () => [...s.fixtures, ...s.playoffs];
  const myRow = () => standings(s).findIndex((r) => r.id === me) + 1;
  const chem = (t) => s.chem?.[t]?.value ?? 50;
  const LG = scn.league?.short || 'IPL';
  const NG = s.fixtures.length;
  // Innings length: overs in T20, balls in The Hundred.
  const ovs = (balls) => (FORMAT.unit === 'ball' ? `${balls} balls` : `${oversText(balls)} ov`);
  // Economy: runs an over in T20; in The Hundred, runs per set of five balls.
  const hundred = FORMAT.unit === 'ball';
  const econ = (r, b) => (b ? ((r / b) * (hundred ? 5 : 6)).toFixed(2) : '–');
  const econLabel = hundred ? 'Runs per 5' : 'Econ';
  const ORANGE = LG === 'IPL' ? 'Orange Cap' : 'Most runs', PURPLE = LG === 'IPL' ? 'Purple Cap' : 'Most wickets';

  function draw() {
    root.innerHTML = `${masthead(`<span class="tag">${s.stage === 'league' ? `League · ${s.fixtures.filter((f) => f.result).length}/${NG}` : s.stage === 'playoffs' ? 'Playoffs' : 'Season over'}</span>`)}
      <main class="stack-lg" style="padding-top:8px">${body()}</main>${footer()}`;
    window.scrollTo(0, ui.keepScroll ?? 0);
    ui.keepScroll = null;
  }

  function body() {
    if (pendingReplacements(s, me).length && ui.view !== 'match') return replacementView();
    if (ui.view === 'select') return selectView();
    if (ui.view === 'match') return matchView(ui.match);
    if (ui.view === 'end') return endView() + tabsView();
    return homeView() + tabsView();
  }

  // ---------- home ----------
  function homeView() {
    const row = s.table[me];
    const fx = nextFixture(s);
    const mine = nextUserFixture(s);
    const last = allFx().filter((f) => f.result && involves(f)).slice(-1)[0];
    const hurt = s.squads[me].filter((id) => !isAvailable(s, id));
    const news = (s.injuryLog || []).filter((n) => n.team === me).slice(-3).reverse();
    return `<section class="stack">
      <div class="row">${badge(T[me])}<span class="eyebrow">${esc(T[me].name)} · ${LG} ${scn.year}</span></div>
      <div class="stats">
        <div class="stat"><span class="k">Played</span><span class="v">${row.p}</span></div>
        <div class="stat"><span class="k">Won</span><span class="v good">${row.w}</span></div>
        <div class="stat"><span class="k">Lost</span><span class="v bad">${row.l}</span></div>
        <div class="stat"><span class="k">Points</span><span class="v accent">${row.pts}</span></div>
        <div class="stat"><span class="k">NRR</span><span class="v">${fmtNrr(nrr(row))}</span></div>
        <div class="stat"><span class="k">Position</span><span class="v">${row.p ? ordinal(myRow()) : '—'}</span></div>
      </div>
      <div class="panel-flat grid-2" style="gap:10px">
        <div class="meter-row"><span class="eyebrow">Team chemistry</span>${meter(chem(me), 'var(--data)', { large: true, label: 'Chemistry' })}<strong class="num">${Math.round(chem(me))}</strong></div>
        <div class="meter-row"><span class="eyebrow">Available</span><span class="muted" style="font-size:.85rem">${s.squads[me].length - hurt.length} of ${s.squads[me].length}${hurt.length ? ` · ${hurt.length} injured` : ''}</span><span></span></div>
      </div>
      ${news.length ? `<div class="stack" style="gap:6px">${news.map((n) => `<div class="notice ${n.ruledOut ? 'bad' : 'warn'}"><span><strong>${esc(P[n.id].name)}</strong>: ${esc(n.injury.toLowerCase())}, ${n.ruledOut ? 'ruled out of the season' : `out for ${n.matches} match${n.matches === 1 ? '' : 'es'}`} <span class="muted">(match ${n.match})</span></span></div>`).join('')}</div>` : ''}
    </section>
    ${last ? `<section class="panel spread" style="cursor:pointer" data-open="${last.no}">
      <span class="muted" style="font-size:.86rem">Last game · Match ${last.no}</span>
      <span>${resultLine(last)}</span><span class="tag">Scorecard</span></section>` : ''}
    ${fx ? nextCard(fx, mine) : ''}`;
  }

  function nextCard(fx, mine) {
    const isMine = involves(fx);
    const stageLabel = fx.stage === 'league' ? `Match ${fx.no} of ${NG}` : fx.stage;
    const gamesBefore = mine ? allFx().filter((f) => !f.result && f.no < mine.no && f.stage === mine.stage).length : 0;
    return `<section class="lot">
      <div class="lot-top">
        <div class="lot-meta"><span class="tag tag-accent">${isMine ? 'Your next match' : 'Next match'}</span><span class="tag">${esc(stageLabel)}</span><span class="tag">${fx.neutral ? 'Neutral venue' : esc(T[fx.home].home)}</span><span class="tag tag-data">${fx.home === me && !fx.neutral ? 'Your pitch: you pick' : esc(CONDITIONS[fixtureConditions(s, scn, fx)].label)}</span></div>
        <div class="match-card">
          <div class="side">${badge(T[fx.home])}<strong>${esc(T[fx.home].name)}</strong>${rec(fx.home)}</div>
          <span class="vs">VS</span>
          <div class="side">${badge(T[fx.away])}<strong>${esc(T[fx.away].name)}</strong>${rec(fx.away)}</div>
        </div>
      </div>
      <div class="lot-bid" style="grid-template-columns:1fr">
        ${isMine ? `<div class="grid-2">
          <button class="btn btn-primary bid-btn" data-act="select">Pick your XI</button>
          <button class="btn bid-btn" data-act="quick">${s.userXI ? 'Play with last XI' : 'Play with auto XI'}</button>
        </div>` : `<div class="grid-2">
          <button class="btn btn-primary bid-btn" data-act="simto">${mine ? `Sim to your next match (${gamesBefore} game${gamesBefore === 1 ? '' : 's'})` : 'Sim the rest of the season'}</button>
          <button class="btn bid-btn" data-act="simone">Sim this match</button>
        </div>`}
      </div>
    </section>`;
  }

  const rec = (id) => `<span class="muted num" style="font-size:.84rem">${s.table[id].w}–${s.table[id].l} · ${s.table[id].pts} pts</span>`;

  function resultLine(fx) {
    const r = fx.result;
    if (r.noResult) return `${fx.home} v ${fx.away}: no result (rain)`;
    const [i1, i2] = r.innings;
    return `<strong>${r.winner}</strong> ${esc(r.summary)} <span class="muted num">· ${i1.team} ${i1.runs}/${i1.wkts}, ${i2.team} ${i2.runs}/${i2.wkts}</span>`;
  }

  // ---------- injury replacement ----------
  function replacementView() {
    const r = pendingReplacements(s, me)[0];
    const out = P[r.out];
    const fee = s.prices?.[r.out] ?? out.price ?? 30;
    const pool = replacementPool(s, scn, me, r.out).filter((p) => ui.repl.role === 'ALL' || p.role === ui.repl.role).slice(0, 30);
    const roles = [['ALL', 'All'], ['BAT', 'Batters'], ['WK', 'Keepers'], ['AR', 'All-rounders'], ['BOWL', 'Bowlers']];
    return `<section class="stack">
      <span class="eyebrow">Injury replacement · ${esc(T[me].name)}</span>
      <h2>${esc(out.name)} is ruled out</h2>
      <p class="muted">${esc(r.injury)} in match ${r.match}. Under ${LG} rules you can sign a replacement from the unsold registered players, paid no more than his ${money(fee)} fee. The replacement takes his place in the squad for the rest of the season.</p>
      <div class="seg" role="group" aria-label="Filter">${roles.map(([k, l]) => `<button data-replrole="${k}" aria-pressed="${ui.repl.role === k}">${l}</button>`).join('')}</div>
      <div class="panel">${pool.map((p) => `<div class="pick-row" style="grid-template-columns:1fr auto auto">
        <span style="min-width:0"><strong>${esc(p.name)}</strong> ${osTag(p)} ${roleTag(p)}<span class="sub-line">${esc(p.country)} · bat ${p.bat} · bowl ${p.bowl} · ${bandsLabel(p)}</span></span>
        <span class="tag">${p.ovr}</span>
        <button class="btn btn-sm btn-primary" data-sign="${p.id}">Sign · ${money(p.base ?? 30)}</button></div>`).join('') || '<p class="muted">Nobody eligible in this group.</p>'}</div>
      <button class="btn" data-act="skiprepl">Carry on without a replacement</button>
    </section>`;
  }

  // ---------- tabs ----------
  function tabsView() {
    const tabs = [['table', 'Table'], ['fixtures', 'Fixtures'], ['stats', 'Stats'], ['squad', 'Squad']];
    return `<section class="stack" style="gap:0">
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${ui.tab === k}">${l}</button>`).join('')}</div>
      <div class="panel tab-body">${tabBody()}</div>
    </section>`;
  }

  function tabBody() {
    if (ui.tab === 'table') return tableView();
    if (ui.tab === 'fixtures') return fixturesView();
    if (ui.tab === 'stats') return statsView();
    return squadView();
  }

  function tableView() {
    const rows = standings(s);
    return `<div class="scroll-x"><table>
      <thead><tr><th>#</th><th>Team</th><th class="r">P</th><th class="r">W</th><th class="r">L</th><th class="r">NR</th><th class="r">NRR</th><th class="r">Pts</th><th class="hide-sm">Chem</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.id === me ? 'me' : ''}" style="${i === 3 ? 'border-bottom:2px solid var(--accent)' : ''}">
        <td class="num">${i + 1}</td><td>${teamChip(T[r.id])}</td><td class="r">${r.p}</td><td class="r">${r.w}</td><td class="r">${r.l}</td><td class="r">${r.nr}</td><td class="r">${fmtNrr(nrr(r))}</td><td class="r"><strong>${r.pts}</strong></td><td class="hide-sm">${meter(chem(r.id), 'var(--data)', { label: 'Chemistry' })}</td></tr>`).join('')}
      </tbody></table></div><p class="muted" style="font-size:.8rem;margin-top:8px">Top four reach the playoffs. Ties split on net run rate.</p>`;
  }

  function fixturesView() {
    const list = allFx().filter((f) => (ui.onlyMine ? involves(f) : true));
    return `<div class="spread" style="margin-bottom:8px"><span class="muted" style="font-size:.85rem">${list.length} matches</span>
      <button class="btn btn-sm" data-act="onlymine">${ui.onlyMine ? 'Show all teams' : 'Only my matches'}</button></div>
      <div class="feed">${list.map((f) => `<div class="feed-item" ${f.result ? `data-open="${f.no}" style="cursor:pointer"` : ''}>
        <span class="mono muted" style="min-width:34px">${f.stage === 'league' ? f.no : f.stage.replace('Qualifier ', 'Q').replace('Eliminator', 'EL').replace('Final', 'F')}</span>
        <span class="${involves(f) ? 'accent' : ''}">${f.home} v ${f.away}${f.result ? ` <span class="muted" style="font-size:.85rem">· ${f.result.noResult ? 'No result' : `${f.result.winner} ${esc(f.result.summary)}`}</span>` : ''}</span>
        <span>${f.result ? '<span class="tag">Card</span>' : ''}</span></div>`).join('')}</div>`;
  }

  function statsView() {
    if (!Object.keys(s.stats).length) return '<p class="muted">Stats appear after the first match.</p>';
    const all = Object.values(s.stats);
    const nameT = (id) => `${esc(P[id].name)} <span class="muted" style="font-size:.8rem">${teamOfPlayer(s, id) || ''}</span>`;
    const runs = all.slice().sort((a, b) => b.r - a.r).slice(0, 5);
    const wk = all.slice().sort((a, b) => b.w - a.w || a.rc / Math.max(1, a.bb) - b.rc / Math.max(1, b.bb)).slice(0, 5);
    return `<div class="grid-2">
      <div><h3 style="color:var(--accent)">${ORANGE}</h3><table><tbody>${runs.map((x) => `<tr class="${teamOfPlayer(s, x.id) === me ? 'me' : ''}"><td>${nameT(x.id)}</td><td class="r"><strong>${x.r}</strong></td><td class="r muted">SR ${x.b ? ((x.r / x.b) * 100).toFixed(0) : 0}</td></tr>`).join('')}</tbody></table></div>
      <div><h3 style="color:var(--purple)">${PURPLE}</h3><table><tbody>${wk.map((x) => `<tr class="${teamOfPlayer(s, x.id) === me ? 'me' : ''}"><td>${nameT(x.id)}</td><td class="r"><strong>${x.w}</strong></td><td class="r muted">${econLabel} ${econ(x.rc, x.bb)}</td></tr>`).join('')}</tbody></table></div>
    </div>`;
  }

  function squadView() {
    const groups = groupByPosition(s.squads[me].map((id) => P[id]));
    return `<div class="scroll-x"><table><thead><tr><th>Player</th><th>Condition</th><th class="r">M</th><th class="r">Runs</th><th class="r">Wkts</th></tr></thead><tbody>
      ${groups.map((g) => `<tr class="group"><td colspan="5">${g.label}</td></tr>${g.players.map((p) => {
        const x = s.stats[p.id] || { m: 0, r: 0, w: 0 };
        const st = statusOf(s, p.id);
        return `<tr><td><strong>${esc(p.name)}</strong>${osTag(p)} ${roleTag(p)}${st.inj > 0 ? ` <span class="tag tag-bad">${esc(st.injury || 'Injured')} · ${st.inj}</span>` : ''}<span class="sub-line">${bandsLabel(p)} · bat ${p.bat} · bowl ${p.bowl}</span></td>
          <td>${formMeter(st.form)}${fitMeter(st.fit)}</td>
          <td class="r">${x.m}</td><td class="r">${x.r}</td><td class="r">${x.w}</td></tr>`;
      }).join('')}`).join('')}
      </tbody></table></div>`;
  }

  // ---------- team selection ----------
  function startSelect() {
    const fx = nextUserFixture(s);
    simToUserGame(s, scn);   // games before yours are played first, so the table and injuries are current
    ui.cond = fixtureConditions(s, scn, fx);
    const c = carriedLineup(s, scn, ui.cond);
    ui.lineup = { xi: c.lineup.xi.slice(), impact: { ...c.lineup.impact } };
    ui.swapIn = null;
    ui.carried = c;
    ui.view = 'select';
    draw();
  }

  function selectView() {
    const fx = nextUserFixture(s);
    const opp = fx.home === me ? fx.away : fx.home;
    const L = ui.lineup;
    const sq = s.squads[me];
    const os = L.xi.filter((id) => P[id].overseas).length;
    const problem = lineupProblem(L, sq, P, s);
    const home = fx.home === me && !fx.neutral;
    const C = CONDITIONS[ui.cond] || CONDITIONS.balanced;
    const mods = matchMods(s, me, sq);
    const adj = adjustPlayers(P, sq, ui.cond);
    const bowlers = L.xi.filter((id) => adj[id].bowl >= 55).length;
    const lost = orderPenalty(L.xi, P);
    const cc = chemistryChange(s, me, L.xi);
    const benchIds = sq.filter((id) => !L.xi.includes(id));
    const bench = benchIds.map((id) => P[id]).sort((a, b) => (isAvailable(s, a.id) ? 0 : 1) - (isAvailable(s, b.id) ? 0 : 1) || b.ovr - a.ovr);
    const skill = (p) => {
      const m = mods[p.id]?.bat || 0;
      const b = adj[p.id].bowl;
      return `bat ${p.bat}${Math.abs(m) >= 0.5 ? ` <span class="${m > 0 ? 'good' : 'bad'}">${m > 0 ? '+' : ''}${m.toFixed(0)}</span>` : ''} · bowl ${b}${b !== p.bowl ? ` <span class="${b > p.bowl ? 'good' : 'bad'}">(${b > p.bowl ? '+' : ''}${b - p.bowl})</span>` : ''}`;
    };
    const statusBits = (p) => {
      const st = statusOf(s, p.id);
      return `${formMeter(st.form)}${fitMeter(st.fit)}`;
    };
    const carriedNote = ui.carried?.carried
      ? `Your XI from last match carries over${ui.carried.changes.length ? `; ${ui.carried.changes.map((c) => `${esc(P[c.out].name)} (injured) replaced by ${c.in ? esc(P[c.in].name) : 'nobody'}`).join('; ')}` : ' unchanged'}.`
      : 'First match: the best XI for these conditions is picked for you.';
    return `<section class="stack">
      <span class="eyebrow">${fx.stage === 'league' ? `Match ${fx.no}` : esc(fx.stage)} · vs ${esc(T[opp].name)} · ${fx.neutral ? 'Neutral venue' : esc(T[fx.home].home)}</span>
      <h2>Pick your XI</h2>
      <div class="panel stack" style="gap:10px">
        <div class="spread"><h3>Conditions</h3><span class="muted" style="font-size:.85rem">${home ? `Your home game: you choose. Usual here: ${CONDITIONS[VENUE_DEFAULT[me] || 'balanced'].label}` : fx.neutral ? 'Playoffs are played at a neutral venue' : `Set by ${esc(T[fx.home].name)}`}</span></div>
        ${home ? `<div class="seg" role="group" aria-label="Conditions">${Object.entries(CONDITIONS).map(([k, c]) => `<button data-cond="${k}" aria-pressed="${ui.cond === k}">${c.label}</button>`).join('')}</div>` : `<strong>${C.label}</strong>`}
        <p class="muted" style="font-size:.87rem">${esc(C.blurb)} Pace ${C.pace >= 0 ? '+' : ''}${C.pace}, spin ${C.spin >= 0 ? '+' : ''}${C.spin} to bowling ratings.</p>
      </div>
      <div class="stats">
        <div class="stat"><span class="k">Picked</span><span class="v ${L.xi.length === 11 ? 'good' : 'bad'}">${L.xi.length}/11</span></div>
        <div class="stat"><span class="k">Overseas</span><span class="v ${os > XI_OVERSEAS_MAX ? 'bad' : ''}">${os}/${XI_OVERSEAS_MAX}</span></div>
        <div class="stat"><span class="k">Bowling options</span><span class="v ${bowlers < 5 ? 'bad' : ''}">${bowlers}</span></div>
        <div class="stat"><span class="k">Keeper</span><span class="v">${L.xi.some((id) => P[id].role === 'WK') ? 'Yes' : '<span class="bad">No</span>'}</span></div>
        <div class="stat"><span class="k">Out of position</span><span class="v ${lost > 8 ? 'bad' : ''}">−${lost.toFixed(0)} bat</span></div>
        <div class="stat"><span class="k">Chemistry</span><span class="v">${Math.round(chem(me))} <span class="${cc.delta >= 0 ? 'good' : 'bad'}" style="font-size:.8rem">${cc.delta >= 0 ? '+' : ''}${cc.delta.toFixed(1)}</span></span></div>
      </div>
      <div class="notice ${problem ? 'bad' : ''}">${problem ? esc(problem) : `${carriedNote} ${cc.changes ? `${cc.changes} change${cc.changes === 1 ? '' : 's'} from last match costs chemistry.` : 'A settled side builds chemistry.'}`}</div>
    </section>
    <section class="stack">
      ${ui.swapIn ? `<div class="notice warn spread" id="swapNote"><span>Who makes way for <strong>${esc(P[ui.swapIn].name)}</strong>? Tap <strong>Swap out</strong> on a player below.</span><button class="btn btn-sm" data-act="cancelswap">Cancel</button></div>` : ''}
      <div class="section-head"><h3>Playing XI · batting order</h3><div class="row"><button class="btn btn-sm" data-act="arrange" title="Order by each player's batting bands">Sort order</button><button class="btn btn-sm" data-act="auto">Auto-pick for ${esc(C.label.toLowerCase())}</button></div></div>
      <div class="panel" id="xiList">${L.xi.map((id, i) => { const p = P[id]; const fit = positionFit(p, i); const hurt = !isAvailable(s, id); return `<div class="pick-row xi-row ${hurt ? 'out' : ''}" data-idx="${i}">
        <span class="drag-handle" data-drag="${i}" title="Drag to reorder" aria-hidden="true"><span class="mono muted">${i + 1}</span></span>
        <span style="min-width:0"><strong>${esc(p.name)}</strong> ${osTag(p)} <span class="tag" title="Bats well at ${bandsRange(p)}">${bandsLabel(p)}</span>${fit < 1 && p.bat >= 40 ? ` <span class="tag tag-bad">−${Math.round((1 - fit) * 100)}% bat</span>` : ''}${hurt ? ' <span class="tag tag-bad">Injured</span>' : ''}
          <span class="sub-line">${[ROLE_LABEL[p.role], styleLabel(p), typeLabel(p), rolesLabel(p)].filter(Boolean).join(' · ')} · ${skill(p)}</span><span class="sub-line">${statusBits(p)}</span></span>
        <span class="order-btns"><button data-up="${i}" aria-label="Move ${esc(p.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-down="${i}" aria-label="Move ${esc(p.name)} down" ${i === L.xi.length - 1 ? 'disabled' : ''}>↓</button></span>
        ${ui.swapIn ? `<button class="btn btn-sm btn-primary" data-swapout="${id}">Swap out</button>` : `<button class="btn btn-sm btn-ghost" data-drop="${id}">Bench</button>`}</div>`; }).join('')}</div>
    </section>
    <section class="stack">
      <div class="section-head"><h3>${IMPACT ? 'Bench and impact players' : 'Bench'}</h3></div>
      ${IMPACT ? '<p class="muted" style="font-size:.86rem">Name two impact players. <strong>Bat</strong> comes in for the chase if you bowl first; <strong>Bowl</strong> comes on for the second innings if you bat first.</p>' : `<p class="muted" style="font-size:.86rem">No impact players in the ${LG}.</p>`}
      <div class="panel">
        ${IMPACT ? '<div class="pick-row" style="grid-template-columns:auto auto 1fr auto;padding-top:0"><span class="eyebrow">Bat</span><span class="eyebrow">Bowl</span><span></span><span></span></div>' : ''}
        ${bench.map((p) => { const ok = isAvailable(s, p.id); const st = statusOf(s, p.id); return `<div class="pick-row ${ok ? '' : 'out'}" style="grid-template-columns:${IMPACT ? 'auto auto ' : ''}1fr auto">
        ${IMPACT ? `<input type="radio" name="impbat" data-impbat="${p.id}" ${L.impact.bat === p.id ? 'checked' : ''} ${ok ? '' : 'disabled'} aria-label="Batting impact player: ${esc(p.name)}">
        <input type="radio" name="impbowl" data-impbowl="${p.id}" ${L.impact.bowl === p.id ? 'checked' : ''} ${ok ? '' : 'disabled'} aria-label="Bowling impact player: ${esc(p.name)}">` : ''}
        <span style="min-width:0"><strong>${esc(p.name)}</strong> ${osTag(p)} <span class="tag">${bandsLabel(p)}</span> <span class="tag">${p.ovr}</span>${ok ? '' : ` <span class="tag tag-bad">${esc(st.injury || 'Injured')} · ${st.inj}</span>`}
          <span class="sub-line">${[ROLE_LABEL[p.role], styleLabel(p), typeLabel(p), rolesLabel(p)].filter(Boolean).join(' · ')} · ${skill(p)}</span><span class="sub-line">${statusBits(p)}</span></span>
        <button class="btn btn-sm ${ui.swapIn === p.id ? 'btn-primary' : ''}" data-add="${p.id}" ${!ok ? 'disabled' : ''}>${L.xi.length >= 11 ? 'Swap in' : 'Add'}</button></div>`; }).join('')}</div>
    </section>
    <div class="grid-2">
      <button class="btn bid-btn" data-act="back">Back</button>
      <button class="btn btn-primary bid-btn" data-act="play" ${problem ? 'disabled' : ''}>Play match</button>
    </div>`;
  }

  // ---------- scorecard ----------
  function matchView(fx) {
    const r = fx.result;
    const label = fx.stage === 'league' ? `Match ${fx.no}` : fx.stage;
    const injuries = (r.injuries || []).map((n) => `<div class="notice ${n.ruledOut ? 'bad' : 'warn'}"><span><strong>${esc(P[n.id].name)}</strong> (${n.team}): ${esc(n.injury.toLowerCase())}, ${n.ruledOut ? 'ruled out of the season' : `out for ${n.matches} match${n.matches === 1 ? '' : 'es'}`}</span></div>`).join('');
    if (r.noResult) return `<section class="stack"><span class="eyebrow">${esc(label)}</span><h2>${fx.home} v ${fx.away}: no result</h2><p class="muted">Rain washed the game out. One point each.</p></section>${backBtn()}`;
    const potm = P[r.potm];
    const swaps = Object.entries(r.impact || {}).filter(([, v]) => v).map(([t, v]) => `${t}: ${esc(P[v.in].name)} on for ${esc(P[v.out].name)}`);
    return `<section class="stack">
      <span class="eyebrow">${esc(label)} · ${fx.neutral ? 'Neutral venue' : esc(T[fx.home].home)} · ${esc((CONDITIONS[r.conditions] || CONDITIONS.balanced).label)}</span>
      <div class="match-card">
        ${r.innings.map((inn) => `<div class="side">${badge(T[inn.team])}<span class="score">${inn.runs}/${inn.wkts}</span><span class="muted num">${ovs(inn.balls)}</span></div>`).join('<span class="vs">VS</span>')}
      </div>
      <h2 style="text-align:center">${esc(T[r.winner].name)} ${esc(r.summary)}</h2>
      <p class="muted" style="text-align:center">${esc(T[r.toss.winner].name)} won the toss and chose to ${r.toss.decision}. Player of the match: <strong>${esc(potm.name)}</strong>.${r.superOver?.scores ? ` Super Over: ${r.superOver.scores.join(' v ')}.` : ''}</p>
      ${swaps.length ? `<p class="muted" style="text-align:center;font-size:.88rem">Impact players: ${swaps.join(' · ')}</p>` : ''}
      ${injuries ? `<div class="stack" style="gap:6px">${injuries}</div>` : ''}
    </section>
    ${r.innings.map((inn) => inningsCard(inn)).join('')}
    ${backBtn()}`;
  }

  function inningsCard(inn) {
    const how = (b) => {
      if (!b.out) return 'not out';
      const bw = b.out.bowler ? P[b.out.bowler].name.split(' ').slice(-1)[0] : '';
      const f = b.out.fielder ? P[b.out.fielder].name.split(' ').slice(-1)[0] : '';
      if (b.out.how === 'caught') return `c ${f} b ${bw}`;
      if (b.out.how === 'caught and bowled') return `c & b ${bw}`;
      if (b.out.how === 'stumped') return `st ${f} b ${bw}`;
      if (b.out.how === 'run out') return `run out (${f})`;
      if (b.out.how === 'lbw') return `lbw b ${bw}`;
      return `b ${bw}`;
    };
    const dnb = inn.batting.filter((b) => !b.batted).map((b) => P[b.id].name);
    return `<section class="panel stack" style="gap:10px">
      <div class="spread"><h3>${esc(T[inn.team].name)}</h3><span class="score" style="font-size:1.45rem">${inn.runs}/${inn.wkts} <span class="muted" style="font-size:.9rem">(${ovs(inn.balls)})</span></span></div>
      <div class="scroll-x"><table class="card-table"><thead><tr><th>Batter</th><th class="r">R</th><th class="r">B</th><th class="r">4s</th><th class="r">6s</th><th class="r">SR</th></tr></thead><tbody>
        ${inn.batting.filter((b) => b.batted).map((b) => `<tr><td><strong>${esc(P[b.id].name)}</strong><span class="how">${esc(how(b))}</span></td><td class="r"><strong>${b.r}</strong></td><td class="r">${b.b}</td><td class="r">${b.f4}</td><td class="r">${b.f6}</td><td class="r muted">${b.b ? ((b.r / b.b) * 100).toFixed(0) : '–'}</td></tr>`).join('')}
        <tr><td class="muted">Extras</td><td class="r">${inn.extras}</td><td colspan="4"></td></tr>
      </tbody></table></div>
      ${dnb.length ? `<p class="muted" style="font-size:.85rem">Did not bat: ${dnb.map(esc).join(', ')}</p>` : ''}
      <div class="scroll-x"><table><thead><tr><th>Bowler</th><th class="r">${FORMAT.unit === 'ball' ? 'B' : 'O'}</th><th class="r">R</th><th class="r">W</th><th class="r">${hundred ? 'Per 5' : 'Econ'}</th></tr></thead><tbody>
        ${inn.bowling.map((b) => `<tr><td>${esc(P[b.id].name)}</td><td class="r">${FORMAT.unit === 'ball' ? b.balls : oversText(b.balls)}</td><td class="r">${b.r}</td><td class="r"><strong>${b.w}</strong></td><td class="r muted">${econ(b.r, b.balls)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
  }

  const backBtn = () => `<button class="btn btn-primary btn-block bid-btn" data-act="home">${s.stage === 'done' ? 'See the season awards' : 'Continue'}</button>`;

  // ---------- season end ----------
  function nextIsMega() {
    const auctionKind = game.auction?.kind || scn.kind;
    const lastMega = auctionKind === 'mega' ? scn.year : (game.world?.lastMega ?? 2025 + Math.floor((scn.year - 2025) / 3) * 3);
    return scn.year + 1 - lastMega >= 3;
  }

  function endView() {
    const dynasty = game.setup.length === 'dynasty';
    const aw = s.awards;
    const champ = T[s.champion];
    const fin = s.playoffs[s.playoffs.length - 1];
    const myFinish = s.champion === me ? 'Champions' : fin && (fin.home === me || fin.away === me) ? 'Runners-up' : s.playoffs.some((f) => f.home === me || f.away === me) ? 'Playoffs' : `${ordinal(myRow())} in the league`;
    const award = (label, x, val, color = 'var(--accent)') => x ? `<div class="panel stack" style="gap:4px"><span class="eyebrow" style="color:${color}">${label}</span><strong>${esc(P[x.id].name)}</strong><span class="muted" style="font-size:.86rem">${teamOfPlayer(s, x.id)} · ${val(x)}</span></div>` : '';
    return `<section class="trophy stack" style="align-items:center">
      ${badge(champ)}<span class="eyebrow">${LG} ${scn.year} champions</span><h1>${esc(champ.name)}</h1>
      <p class="muted">${fin ? `${esc(fin.result.winner)} ${esc(fin.result.summary)} in the final against ${esc(fin.result.winner === fin.home ? fin.away : fin.home)}.` : ''}</p>
      <span class="tag ${s.champion === me ? 'tag-good' : 'tag-accent'}">${esc(T[me].name)}: ${myFinish}</span>
      ${fin ? `<button class="btn btn-sm" data-open="${fin.no}">Final scorecard</button>` : ''}
    </section>
    <section class="grid-2">
      ${award(ORANGE, aw.orange, (x) => `${x.r} runs, SR ${((x.r / Math.max(1, x.b)) * 100).toFixed(0)}`, 'var(--accent)')}
      ${award(PURPLE, aw.purple, (x) => `${x.w} wickets, ${hundred ? 'runs per 5' : 'econ'} ${econ(x.rc, Math.max(1, x.bb))}`, 'var(--purple)')}
      ${award('Most valuable player', aw.mvp, (x) => `${x.r} runs, ${x.w} wickets`)}
      ${award('Most sixes', aw.sixes, (x) => `${x.f6} sixes`)}
      ${award('Best strike rate', aw.strikeRate, (x) => `${((x.r / x.b) * 100).toFixed(1)} (min 100 balls)`)}
      ${award('Best economy', aw.economy, (x) => `${econ(x.rc, x.bb)} ${hundred ? 'runs per 5 balls (min 100 balls)' : '(min 20 overs)'}`)}
    </section>
    <section class="stack">
      <div class="section-head"><h3>Playoffs</h3></div>
      <div class="panel feed">${s.playoffs.map((f) => `<div class="feed-item" data-open="${f.no}" style="cursor:pointer"><span class="tag">${esc(f.stage)}</span><span>${resultLine(f)}</span><span class="tag">Card</span></div>`).join('')}</div>
    </section>
    ${dynasty && !game.career ? historyView(myFinish) : ''}
    <div class="grid-2">
      ${game.auction ? '<button class="btn bid-btn" data-act="auctionreview">Auction review</button>' : '<span></span>'}
      ${game.career ? '<button class="btn btn-primary bid-btn" data-act="careerdone">Back to your career</button>' : dynasty
        ? `<button class="btn btn-primary bid-btn" data-act="nextseason" data-finish="${esc(myFinish)}">IPL ${scn.year + 1} off-season · ${nextIsMega() ? 'mega' : 'mini'} auction</button>`
        : '<button class="btn btn-primary bid-btn" data-act="newgame">New game</button>'}
    </div>`;
  }

  function historyView(myFinish) {
    const past = (game.world?.history || []).concat([{ year: scn.year, champion: s.champion, finish: myFinish }]);
    const titles = past.filter((h) => h.champion === me).length;
    return `<section class="stack">
      <div class="section-head"><h3>Dynasty record</h3><span class="muted" style="font-size:.85rem">${past.length} season${past.length === 1 ? '' : 's'} · ${titles} title${titles === 1 ? '' : 's'}</span></div>
      <div class="panel feed">${past.slice().reverse().map((h) => `<div class="feed-item"><span class="mono muted">${h.year}</span><span>${esc(T[me].id)}: ${esc(h.finish)}</span><span class="muted">${h.champion ? `Champions ${esc(h.champion)}` : ''}</span></div>`).join('')}</div>
    </section>`;
  }

  // ---------- actions ----------
  function showMatch(fx) { ui.match = fx; ui.view = 'match'; draw(); }

  function playMine(lineup, cond = null) {
    const fx = nextUserFixture(s);
    simToUserGame(s, scn);
    playFixture(s, scn, fx, lineup, fx.home === me ? cond : null);
    ctx.save();
    showMatch(fx);
  }

  root.onclick = (e) => {
    const open = e.target.closest('[data-open]');
    if (open && !e.target.closest('button:not([data-open])')) {
      const fx = allFx().find((f) => String(f.no) === open.dataset.open);
      if (fx?.result) { showMatch(fx); return; }
    }
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const keep = () => { ui.keepScroll = window.scrollY; draw(); };
    if (b.dataset.tab) { ui.tab = b.dataset.tab; keep(); return; }
    if (b.dataset.replrole) { ui.repl.role = b.dataset.replrole; keep(); return; }
    if (b.dataset.sign) {
      const r = pendingReplacements(s, me)[0];
      signReplacement(s, scn, me, r.out, b.dataset.sign);
      if (s.userXI) s.userXI.xi = s.userXI.xi.filter((id) => id !== r.out);
      ctx.save(); draw(); return;
    }
    const L = ui.lineup;
    if (b.dataset.up != null) { const i = +b.dataset.up; [L.xi[i - 1], L.xi[i]] = [L.xi[i], L.xi[i - 1]]; keep(); return; }
    if (b.dataset.down != null) { const i = +b.dataset.down; [L.xi[i + 1], L.xi[i]] = [L.xi[i], L.xi[i + 1]]; keep(); return; }
    if (b.dataset.drop) { L.xi = L.xi.filter((id) => id !== b.dataset.drop); keep(); return; }
    if (b.dataset.swapout) {
      // The new man takes the batting position of the player he replaces.
      const i = L.xi.indexOf(b.dataset.swapout);
      L.xi[i] = ui.swapIn;
      for (const k of ['bat', 'bowl']) if (L.impact[k] === ui.swapIn) L.impact[k] = null;
      ui.swapIn = null;
      keep(); return;
    }
    if (b.dataset.act === 'cancelswap') { ui.swapIn = null; keep(); return; }
    if (b.dataset.add && L.xi.length >= 11) {
      // XI full: pick who makes way (scroll up to the XI).
      ui.swapIn = ui.swapIn === b.dataset.add ? null : b.dataset.add;
      ui.keepScroll = null; draw(); document.getElementById(ui.swapIn ? 'swapNote' : 'xiList')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (b.dataset.add) {
      L.xi.push(b.dataset.add);
      for (const k of ['bat', 'bowl']) if (L.impact[k] === b.dataset.add) L.impact[k] = null;
      keep(); return;
    }
    if (b.dataset.cond) { ui.cond = b.dataset.cond; keep(); return; }
    const act = b.dataset.act;
    if (act === 'select') startSelect();
    else if (act === 'skiprepl') { const r = pendingReplacements(s, me)[0]; signReplacement(s, scn, me, r.out, null); ctx.save(); draw(); }
    else if (act === 'quick') {
      const fx = nextUserFixture(s); simToUserGame(s, scn);
      const c = fixtureConditions(s, scn, fx);
      playMine(carriedLineup(s, scn, c).lineup, c);
    }
    else if (act === 'auto') {
      const sq = s.squads[me];
      ui.lineup = autoLineup(sq, P, ui.cond, { exclude: unavailable(s, sq), mods: matchMods(s, me, sq) });
      keep();
    }
    else if (act === 'arrange') { L.xi = arrangeOrder(L.xi, P); keep(); }
    else if (act === 'play') playMine({ xi: L.xi.slice(), impact: { ...L.impact } }, ui.cond);
    else if (act === 'back' || act === 'home') { ui.view = s.stage === 'done' ? 'end' : 'home'; draw(); }
    else if (act === 'simto') { simToUserGame(s, scn); if (!nextUserFixture(s)) { let g = 0; while (nextFixture(s) && g++ < 100) playFixture(s, scn, nextFixture(s)); } ctx.save(); ui.view = s.stage === 'done' ? 'end' : 'home'; draw(); }
    else if (act === 'simone') { const fx = nextFixture(s); playFixture(s, scn, fx); ctx.save(); showMatch(fx); }
    else if (act === 'onlymine') { ui.onlyMine = !ui.onlyMine; keep(); }
    else if (act === 'auctionreview') ctx.go('results');
    else if (act === 'newgame') ctx.go('setup');
    else if (act === 'nextseason') ctx.startOffseason(b.dataset.finish);
    else if (act === 'careerdone') ctx.careerSeasonDone();
  };
  // Drag a player up or down the batting order (mouse or touch); the arrow buttons still work too.
  let drag = null;
  root.onpointerdown = (e) => {
    const h = e.target.closest('[data-drag]');
    if (!h || ui.view !== 'select') return;
    e.preventDefault();
    const row = h.closest('.xi-row');
    drag = { from: +h.dataset.drag, to: +h.dataset.drag, row, startY: e.clientY };
    row.classList.add('dragging');
    h.setPointerCapture?.(e.pointerId);
  };
  root.onpointermove = (e) => {
    if (!drag) return;
    drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
    const rows = [...root.querySelectorAll('.xi-row')];
    let to = rows.length - 1;
    for (let k = 0; k < rows.length; k++) {
      if (rows[k] === drag.row) continue;
      const r = rows[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { to = k > drag.from ? k - 1 : k; break; }
    }
    drag.to = Math.max(0, Math.min(rows.length - 1, to));
    rows.forEach((r, k) => r.classList.toggle('drop-here', k === drag.to && k !== drag.from));
  };
  const endDrag = () => {
    if (!drag) return;
    const { from, to } = drag;
    drag = null;
    if (from !== to) { const [id] = ui.lineup.xi.splice(from, 1); ui.lineup.xi.splice(to, 0, id); }
    ui.keepScroll = window.scrollY;
    draw();
  };
  root.onpointerup = endDrag;
  root.onpointercancel = endDrag;

  root.onchange = (e) => {
    const L = ui.lineup;
    if (!L) return;
    if (e.target.dataset.impbat) { L.impact.bat = e.target.dataset.impbat; if (L.impact.bowl === L.impact.bat) L.impact.bowl = null; ui.keepScroll = window.scrollY; draw(); }
    if (e.target.dataset.impbowl) { L.impact.bowl = e.target.dataset.impbowl; if (L.impact.bat === L.impact.bowl) L.impact.bat = null; ui.keepScroll = window.scrollY; draw(); }
  };

  draw();
}

function fmtNrr(x) { return (x >= 0 ? '+' : '') + x.toFixed(3); }
