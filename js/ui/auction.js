// Live auction room. Drives the pure auction engine with a timer; all rules live in the engine.
import { esc, money, ROLE_LABEL } from '../format.js';
import { MODES, nextBid, openSlots, overseasSlots, maxAllowedBid, playerFee, OVERSEAS_FEE_CAP, increment } from '../engine/rules.js';
import { beginLot, aiAct, placeBid, hammer, simulateLot, userBidBlocker, startAccelerated, remainingPool, simulateRest, rtmCandidate, aiWantsRtm, useRtm, rtmRaise, rtmSkipRaise, aiRtmRaise, rtmDecide, rtmCanMatch, teamsInRunning, fastForward } from '../engine/auction.js';
import { marketValue } from '../engine/valuation.js';
import { typeLabel } from '../engine/bowling.js';
import { badge, teamChip, roleTag, osTag, bar, statBlock, squadTable } from './components.js';
import { masthead } from './shell.js';

const SPEEDS = {
  slow: { label: 'Slow', window: 7000, ai: [1300, 2600], stamp: 1900 },
  normal: { label: 'Normal', window: 4000, ai: [650, 1400], stamp: 1300 },
  fast: { label: 'Fast', window: 1700, ai: [150, 420], stamp: 650 },
};

let timer = null;
let onHide = null;
let onKey = null;

export function unmount() {
  clearInterval(timer); timer = null;
  if (onHide) document.removeEventListener('visibilitychange', onHide);
  if (onKey) document.removeEventListener('keydown', onKey);
  onHide = onKey = null;
}

export function render(root, ctx) {
  const { scn, game } = ctx;
  const a = game.auction;
  const me = game.setup.team;
  const ui = { paused: false, pausedAt: 0, tab: 'bids', stamp: null, quietUntil: 0, quietStart: 0, nextAiAt: Infinity, confirmFinish: false, nomPicks: new Set(), nomRole: 'ALL', nomQuery: '' };

  const sp = () => SPEEDS[game.speed] || SPEEDS.normal;
  const now = () => performance.now();
  const aiDelay = () => { const [lo, hi] = sp().ai; const f = lotPassedByUser() ? 0.35 : 1; return (lo + Math.random() * (hi - lo)) * f; };
  const windowMs = () => sp().window * (lotPassedByUser() ? 0.35 : 1);
  const lotPassedByUser = () => a.lot && (a.lot.userPassed || !!userCannotBidAtAll());
  const userCannotBidAtAll = () => {
    if (!a.lot) return null;
    const t = a.teams[me], p = scn.players[a.lot.playerId];
    if (openSlots(t) <= 0) return 'Your squad is full';
    if (p.overseas && overseasSlots(t, scn.players) <= 0) return 'Your overseas slots are full';
    if (maxAllowedBid(t) < nextBid(a.lot, p)) return 'Out of your price range';
    return null;
  };

  root.innerHTML = `${masthead('<span class="tag" id="phaseTag"></span>')}
    <div class="strip" id="strip"></div>
    <main class="stack" style="padding-top:16px">
      <div id="stage"></div>
      <div id="controls"></div>
      <div id="tabs"></div>
    </main>`;
  const $ = (id) => root.querySelector('#' + id);

  // ---------- drawing ----------
  function drawStrip() {
    const t = a.teams[me];
    $('strip').innerHTML = `<div class="strip-inner">
      <span class="chip">${badge(scn.teamById[me], 'badge-sm')}<strong>${me}</strong></span>
      <div class="stats">
        ${statBlock('Purse', money(t.purse), 'accent')}
        ${statBlock('Max bid', money(Math.max(0, maxAllowedBid(t))))}
        ${statBlock('Slots', openSlots(t))}
        ${statBlock('Overseas', overseasSlots(t, scn.players))}
        ${a.kind === 'mega' ? statBlock('RTM', t.rtm, 'accent') : ''}
      </div></div>`;
    const m = MODES[a.mode];
    $('phaseTag').textContent = a.phase === 'main' ? `${m.label} · Opening sets` : a.phase === 'nominate' ? `Accelerated round ${a.round} · nominations` : a.phase === 'accelerated' ? `Accelerated round ${a.round}` : 'Complete';
  }

  function lotPosition() {
    if (a.phase === 'main') {
      const total = a.mainTotal ?? scn.pool.filter((id) => scn.players[id].set <= MODES[a.mode].mainLastSet).length;
      return `Lot ${total - a.queue.length} of ${total}`;
    }
    return `${a.queue.length} left in this round`;
  }

  function drawLot() {
    // While the SOLD/UNSOLD stamp shows, keep drawing the lot that was just hammered.
    const lot = a.lot || (ui.stamp ? ui.lastLot : null);
    if (!lot) { $('stage').innerHTML = ''; return; }
    const p = scn.players[lot.playerId];
    const holder = lot.bidder ? scn.teamById[lot.bidder] : null;
    const blocker = userBidBlocker(a, scn);
    const amount = nextBid(lot, p);
    const youLead = lot.bidder === me;
    const live = a.lot && !ui.stamp ? teamsInRunning(a, scn).length : 0;
    const tl = scn.teamById;
    $('stage').innerHTML = `<article class="lot" aria-live="polite">
      <div class="lot-top">
        <div class="lot-meta"><span class="tag tag-accent mono">${esc(p.setCode)}</span><span class="tag">${lotPosition()}</span>${p.capped ? '<span class="tag">Capped</span>' : '<span class="tag">Uncapped</span>'}</div>
        <div class="lot-name">${esc(p.name)}</div>
        <div class="lot-sub">${esc(p.country)} · ${ROLE_LABEL[p.role]}${typeLabel(p) ? ' · ' + typeLabel(p) : ''}${p.age ? ` · ${p.age} yrs` : ''}${p.prevTeam && tl[p.prevTeam] ? ` · ${scn.league?.short || 'IPL'} ${scn.year - 1}: ${p.prevTeam}` : p.prospect ? ' · New prospect' : ''}</div>
        <div class="row">${roleTag(p)}${osTag(p)}${a.kind === 'mega' && p.prevTeam && a.teams[p.prevTeam]?.rtm > 0 ? `<span class="tag tag-data" title="${p.prevTeam} can use a right-to-match card">RTM ${p.prevTeam}</span>` : ''}<span class="tag">Reserve ${money(p.base)}</span><span class="tag">Scout value ${money(Math.round(marketValue(p) * (a.inflation ?? 1)))}</span></div>
        <div class="bars">${bar('Bat', p.bat, p.bat >= p.bowl)}${bar('Bowl', p.bowl, p.bowl > p.bat)}${bar('Overall', p.ovr, true)}</div>
      </div>
      <div class="clock"><i id="clockbar"></i></div>
      <div class="lot-bid">
        <div class="stack" style="gap:6px">
          <span class="eyebrow">${holder ? 'Current bid' : 'Opening at reserve'}</span>
          <span class="price">${money(holder ? lot.bid : p.base)}</span>
          <span class="holder">${holder ? `${badge(holder, 'badge-sm')} ${esc(holder.name)}${youLead ? ' <span class="tag tag-good">You</span>' : ''}` : '<span class="muted">No bids yet</span>'}</span>
        </div>
        <div class="stack" style="gap:6px;min-width:220px">
          <div class="bid-actions">
            <button class="btn btn-primary bid-btn" data-act="bid" ${blocker || lot.userPassed || ui.paused || ui.stamp ? 'disabled' : ''}>Bid ${money(amount)}</button>
            <button class="btn" data-act="pass" ${lot.userPassed || youLead || ui.paused ? 'disabled' : ''}>${lot.userPassed ? 'Out' : 'Pass'}</button>
          </div>
          <span class="why">${ui.stamp ? 'Hammer down.' : lot.userPassed ? 'You are out of this lot.' : youLead ? 'You hold the bid.' : blocker ? esc(blocker) : `${lot.history.length} bid${lot.history.length === 1 ? '' : 's'} so far${live ? ` · ${live} team${live === 1 ? '' : 's'} still in` : ''}`}</span>
        </div>
      </div>
      ${ui.stamp ? stampHtml(ui.stamp) : ''}
      ${ui.rtm ? rtmHtml(lot) : ''}
      ${ui.paused ? `<div class="stamp unsold paused"><div>Paused<small>Press Resume or P to carry on</small></div></div>` : ''}
    </article>`;
  }

  function stampHtml(s) {
    if (s.type === 'unsold') return `<div class="stamp unsold"><div>Unsold</div></div>`;
    const p = scn.players[s.id];
    const capNote = a.kind !== 'mega' && p.overseas && s.price > OVERSEAS_FEE_CAP ? `<small>Player gets ${money(playerFee(p, s.price, a.kind))}; ${money(s.price - OVERSEAS_FEE_CAP)} to BCCI welfare</small>` : '';
    const tm = scn.teamById[s.team];
    return `<div class="stamp" style="--c1:${tm.color};--c2:${tm.color2}"><div>${s.rtm ? 'Retained by RTM' : 'Sold'} · ${esc(tm.name)} · ${money(s.price)}${capNote}</div></div>`;
  }

  // Right-to-match decisions that need the user.
  function rtmHtml(lot) {
    const p = scn.players[lot.playerId];
    const T = scn.teamById;
    if (ui.rtm.stage === 'offer') {
      return `<div class="rtm-panel"><div>
        <span class="eyebrow">Right to match · ${a.teams[me].rtm} card${a.teams[me].rtm === 1 ? '' : 's'} left</span>
        <h3>${esc(T[lot.bidder].name)} bid ${money(lot.bid)} for ${esc(p.name)}</h3>
        <p class="muted" style="font-size:.9rem">He played for you last season. Match the price to keep him; ${lot.bidder} then gets one final raise, which you would have to match again.</p>
        <div class="grid-2"><button class="btn btn-primary" data-act="rtm-use">Match ${money(lot.bid)}</button><button class="btn" data-act="rtm-pass">Let him go</button></div>
      </div></div>`;
    }
    if (ui.rtm.stage === 'match') {
      const can = rtmCanMatch(a, scn);
      return `<div class="rtm-panel"><div>
        <span class="eyebrow">Final raise</span>
        <h3>${esc(T[lot.rtm.winner].name)} raised to ${money(lot.rtm.price)}</h3>
        <p class="muted" style="font-size:.9rem">${can ? `Match ${money(lot.rtm.price)} to keep ${esc(p.name)}, or let him go to ${lot.rtm.winner}.` : `You cannot afford ${money(lot.rtm.price)}, so he goes to ${lot.rtm.winner}.`}</p>
        <div class="grid-2"><button class="btn btn-primary" data-act="rtm-match" ${can ? '' : 'disabled'}>Match ${money(lot.rtm.price)}</button><button class="btn" data-act="rtm-decline">Let him go</button></div>
      </div></div>`;
    }
    // stage 'raise': the user won the bidding and an AI team used its card.
    const max = Math.max(0, maxAllowedBid(a.teams[me]));
    const step = increment(lot.rtm.price);
    const opts = [1.1, 1.2, 1.35, 1.5].map((f) => Math.max(lot.rtm.price + step, Math.round(lot.rtm.price * f / step) * step)).filter((v, i, arr) => v <= max && arr.indexOf(v) === i);
    return `<div class="rtm-panel"><div>
      <span class="eyebrow">${lot.rtm.team} used a right-to-match card</span>
      <h3>Make one final raise for ${esc(p.name)}?</h3>
      <p class="muted" style="font-size:.9rem">${lot.rtm.team} matched your ${money(lot.rtm.price)}. Raise once and they must match it again to keep him; or let them have him at ${money(lot.rtm.price)}.</p>
      <div class="row">${opts.map((v) => `<button class="btn btn-primary btn-sm" data-act="rtm-raise" data-amount="${v}">Raise to ${money(v)}</button>`).join('') || '<span class="muted">You cannot afford a raise.</span>'}</div>
      <button class="btn" data-act="rtm-noraise">No raise · ${lot.rtm.team} gets him</button>
    </div></div>`;
  }

  function drawControls() {
    if (a.phase === 'nominate' || a.phase === 'done') { $('controls').innerHTML = ''; return; }
    const setNo = a.lot ? scn.players[a.lot.playerId].set : null;
    $('controls').innerHTML = `<div class="spread">
      <div class="row">
      <button class="btn btn-sm ${ui.paused ? 'btn-primary' : ''}" data-act="pause" aria-pressed="${ui.paused}" title="Pause or resume (P)">${ui.paused ? 'Resume' : 'Pause'}</button>
      <div class="seg" role="group" aria-label="Speed">${Object.entries(SPEEDS).map(([k, s]) => `<button data-speed="${k}" aria-pressed="${game.speed === k}">${s.label}</button>`).join('')}</div>
      </div>
      <div class="row">
        <button class="btn btn-sm" data-act="ff" title="Run the bidding until only two teams are left" ${a.lot && !ui.stamp && teamsInRunning(a, scn).length > 2 ? '' : 'disabled'}>Skip to last two</button>
        <button class="btn btn-sm" data-act="simset" title="AI teams bid, you sit out">${a.phase === 'main' ? `Sim rest of set ${setNo ?? ''}` : 'Sim rest of round'}</button>
        <button class="btn btn-sm btn-ghost" data-act="finish">${ui.confirmFinish ? 'Tap again to sim the whole auction' : 'Sim to the end'}</button>
      </div></div>`;
  }

  function drawTabs() {
    const tabs = [['bids', 'Bids'], ['feed', 'Results'], ['teams', 'Teams'], ['squad', 'My squad'], ['next', 'Up next']];
    $('tabs').innerHTML = `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${ui.tab === k}">${l}</button>`).join('')}</div>
      <div class="panel tab-body">${tabBody()}</div>`;
  }

  function tabBody() {
    const T = scn.teamById;
    if (ui.tab === 'bids') {
      const h = a.lot ? a.lot.history.slice().reverse() : [];
      if (!h.length) return '<p class="muted">Bids on this lot will appear here.</p>';
      return `<div class="feed">${h.slice(0, 30).map((b) => `<div class="feed-item">${teamChip(T[b.team])}<span></span><span class="num">${money(b.amount)}</span></div>`).join('')}</div>`;
    }
    if (ui.tab === 'feed') {
      const items = a.log.slice().reverse().slice(0, 60);
      if (!items.length) return '<p class="muted">Sold and unsold players will appear here.</p>';
      return `<div class="feed">${items.map((e) => {
        if (e.type === 'phase') return `<div class="feed-item"><span class="tag tag-accent">Round</span><span>${esc(e.text)}</span><span></span></div>`;
        const p = scn.players[e.id];
        if (e.type === 'unsold') return `<div class="feed-item"><span class="tag">Unsold</span><span>${esc(p.name)} ${osTag(p)}</span><span class="muted num">${money(p.base)}</span></div>`;
        return `<div class="feed-item ${e.team === me ? 'gold' : ''}">${teamChip(T[e.team])}<span>${esc(p.name)} ${osTag(p)}${e.rtm ? ' <span class="tag tag-data">RTM</span>' : ''}${e.phase === 'fill' ? ' <span class="tag">Squad fill</span>' : ''}</span><span class="num"><strong>${money(e.price)}</strong></span></div>`;
      }).join('')}</div>`;
    }
    if (ui.tab === 'teams') {
      return `<div class="scroll-x"><table><thead><tr><th>Team</th><th class="r">Purse</th><th class="r">Max bid</th><th class="r">Squad</th><th class="r">Slots</th><th class="r">OS</th>${a.kind === 'mega' ? '<th class="r">RTM</th>' : ''}</tr></thead><tbody>
        ${Object.values(a.teams).sort((x, y) => y.purse - x.purse).map((t) => `<tr class="${t.id === me ? 'me' : ''}"><td>${teamChip(T[t.id])}</td><td class="r">${money(t.purse)}</td><td class="r">${money(Math.max(0, maxAllowedBid(t)))}</td><td class="r">${t.squad.length}</td><td class="r">${openSlots(t)}</td><td class="r">${overseasSlots(t, scn.players)}</td>${a.kind === 'mega' ? `<td class="r">${t.rtm}</td>` : ''}</tr>`).join('')}
        </tbody></table></div>`;
    }
    if (ui.tab === 'squad') {
      const t = a.teams[me];
      const prices = Object.fromEntries(t.squad.map((id) => [id, scn.players[id].price]));
      t.bought.forEach((b) => { prices[b.id] = b.price; });
      return squadTable(t.squad, scn, { prices, highlight: new Set(t.bought.map((b) => b.id)) });
    }
    const next = a.queue.slice(0, 10).map((id) => scn.players[id]);
    if (!next.length) return '<p class="muted">No more lots in this round.</p>';
    return `<div class="feed">${next.map((p) => `<div class="feed-item"><span class="mono muted">${esc(p.setCode)}</span><span>${esc(p.name)} ${osTag(p)} ${roleTag(p)}</span><span class="num">${money(p.base)}</span></div>`).join('')}</div>`;
  }

  function drawNominate() {
    const t = a.teams[me];
    const m = MODES[a.mode];
    const cap = Math.max(0, openSlots(t) * m.nominationsPerSlot);
    const pool = remainingPool(a, scn).map((id) => scn.players[id])
      .filter((p) => ui.nomRole === 'ALL' || (ui.nomRole === 'OS' ? p.overseas : p.role === ui.nomRole))
      .filter((p) => !ui.nomQuery || p.name.toLowerCase().includes(ui.nomQuery.toLowerCase()))
      .sort((x, y) => y.ovr - x.ovr).slice(0, 120);
    const roles = [['ALL', 'All'], ['BAT', 'Batters'], ['WK', 'Keepers'], ['AR', 'All-rounders'], ['BOWL', 'Bowlers'], ['OS', 'Overseas']];
    $('stage').innerHTML = `<section class="stack">
      <span class="eyebrow">Accelerated round ${a.round} of ${m.acceleratedRounds}</span>
      <h2>Nominate the players you want called</h2>
      <p class="muted">Every franchise submits names from the players still available${a.round > 1 ? ', including the unsold' : ''}. Only nominated players come up. You can nominate up to ${cap} (three per open slot). AI teams add their own picks.</p>
      ${cap === 0 ? '<div class="notice">Your squad is full, so you sit this round out.</div>' : ''}
      <div class="spread">
        <div class="seg" role="group" aria-label="Filter">${roles.map(([k, l]) => `<button data-nomrole="${k}" aria-pressed="${ui.nomRole === k}">${l}</button>`).join('')}</div>
        <label class="sr-only" for="nomq">Search players</label>
        <input id="nomq" type="search" placeholder="Search name" value="${esc(ui.nomQuery)}" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);min-width:0;flex:1 1 160px">
      </div>
      <div class="panel" style="max-height:52vh;overflow:auto">
        ${pool.map((p) => `<label class="pick-row" style="grid-template-columns:auto 1fr auto auto">
          <input type="checkbox" data-nom="${p.id}" ${ui.nomPicks.has(p.id) ? 'checked' : ''} ${!ui.nomPicks.has(p.id) && ui.nomPicks.size >= cap ? 'disabled' : ''}>
          <span style="min-width:0"><strong>${esc(p.name)}</strong> ${osTag(p)}<span class="muted" style="display:block;font-size:.8rem">${esc(p.country)} · ${ROLE_LABEL[p.role]} · bat ${p.bat} / bowl ${p.bowl}</span></span>
          <span class="tag">${p.ovr}</span><span class="num" style="min-width:58px;text-align:right">${money(p.base)}</span>
        </label>`).join('') || '<p class="muted">No players match.</p>'}
      </div>
      <div class="row">
        <button class="btn btn-primary bid-btn" data-act="startround" style="flex:1">Start round · ${ui.nomPicks.size} nominated</button>
      </div>
    </section>`;
  }

  function drawAll() {
    drawStrip();
    if (a.phase === 'done') { unmount(); ctx.go('results'); return; }
    if (a.phase === 'nominate') { drawNominate(); drawControls(); $('tabs').innerHTML = ''; return; }
    drawLot(); drawControls(); drawTabs();
  }

  // ---------- flow ----------
  function startLot() {
    const lot = beginLot(a, scn);
    ctx.save();
    if (!lot) { drawAll(); return; }
    const t = now();
    ui.quietStart = t;
    ui.quietUntil = t + windowMs() * 1.15;
    ui.nextAiAt = t + aiDelay();
    drawAll();
  }

  function afterBid() {
    const t = now();
    ui.quietStart = t;
    ui.quietUntil = t + windowMs();
    ui.nextAiAt = t + aiDelay();
  }

  function closeLot() {
    ui.lastLot = JSON.parse(JSON.stringify(a.lot));
    // Mega auction: the player's previous team may use a right-to-match card.
    const cand = rtmCandidate(a, scn);
    if (cand === me) { ui.rtm = { stage: 'offer' }; ui.nextAiAt = Infinity; drawLot(); return; }
    if (cand && aiWantsRtm(a, scn, cand, a.lot.bid)) {
      useRtm(a, scn, cand);
      if (a.lot.rtm.winner === me) { ui.rtm = { stage: 'raise' }; ui.nextAiAt = Infinity; drawLot(); return; }
      const raise = aiRtmRaise(a, scn);
      if (raise) rtmRaise(a, scn, raise); else rtmSkipRaise(a);
      return finishLot(rtmDecide(a, scn, aiWantsRtm(a, scn, cand, a.lot.rtm.price / 0.95)));
    }
    finishLot(hammer(a, scn));
  }

  function finishLot(res) {
    ui.rtm = null;
    ctx.save();
    ui.stamp = { ...res, until: now() + sp().stamp * (res.team === me ? 1.4 : 1) * (res.rtm ? 1.4 : 1) };
    ui.nextAiAt = Infinity;
    drawLot(); drawStrip(); drawTabs();
  }

  function rtmAction(act, amount) {
    ui.lastLot = JSON.parse(JSON.stringify(a.lot));
    if (act === 'rtm-pass') return finishLot(hammer(a, scn));
    if (act === 'rtm-use') {
      useRtm(a, scn, me);
      const raise = aiRtmRaise(a, scn);
      if (raise) { rtmRaise(a, scn, raise); ui.rtm = { stage: 'match' }; drawLot(); return; }
      rtmSkipRaise(a);
      return finishLot(rtmDecide(a, scn, true));
    }
    if (act === 'rtm-match') return finishLot(rtmDecide(a, scn, true));
    if (act === 'rtm-decline') return finishLot(rtmDecide(a, scn, false));
    if (act === 'rtm-noraise') { rtmSkipRaise(a); return finishLot(rtmDecide(a, scn, true)); }
    if (act === 'rtm-raise') {
      const t = a.lot.rtm.team;
      rtmRaise(a, scn, amount);
      return finishLot(rtmDecide(a, scn, aiWantsRtm(a, scn, t, a.lot.rtm.price / 0.95)));
    }
  }

  function setPaused(on) {
    if (on === ui.paused || a.phase === 'nominate' || a.phase === 'done') return;
    const t = now();
    if (on) { ui.paused = true; ui.pausedAt = t; }
    else {
      // Push every pending deadline back by the time spent paused.
      const shift = t - ui.pausedAt;
      ui.paused = false;
      ui.quietUntil += shift; ui.quietStart += shift;
      if (ui.nextAiAt !== Infinity) ui.nextAiAt += shift;
      if (ui.stamp) ui.stamp.until += shift;
    }
    drawLot(); drawControls();
  }

  function tick() {
    if (ui.paused || ui.rtm) return;
    const t = now();
    if (ui.stamp) {
      if (t >= ui.stamp.until) { ui.stamp = null; startLot(); }
      return;
    }
    if (a.phase === 'nominate' || a.phase === 'done') return;
    if (!a.lot) { startLot(); return; }
    if (t >= ui.nextAiAt) {
      const r = aiAct(a, scn);
      if (r) { afterBid(); drawLot(); drawControls(); if (ui.tab === 'bids') drawTabs(); drawStrip(); }
      else ui.nextAiAt = Infinity;   // AI ceilings are fixed for the lot, so nobody bids until you do
    }
    const bar = root.querySelector('#clockbar');
    if (bar) bar.style.transform = `scaleX(${Math.max(0, (ui.quietUntil - t) / Math.max(1, ui.quietUntil - ui.quietStart))})`;
    if (t >= ui.quietUntil && ui.nextAiAt === Infinity) closeLot();
  }

  function simSet() {
    const startSet = a.lot ? scn.players[a.lot.playerId].set : null;
    const phase = a.phase;
    ui.stamp = null;
    let guard = 0;
    while (a.phase === phase && guard++ < 500) {
      if (!a.lot && !beginLot(a, scn)) break;
      if (phase === 'main' && startSet != null && scn.players[a.lot.playerId].set !== startSet) break;
      simulateLot(a, scn);
    }
    ctx.save();
    ui.tab = 'feed';
    if (a.lot) afterBid();
    drawAll();
  }

  // ---------- events ----------
  root.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.speed) { game.speed = b.dataset.speed; ctx.save(); drawControls(); return; }
    if (b.dataset.tab) { ui.tab = b.dataset.tab; drawTabs(); return; }
    if (b.dataset.nomrole) { ui.nomRole = b.dataset.nomrole; drawNominate(); return; }
    const act = b.dataset.act;
    if (act?.startsWith('rtm-')) { rtmAction(act, Number(b.dataset.amount)); return; }
    if (ui.rtm && ['simset', 'finish', 'bid', 'pass', 'ff'].includes(act)) return;
    if (act === 'ff' && a.lot && !ui.stamp) {
      // Fast forward: the AI war runs instantly until two teams are left; the clock restarts for the finish.
      fastForward(a, scn, { leave: 2 });
      afterBid();
      drawLot(); drawStrip(); drawControls(); if (ui.tab === 'bids') drawTabs();
      return;
    }
    if (act !== 'finish') ui.confirmFinish = false;
    if (act === 'pause') { setPaused(!ui.paused); return; }
    if (ui.paused && ['bid', 'pass', 'simset', 'finish'].includes(act)) return;
    if (act === 'bid' && a.lot && !ui.stamp) {
      try { placeBid(a, scn, me); afterBid(); } catch (err) { /* button state already explains why */ }
      drawLot(); drawStrip(); if (ui.tab === 'bids') drawTabs();
    } else if (act === 'pass' && a.lot) {
      a.lot.userPassed = true;
      ui.quietUntil = Math.min(ui.quietUntil, now() + windowMs());
      if (ui.nextAiAt !== Infinity) ui.nextAiAt = now() + aiDelay();
      drawLot();
    } else if (act === 'simset') {
      simSet();
    } else if (act === 'finish') {
      if (!ui.confirmFinish) { ui.confirmFinish = true; drawControls(); return; }
      simulateRest(a, scn); ctx.save(); drawAll();
    } else if (act === 'startround') {
      startAccelerated(a, scn, [...ui.nomPicks]);
      ui.nomPicks.clear(); ctx.save(); ui.tab = 'next'; startLot();
    }
  };
  root.onchange = (e) => {
    const id = e.target.dataset.nom;
    if (!id) return;
    if (e.target.checked) ui.nomPicks.add(id); else ui.nomPicks.delete(id);
    const y = root.querySelector('.panel[style*="max-height"]')?.scrollTop;
    drawNominate();
    const panel = root.querySelector('.panel[style*="max-height"]');
    if (panel && y != null) panel.scrollTop = y;
  };
  root.oninput = (e) => {
    if (e.target.id !== 'nomq') return;
    ui.nomQuery = e.target.value;
    drawNominate();
    const q = root.querySelector('#nomq'); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
  };

  // Pause automatically when the tab is hidden, so a lot never closes while you are away.
  onHide = () => { if (document.hidden) setPaused(true); };
  document.addEventListener('visibilitychange', onHide);
  onKey = (e) => {
    if ((e.key === 'p' || e.key === 'P') && !e.target.closest('input, textarea')) setPaused(!ui.paused);
  };
  document.addEventListener('keydown', onKey);

  // A saved game may resume mid-lot: give the user a fresh clock on it.
  if (a.lot) afterBid();
  drawAll();
  clearInterval(timer);
  timer = setInterval(tick, 100);
}
