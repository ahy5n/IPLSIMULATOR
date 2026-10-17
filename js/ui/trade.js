// Trade window. Four places it opens from:
//   auction         after an auction (squads from the auction, money = purse left)
//   retain          dynasty mode, before retentions (squads from the world, money = room under the cap)
//   career          career mode, any league you coach, outside its season (players can refuse to move)
//   career-auction  career mode, straight after one of your auctions
import { esc, money } from '../format.js';
import { overseasSlots, SQUAD_MIN, SQUAD_MAX, OVERSEAS_MAX } from '../engine/rules.js';
import { tradeProblem, evaluateTrade, executeTrade, salaryOf, isTradeIcon, MAX_PER_SIDE, worldTradeState, applyWorldTrade } from '../engine/trades.js';
import { marketValue } from '../engine/valuation.js';
import { teamStrength } from '../engine/squad.js';
import { tradeState, commitTrade, willingness, willingnessLabel, suggestTrades } from '../engine/career.js';
import { activateLeague, LEAGUES } from '../engine/league.js';
import { badge, osTag, roleTag, statBlock, groupByPosition } from './components.js';
import { masthead, footer } from './shell.js';

export function unmount() {}

export function render(root, ctx) {
  const { game } = ctx;
  const where = game.tradeContext || 'auction';
  const pre = where === 'retain';
  const career = where === 'career';
  const lg = career ? game.tradeLeague : null;
  const me = career ? game.career.coaches.you.jobs[lg] : game.setup.team;
  if (career) activateLeague(lg);

  let scn, a, players;
  const load = () => {
    if (career) {
      const t = tradeState(game.career, lg, me);
      a = t.state; players = t.players;
      const teams = game.career.teams[lg];
      scn = { players, teams, teamById: Object.fromEntries(teams.map((x) => [x.id, x])), year: null, league: LEAGUES[lg] };
    } else if (pre) {
      const base = ctx.base();
      scn = { players: game.world.players, teams: base.teams, teamById: base.teamById, year: game.world.year };
      a = worldTradeState(game.world, me, base.teams, game.setup.difficulty, game.preTrades || []);
    } else {
      scn = ctx.scn; a = game.auction;
    }
  };
  load();
  const T = scn.teamById;
  const P = () => scn.players;
  const LG = career ? LEAGUES[lg].short : (scn.league?.short || 'IPL');
  // Cash is typed in the league's own currency: crore (₹, PKR) or thousands (rand, pounds).
  const cur = (career ? LEAGUES[lg] : scn.league || LEAGUES.ipl).currency;
  const cashUnit = cur.unit === 'crore' ? `${cur.sym} Cr` : `${cur.sym} thousand`;
  const toLakh = (v) => Math.round(cur.unit === 'crore' ? (v * 100) / cur.rate : v / cur.rate);
  const fromLakh = (l) => Math.round((cur.unit === 'crore' ? (l * cur.rate) / 100 : l * cur.rate) * 100) / 100;
  const ui = { partner: null, give: new Set(), get: new Set(), cash: 0, msg: null, ideas: null };
  const made = () => (career ? (game.careerTrades?.[lg] || []) : a.trades || []);

  const value = (id) => marketValue({ ...P()[id], base: 30 }) * (a.inflation ?? 1);
  const mood = (id, to) => {
    if (!career) return '';
    const w = willingnessLabel(willingness(game.career, lg, id, to));
    return ` <span class="tag ${w.tone ? `tag-${w.tone}` : ''}">${w.text}</span>`;
  };

  function squadList(teamId, picked, attr, max, moveTo) {
    const groups = groupByPosition(a.teams[teamId].squad.map((id) => P()[id]));
    return groups.map((g) => `<div class="eyebrow" style="margin:12px 0 4px;color:var(--data)">${g.label}</div>${g.players.map((p) => {
      const icon = isTradeIcon(a, p.id);
      const on = picked.has(p.id);
      return `<label class="pick-row" style="grid-template-columns:auto 1fr auto">
        <input type="checkbox" ${attr}="${p.id}" ${on ? 'checked' : ''} ${icon || (!on && picked.size >= max) ? 'disabled' : ''} aria-label="${esc(p.name)}">
        <span style="min-width:0"><strong>${esc(p.name)}</strong>${osTag(p)} ${roleTag(p)}${icon ? ' <span class="tag tag-data">Franchise icon</span>' : mood(p.id, moveTo)}
          <span class="sub-line">Rating ${p.ovr} · fee ${money(salaryOf(a, scn, p.id))} · value ${money(Math.round(value(p.id)))}</span></span>
        <span class="num muted" style="font-size:.85rem">${p.age ?? ''}</span>
      </label>`;
    }).join('')}`).join('');
  }

  function draw() {
    const myT = a.teams[me];
    const offer = { partner: ui.partner, give: [...ui.give], get: [...ui.get], cash: toLakh(ui.cash) };
    const problem = ui.partner ? tradeProblem(a, scn, offer) : 'Pick a team to trade with';
    const ev = ui.partner && !problem ? evaluateTrade(a, scn, offer) : null;
    const trades = made();
    const capWord = pre || career ? 'Room under cap' : 'Purse';
    const minRule = pre || career ? `squads can have at most ${SQUAD_MAX} players` : `both squads must stay between ${SQUAD_MIN} and ${SQUAD_MAX}`;
    root.innerHTML = `${masthead('<span class="tag">Trade window</span>')}
    <main class="stack-lg">
      <section class="stack">
        <div class="row">${badge(T[me])}<span class="eyebrow">${esc(T[me].name)} · ${career ? `${LG} off-season` : pre ? `before IPL ${scn.year} retentions` : `before ${LG} ${scn.year}`}</span></div>
        <h1>Trade window</h1>
        <p class="muted">${pre || career ? 'Trade before retentions; anyone you bring in can then be retained.' : 'Swap players with another franchise before the season.'} Players move at their current fee and the difference comes out of the ${pre || career ? 'salary cap' : 'purses'}; you can add cash either way. Up to ${MAX_PER_SIDE} players each way, ${minRule} with no more than ${OVERSEAS_MAX} overseas, and franchise icons cannot be traded.${career ? ' Players have a say: someone settled with his coach and club may refuse to move, and players who know a coach are keener to join him.' : ''} AI teams accept deals that improve their XI or give them fair value.</p>
        <div class="stats">
          ${statBlock(capWord, money(myT.purse), 'accent')}
          ${statBlock('Squad', `${myT.squad.length}/${SQUAD_MAX}`)}
          ${statBlock('Overseas slots', overseasSlots(myT, P()))}
          ${statBlock('Team rating', teamStrength(myT.squad, P()).overall.toFixed(1))}
        </div>
      </section>

      ${career ? `<section class="stack">
        <div class="section-head"><h3>Ideas from your analysts</h3><button class="btn btn-sm" data-act="ideas">${ui.ideas ? 'Look again' : 'Suggest trades'}</button></div>
        ${ui.ideas ? (ui.ideas.length ? `<div class="panel feed">${ui.ideas.map((x, i) => `<div class="feed-item" style="grid-template-columns:1fr auto">
          <span>${badge(T[x.offer.partner], 'badge-sm')} <strong>${esc(T[x.offer.partner].name)}</strong>: give ${x.offer.give.map((id) => esc(P()[id].name)).join(', ')}, get ${x.offer.get.map((id) => esc(P()[id].name)).join(', ')}${x.offer.cash ? ` + ${money(x.offer.cash)} from you` : ''}
            <span class="sub-line">Your rating ${x.ev.myStrengthGain >= 0 ? '+' : ''}${x.ev.myStrengthGain.toFixed(1)}</span></span>
          <button class="btn btn-sm" data-idea="${i}">Load</button></div>`).join('')}</div>` : '<p class="muted">No deal they would accept makes your side stronger right now.</p>') : '<p class="muted" style="font-size:.88rem">Ask for deals other teams would accept that make your XI stronger.</p>'}
      </section>` : ''}

      <section class="stack">
        <div class="section-head"><h3>Trade with</h3></div>
        <div class="team-grid">${scn.teams.filter((t) => t.id !== me).map((t) => `
          <button class="team-pick" data-partner="${t.id}" aria-pressed="${ui.partner === t.id}" style="--c1:${t.color};--c2:${t.color2}">
            <span><strong>${t.id}</strong><span class="nm" style="display:block">${money(a.teams[t.id].purse)} · ${a.teams[t.id].squad.length} players</span></span>
          </button>`).join('')}</div>
      </section>

      ${ui.partner ? `<section class="grid-2" style="align-items:start">
        <div class="panel"><h3>You give</h3>${squadList(me, ui.give, 'data-give', MAX_PER_SIDE, ui.partner)}</div>
        <div class="panel"><h3>${esc(T[ui.partner].name)} give</h3>${squadList(ui.partner, ui.get, 'data-get', MAX_PER_SIDE, me)}</div>
      </section>

      <section class="panel stack">
        <div class="spread">
          <label for="cash" class="eyebrow">Cash (${cashUnit}) · positive = you pay, negative = they pay</label>
          <input id="cash" type="number" step="${cur.unit === 'crore' ? 0.25 : 25}" value="${ui.cash}" style="width:120px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface)">
        </div>
        ${!ui.give.size && !ui.get.size ? '<p class="muted">Tick players on either side to build an offer.</p>' : problem ? `<div class="notice bad">${esc(problem)}</div>` : `
          <div class="stats">
            ${statBlock('Your rating', `${ev.myStrengthGain >= 0 ? '+' : ''}${ev.myStrengthGain.toFixed(1)}`, ev.myStrengthGain >= 0 ? 'good' : 'bad')}
            ${statBlock(`${ui.partner} rating`, `${ev.strengthGain >= 0 ? '+' : ''}${ev.strengthGain.toFixed(1)}`)}
            ${statBlock(`${capWord} after`, money(myT.purse + offer.give.reduce((n, id) => n + salaryOf(a, scn, id), 0) - offer.get.reduce((n, id) => n + salaryOf(a, scn, id), 0) - offer.cash))}
          </div>
          <div class="notice ${ev.accept ? 'good' : 'warn'}">${ev.accept ? `${esc(T[ui.partner].name)} would accept this.` : ev.cashNeeded && ev.cashNeeded <= 3000 ? `${esc(T[ui.partner].name)} would say no. They might take it with about ${money(ev.cashNeeded)} more cash from you.` : `${esc(T[ui.partner].name)} are not interested in this deal.`}</div>`}
        ${ui.msg ? `<div class="notice good">${ui.msg}</div>` : ''}
        <button class="btn btn-primary" data-act="propose" ${problem || !ev?.accept ? 'disabled' : ''}>Make the trade</button>
      </section>` : ''}

      ${trades.length ? `<section class="stack">
        <div class="section-head"><h3>Trades made</h3></div>
        <div class="panel feed">${trades.map((t) => `<div class="feed-item"><span class="chip">${badge(T[t.partner], 'badge-sm')}${t.partner}</span>
          <span>${t.give.length ? `Gave ${t.give.map((id) => esc(P()[id]?.name || id)).join(', ')}` : ''}${t.give.length && t.get.length ? ' · ' : ''}${t.get.length ? `got ${t.get.map((id) => esc(P()[id]?.name || id)).join(', ')}` : ''}</span>
          <span class="num muted">${t.cash ? `${t.cash > 0 ? 'paid' : 'received'} ${money(Math.abs(t.cash))}` : ''}</span></div>`).join('')}</div>
      </section>` : ''}

      <div class="grid-2">
        ${pre || career || where === 'career-auction'
    ? `<span></span><button class="btn btn-primary bid-btn" data-act="back">${pre || game.career?.pending?.kind === 'retain' ? 'Back to retentions' : where === 'career-auction' ? 'Back to the auction report' : 'Back to your career'}</button>`
    : `<button class="btn bid-btn" data-act="back">Back to the auction report</button>
        <button class="btn btn-primary bid-btn" data-act="season">${game.season ? 'Back to the season' : `Start the IPL ${scn.year} season`}</button>`}
      </div>
    </main>${footer()}`;
  }

  const keep = (fn) => { const y = window.scrollY; fn(); draw(); window.scrollTo(0, y); };
  root.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.partner) return keep(() => { ui.partner = b.dataset.partner; ui.get.clear(); ui.msg = null; });
    if (b.dataset.idea != null) {
      const x = ui.ideas[+b.dataset.idea];
      return keep(() => { ui.partner = x.offer.partner; ui.give = new Set(x.offer.give); ui.get = new Set(x.offer.get); ui.cash = fromLakh(x.offer.cash || 0); ui.msg = null; });
    }
    const act = b.dataset.act;
    if (act === 'ideas') return keep(() => { ui.ideas = suggestTrades(game.career, lg); });
    if (act === 'propose') {
      const offer = { partner: ui.partner, give: [...ui.give], get: [...ui.get], cash: toLakh(ui.cash) };
      try {
        executeTrade(a, scn, offer);
        if (career) {
          commitTrade(game.career, lg, a, offer, players);
          game.careerTrades = { ...(game.careerTrades || {}), [lg]: (game.careerTrades?.[lg] || []).concat({ partner: offer.partner, give: offer.give, get: offer.get, cash: offer.cash }) };
          if (game.retainPicks && game.league === lg) game.retainPicks = game.retainPicks.filter((id) => !offer.give.includes(id)).concat(offer.get);
          load();
        } else if (pre) {
          applyWorldTrade(game.world, a);
          game.preTrades = a.trades;
          // Players you bring in are ticked for retention; players you sent away drop off your list.
          game.retainPicks = (game.retainPicks || []).filter((id) => !offer.give.includes(id)).concat(offer.get);
          load();
        } else {
          game.prediction = null;   // the season forecast is out of date
        }
        ctx.save();
        keep(() => { ui.msg = `Done. ${offer.get.map((id) => esc(P()[id].name)).join(', ') || 'Cash'} joins ${esc(T[me].name)}.`; ui.give.clear(); ui.get.clear(); ui.cash = 0; ui.ideas = null; });
      } catch (err) { keep(() => { ui.msg = esc(err.message); }); }
    } else if (act === 'back') {
      game.tradeContext = null;
      if (career) ctx.go(game.career.pending?.kind === 'retain' ? 'retain' : 'hub');
      else ctx.go(pre ? 'retain' : 'results');
    } else if (act === 'season') { if (!game.season) ctx.startSeason(); ctx.save(); ctx.go('season'); }
  };
  root.onchange = (e) => {
    const t = e.target;
    if (t.dataset.give) keep(() => { if (t.checked) ui.give.add(t.dataset.give); else ui.give.delete(t.dataset.give); ui.msg = null; });
    if (t.dataset.get) keep(() => { if (t.checked) ui.get.add(t.dataset.get); else ui.get.delete(t.dataset.get); ui.msg = null; });
    if (t.id === 'cash') keep(() => { ui.cash = Number(t.value) || 0; ui.msg = null; });
  };
  draw();
}
