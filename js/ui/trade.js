// Trade window between the auction and the season.
import { esc, money } from '../format.js';
import { openSlots, overseasSlots } from '../engine/rules.js';
import { tradeProblem, evaluateTrade, executeTrade, salaryOf, isTradeIcon, MAX_PER_SIDE, worldTradeState, applyWorldTrade } from '../engine/trades.js';
import { marketValue } from '../engine/valuation.js';
import { teamStrength } from '../engine/squad.js';
import { badge, osTag, roleTag, statBlock, groupByPosition } from './components.js';
import { masthead, footer } from './shell.js';

export function unmount() {}

export function render(root, ctx) {
  const { game } = ctx;
  const me = game.setup.team;
  // Two windows: after the auction (squads from the auction) and, in dynasty, before retentions
  // (squads from the world, money = room under next year's cap).
  const pre = game.tradeContext === 'retain';
  const base = ctx.base();
  const scn = pre ? { players: game.world.players, teams: base.teams, teamById: base.teamById, year: game.world.year } : ctx.scn;
  const freshState = () => worldTradeState(game.world, me, base.teams, game.setup.difficulty, game.preTrades || []);
  let a = pre ? freshState() : game.auction;
  const T = scn.teamById;
  const P = scn.players;
  const ui = { partner: null, give: new Set(), get: new Set(), cash: 0, msg: null };

  const value = (id) => marketValue({ ...P[id], base: 30 }) * (a.inflation ?? 1);

  function squadList(teamId, picked, attr, max) {
    const groups = groupByPosition(a.teams[teamId].squad.map((id) => P[id]));
    return groups.map((g) => `<div class="eyebrow" style="margin:12px 0 4px;color:var(--data)">${g.label}</div>${g.players.map((p) => {
      const icon = isTradeIcon(a, p.id);
      const on = picked.has(p.id);
      return `<label class="pick-row" style="grid-template-columns:auto 1fr auto">
        <input type="checkbox" ${attr}="${p.id}" ${on ? 'checked' : ''} ${icon || (!on && picked.size >= max) ? 'disabled' : ''} aria-label="${esc(p.name)}">
        <span style="min-width:0"><strong>${esc(p.name)}</strong>${osTag(p)} ${roleTag(p)}${icon ? ' <span class="tag tag-data">Franchise icon</span>' : ''}
          <span class="sub-line">Rating ${p.ovr} · fee ${money(salaryOf(a, scn, p.id))} · value ${money(Math.round(value(p.id)))}</span></span>
        <span class="num muted" style="font-size:.85rem">${p.age ?? ''}</span>
      </label>`;
    }).join('')}`).join('');
  }

  function draw() {
    const myT = a.teams[me];
    const offer = { partner: ui.partner, give: [...ui.give], get: [...ui.get], cash: Math.round(ui.cash * 100) };
    const problem = ui.partner ? tradeProblem(a, scn, offer) : 'Pick a team to trade with';
    const ev = ui.partner && !problem ? evaluateTrade(a, scn, offer) : null;
    const trades = a.trades || [];
    root.innerHTML = `${masthead('<span class="tag">Trade window</span>')}
    <main class="stack-lg">
      <section class="stack">
        <span class="eyebrow">${esc(T[me].name)} · ${pre ? `before IPL ${scn.year} retentions` : `before IPL ${scn.year}`}</span>
        <h1>Trade window</h1>
        <p class="muted">${pre ? 'Trade before you choose retentions; anyone you bring in can then be retained.' : 'Swap players with another franchise before the season.'} Players move at their current fee and the difference comes out of the purses; you can add cash either way. Up to ${MAX_PER_SIDE} players each way, ${pre ? 'squads can have at most 25 players' : 'both squads must stay between 18 and 25'} with no more than 8 overseas, and franchise icons cannot be traded. AI teams accept deals that improve their XI or give them fair value.</p>
        <div class="stats">
          ${statBlock(pre ? 'Room under cap' : 'Purse', money(myT.purse), 'accent')}
          ${statBlock('Squad', `${myT.squad.length}/25`)}
          ${statBlock('Overseas slots', overseasSlots(myT, scn.players))}
          ${statBlock('Team rating', teamStrength(myT.squad, P).overall.toFixed(1))}
        </div>
      </section>

      <section class="stack">
        <div class="section-head"><h3>Trade with</h3></div>
        <div class="team-grid">${scn.teams.filter((t) => t.id !== me).map((t) => `
          <button class="team-pick" data-partner="${t.id}" aria-pressed="${ui.partner === t.id}" style="--c1:${t.color};--c2:${t.color2}">
            <span><strong>${t.id}</strong><span class="nm" style="display:block">${money(a.teams[t.id].purse)} · ${a.teams[t.id].squad.length} players</span></span>
          </button>`).join('')}</div>
      </section>

      ${ui.partner ? `<section class="grid-2" style="align-items:start">
        <div class="panel"><h3>You give</h3>${squadList(me, ui.give, 'data-give', MAX_PER_SIDE)}</div>
        <div class="panel"><h3>${esc(T[ui.partner].name)} give</h3>${squadList(ui.partner, ui.get, 'data-get', MAX_PER_SIDE)}</div>
      </section>

      <section class="panel stack">
        <div class="spread">
          <label for="cash" class="eyebrow">Cash (₹ Cr) · positive = you pay, negative = they pay</label>
          <input id="cash" type="number" step="0.25" value="${ui.cash}" style="width:120px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)">
        </div>
        ${!ui.give.size && !ui.get.size ? '<p class="muted">Tick players on either side to build an offer.</p>' : problem ? `<div class="notice bad">${esc(problem)}</div>` : `
          <div class="stats">
            ${statBlock('Your rating', `${ev.myStrengthGain >= 0 ? '+' : ''}${ev.myStrengthGain.toFixed(1)}`, ev.myStrengthGain >= 0 ? 'good' : 'bad')}
            ${statBlock(`${ui.partner} rating`, `${ev.strengthGain >= 0 ? '+' : ''}${ev.strengthGain.toFixed(1)}`)}
            ${statBlock('Your purse after', money(myT.purse + offer.give.reduce((n, id) => n + salaryOf(a, scn, id), 0) - offer.get.reduce((n, id) => n + salaryOf(a, scn, id), 0) - offer.cash))}
          </div>
          <div class="notice ${ev.accept ? 'good' : 'warn'}">${ev.accept ? `${esc(T[ui.partner].name)} would accept this.` : ev.cashNeeded && ev.cashNeeded <= 3000 ? `${esc(T[ui.partner].name)} would say no. They might take it with about ${money(ev.cashNeeded)} more cash from you.` : `${esc(T[ui.partner].name)} are not interested in this deal.`}</div>`}
        ${ui.msg ? `<div class="notice good">${ui.msg}</div>` : ''}
        <button class="btn btn-primary" data-act="propose" ${problem || !ev?.accept ? 'disabled' : ''}>Make the trade</button>
      </section>` : ''}

      ${trades.length ? `<section class="stack">
        <div class="section-head"><h3>Trades made</h3></div>
        <div class="panel feed">${trades.map((t) => `<div class="feed-item"><span class="chip">${badge(T[t.partner], 'badge-sm')}${t.partner}</span>
          <span>${t.give.length ? `Gave ${t.give.map((id) => esc(P[id].name)).join(', ')}` : ''}${t.give.length && t.get.length ? ' · ' : ''}${t.get.length ? `got ${t.get.map((id) => esc(P[id].name)).join(', ')}` : ''}</span>
          <span class="num muted">${t.cash ? `${t.cash > 0 ? 'paid' : 'received'} ${money(Math.abs(t.cash))}` : ''}</span></div>`).join('')}</div>
      </section>` : ''}

      <div class="grid-2">
        ${pre ? '<span></span><button class="btn btn-primary bid-btn" data-act="back">Back to retentions</button>' : `<button class="btn bid-btn" data-act="back">Back to the auction report</button>
        <button class="btn btn-primary bid-btn" data-act="season">${game.season ? 'Back to the season' : `Start the IPL ${scn.year} season`}</button>`}
      </div>
    </main>${footer()}`;
  }

  const keep = (fn) => { const y = window.scrollY; fn(); draw(); window.scrollTo(0, y); };
  root.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.partner) return keep(() => { ui.partner = b.dataset.partner; ui.get.clear(); ui.msg = null; });
    const act = b.dataset.act;
    if (act === 'propose') {
      const offer = { partner: ui.partner, give: [...ui.give], get: [...ui.get], cash: Math.round(ui.cash * 100) };
      try {
        executeTrade(a, scn, offer);
        if (pre) {
          applyWorldTrade(game.world, a);
          game.preTrades = a.trades;
          // Players you bring in are ticked for retention; players you sent away drop off your list.
          game.retainPicks = (game.retainPicks || []).filter((id) => !offer.give.includes(id)).concat(offer.get);
          a = freshState();
        } else {
          game.prediction = null;   // the season forecast is out of date
        }
        ctx.save();
        keep(() => { ui.msg = `Done. ${offer.get.map((id) => esc(P[id].name)).join(', ') || 'Cash'} joins ${esc(T[me].name)}.`; ui.give.clear(); ui.get.clear(); ui.cash = 0; });
      } catch (err) { keep(() => { ui.msg = esc(err.message); }); }
    } else if (act === 'back') { game.tradeContext = null; ctx.go(pre ? 'retain' : 'results'); }
    else if (act === 'season') { if (!game.season) ctx.startSeason(); ctx.save(); ctx.go('season'); }
  };
  root.onchange = (e) => {
    const t = e.target;
    if (t.dataset.give) keep(() => { if (t.checked) ui.give.add(t.dataset.give); else ui.give.delete(t.dataset.give); ui.msg = null; });
    if (t.dataset.get) keep(() => { if (t.checked) ui.get.add(t.dataset.get); else ui.get.delete(t.dataset.get); ui.msg = null; });
    if (t.id === 'cash') keep(() => { ui.cash = Number(t.value) || 0; ui.msg = null; });
  };
  draw();
}
