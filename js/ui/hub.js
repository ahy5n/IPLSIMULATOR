// Career hub: your jobs and standing with each board, what's next on the calendar, your inbox (job
// offers and trade proposals), the four leagues, and the news.
import { esc, moneyIn, ordinal } from '../format.js';
import { LEAGUES, LEAGUE_IDS, activateLeague } from '../engine/league.js';
import {
  USER, nextEvent, upcoming, isUserEvent, eventTitle, fmtDate, runEvent, answer, coachOf, teamSquad,
  jobMarket, takeJob, quitJob, teamPrestige, requiredRep, tradeWindowOpen, leaguePlayers,
} from '../engine/career.js';
import { teamStrength } from '../engine/squad.js';
import { badge, meter, teamChip } from './components.js';
import { masthead, footer } from './shell.js';

export function unmount() {}

const KIND_WORD = { trade: 'Trade window', retain: 'Retentions', auction: 'Auction', season: 'Season', develop: 'Development' };

export function render(root, ctx) {
  const g = ctx.game;
  const c = g.career;
  const ui = { tab: g.hubTab || c.coaches[USER].jobs[g.league] ? g.league : 'ipl', busy: null, msg: null, team: null };
  if (!ui.tab || !LEAGUES[ui.tab]) ui.tab = 'ipl';

  const teamOf = (lg, id) => c.teams[lg].find((t) => t.id === id);
  const money = (lg, x) => moneyIn(LEAGUES[lg].currency, x);

  function jobsView() {
    const you = c.coaches[USER];
    const jobs = Object.entries(you.jobs);
    return `<section class="stack">
      <div class="spread"><div class="stack" style="gap:4px">
        <span class="eyebrow">${fmtDate(c.date)} · Head coach</span>
        <h1>${jobs.length ? jobs.map(([lg, id]) => esc(teamOf(lg, id).name)).join(' · ') : 'Out of work'}</h1></div>
        <div class="stat" style="align-items:flex-end"><span class="k">Reputation</span><span class="v">${Math.round(you.rep)}</span>${meter(you.rep, 'var(--data)', { label: 'Reputation' })}</div>
      </div>
      ${jobs.length ? `<div class="panel feed">${jobs.map(([lg, id]) => {
        const t = teamOf(lg, id), sec = you.security[lg] ?? 60;
        const tone = sec >= 60 ? 'var(--good)' : sec >= 35 ? 'var(--warn)' : 'var(--bad)';
        const word = sec >= 70 ? 'Secure' : sec >= 50 ? 'Settled' : sec >= 35 ? 'Under pressure' : 'On thin ice';
        return `<div class="feed-item" style="grid-template-columns:auto 1fr auto">
          ${badge(t)}<span><strong>${esc(t.name)}</strong> <span class="tag">${LEAGUES[lg].short}</span>
            <span class="sub-line">Board: <span style="color:${tone}">${word}</span> ${meter(sec, tone, { label: 'Board confidence' })}</span></span>
          <span class="row" style="gap:6px">${tradeWindowOpen(c, lg) ? `<button class="btn btn-sm" data-trade="${lg}">Trades</button>` : ''}<button class="btn btn-sm btn-ghost" data-quit="${lg}">Leave</button></span>
        </div>`;
      }).join('')}</div>` : `<div class="notice warn">You have no job. Keep the calendar moving: boards with vacancies will call${c.mode === 'free' ? ', or take any job from the market below' : ''}.</div>`}
    </section>`;
  }

  function nextView() {
    const pd = c.pending;
    if (pd) {
      const ev = c.events.find((e) => e.id === pd.ev);
      return `<section class="panel stack">
        <span class="eyebrow">In progress · ${fmtDate(ev.date)}</span>
        <h2>${esc(eventTitle(ev))}</h2>
        <button class="btn btn-primary bid-btn" data-act="resume">Back to the ${KIND_WORD[ev.kind].toLowerCase()}</button>
      </section>`;
    }
    const ev = nextEvent(c);
    if (!ev) return '';
    const mine = isUserEvent(c, ev);
    const team = mine ? teamOf(ev.lg, c.coaches[USER].jobs[ev.lg]) : null;
    return `<section class="panel stack">
      <span class="eyebrow">Next · ${fmtDate(ev.date)}</span>
      <h2>${esc(eventTitle(ev))}</h2>
      <p class="muted">${mine ? `You're in charge of ${esc(team.name)}.` : 'The calendar runs every league in date order. Events in leagues you don\'t coach are simulated; it stops when something needs you.'}</p>
      ${ui.busy ? `<div class="notice">${esc(ui.busy)}</div>` : ''}
      ${ui.msg ? `<div class="notice bad">${esc(ui.msg)}</div>` : ''}
      <button class="btn btn-primary bid-btn" data-act="${mine ? 'open' : 'advance'}" ${ui.busy ? 'disabled' : ''}>${mine ? `Go to the ${KIND_WORD[ev.kind].toLowerCase()}` : 'Continue'}</button>
    </section>`;
  }

  function inboxView() {
    const open = c.inbox.filter((m) => !m.answered);
    if (!open.length) return '';
    return `<section class="stack">
      <div class="section-head"><h3>Inbox</h3><span class="muted" style="font-size:.85rem">${open.length} waiting</span></div>
      <div class="panel feed">${open.map((m) => `<div class="feed-item" style="grid-template-columns:1fr auto">
        <span>${m.kind === 'offer' ? '<span class="tag tag-accent">Job offer</span>' : m.kind === 'trade' ? '<span class="tag tag-data">Trade offer</span>' : '<span class="tag tag-bad">Board</span>'} ${esc(m.text)}
          <span class="sub-line">${m.kind === 'offer' ? `Club standing ${teamPrestige(c, m.lg, m.team)} · ${c.coaches[USER].jobs[m.lg] ? `you'd leave ${esc(teamOf(m.lg, c.coaches[USER].jobs[m.lg]).name)}` : `a new ${LEAGUES[m.lg].short} job alongside your others`}` : ''}${m.expires ? ` · answer by ${fmtDate(m.expires)}` : ''}</span></span>
        <span class="row" style="gap:6px">${m.kind === 'fired' ? `<button class="btn btn-sm" data-ok="${m.id}">OK</button>` : `<button class="btn btn-sm btn-primary" data-accept="${m.id}">Accept</button><button class="btn btn-sm" data-decline="${m.id}">Decline</button>`}</span>
      </div>`).join('')}</div>
    </section>`;
  }

  function calendarView() {
    const evs = upcoming(c, 10);
    return `<section class="stack">
      <div class="section-head"><h3>Calendar</h3><span class="muted" style="font-size:.85rem">Next ${evs.length} events</span></div>
      <div class="panel feed">${evs.map((ev) => {
        const mine = isUserEvent(c, ev);
        return `<div class="feed-item cal-item" style="grid-template-columns:7.5em 4.5em 1fr auto">
          <span class="num muted">${fmtDate(ev.date)}</span><span class="tag">${ev.lg ? LEAGUES[ev.lg].short : 'All'}</span>
          <span>${esc(KIND_WORD[ev.kind])}${ev.lg ? ` · ${ev.year}` : ''}</span>${mine ? '<span class="tag tag-accent">You</span>' : '<span></span>'}</div>`;
      }).join('')}</div>
    </section>`;
  }

  function marketView() {
    if (c.mode !== 'free') return '';
    const rows = jobMarket(c);
    return `<section class="stack">
      <div class="section-head"><h3>Job market</h3><span class="muted" style="font-size:.85rem">Free choice: take any job, one per league</span></div>
      <div class="panel scroll-x"><table><thead><tr><th>Team</th><th>League</th><th>Coach</th><th class="r">Standing</th><th></th></tr></thead>
      <tbody>${rows.sort((a, b) => b.prestige - a.prestige).map((r) => `<tr><td>${teamChip(teamOf(r.lg, r.team))}</td><td>${LEAGUES[r.lg].short}</td><td class="muted">${esc(r.coach)}</td><td class="r">${r.prestige}</td>
        <td class="r"><button class="btn btn-sm" data-take="${r.lg}:${r.team}">Take job</button></td></tr>`).join('')}</tbody></table></div>
    </section>`;
  }

  function leagueView() {
    const lg = ui.tab;
    activateLeague(lg);
    const P = leaguePlayers(c, lg);
    const hist = c.leagues[lg].history;
    const last = hist[hist.length - 1];
    const rows = c.teams[lg].map((t) => {
      const sq = teamSquad(c, lg, t.id);
      const coach = coachOf(c, lg, t.id);
      return { t, sq, coach, str: sq.length >= 11 ? teamStrength(sq, P).overall : 0, pos: last?.table ? last.table.indexOf(t.id) + 1 : last?.champion === t.id ? 1 : last?.runnerUp === t.id ? 2 : null };
    }).sort((a, b) => b.str - a.str);
    const sel = ui.team && rows.find((r) => r.t.id === ui.team);
    return `<section class="stack">
      <div class="section-head"><h3>Leagues</h3></div>
      <div class="tabs" role="tablist">${LEAGUE_IDS.map((id) => `<button role="tab" data-tab="${id}" aria-selected="${ui.tab === id}">${LEAGUES[id].short}</button>`).join('')}</div>
      <p class="muted" style="font-size:.88rem">${esc(LEAGUES[lg].name)} · ${hist.slice(-5).reverse().map((h) => `${h.year} ${esc(teamOf(lg, h.champion)?.id || '—')}`).join(' · ')}</p>
      <div class="panel scroll-x"><table><thead><tr><th>Team</th><th>Head coach</th><th class="r">Squad</th><th class="r">Rating</th><th class="r hide-sm">Last</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${c.coaches[USER].jobs[lg] === r.t.id ? 'me' : ''}" data-team="${r.t.id}" style="cursor:pointer">
        <td>${teamChip(r.t)}</td><td>${r.coach ? `${esc(r.coach.user ? 'You' : r.coach.name)} <span class="muted num">${Math.round(r.coach.rep)}</span>` : '<span class="tag tag-warn">Vacant</span>'}</td>
        <td class="r">${r.sq.length}</td><td class="r">${r.str ? r.str.toFixed(1) : '—'}</td><td class="r hide-sm">${r.pos ? ordinal(r.pos) : '—'}</td></tr>`).join('')}</tbody></table></div>
      ${sel ? squadView(lg, sel, P) : '<p class="muted" style="font-size:.85rem">Tap a team to see its squad.</p>'}
    </section>`;
  }

  function squadView(lg, r, P) {
    const ids = r.sq.slice().sort((a, b) => P[b].ovr - P[a].ovr);
    const loyalWord = (p) => (p.loyal >= 0.75 ? 'Loyal' : p.loyal <= 0.3 ? 'Restless' : '');
    return `<div class="panel stack" style="gap:8px">
      <div class="spread"><strong>${esc(r.t.name)}</strong><span class="muted" style="font-size:.85rem">${r.coach ? `Coach ${esc(r.coach.user ? 'you' : r.coach.name)} · board ${Math.round(r.coach.security[lg] ?? 60)}` : 'No coach'} · needs reputation ${Math.round(requiredRep(c, lg, r.t.id))}</span></div>
      <div class="scroll-x"><table><thead><tr><th>Player</th><th class="r">Age</th><th class="r">Rating</th><th class="r">Fee</th><th class="r hide-sm">Seasons</th><th class="hide-sm"></th></tr></thead>
      <tbody>${ids.map((id) => { const p = P[id], cp = c.players[id]; const ten = cp.tenure[lg]?.team === r.t.id ? cp.tenure[lg].seasons : 0; const bond = r.coach ? cp.bonds[r.coach.id] || 0 : 0; return `<tr>
        <td><strong>${esc(p.name)}</strong>${p.overseas ? ' <span class="os">OS</span>' : ''} <span class="tag">${p.role}</span></td><td class="r">${p.age}</td><td class="r">${p.ovr}</td><td class="r">${money(lg, p.price)}</td>
        <td class="r hide-sm">${ten}</td><td class="hide-sm"><span class="tag">${[loyalWord(cp), bond >= 3 ? 'Close to coach' : ''].filter(Boolean).join(' · ')}</span></td></tr>`; }).join('')}</tbody></table></div>
    </div>`;
  }

  function newsView() {
    return `<section class="stack">
      <div class="section-head"><h3>News</h3></div>
      <div class="panel feed">${c.news.slice(0, 16).map((n) => `<div class="feed-item news-item" style="grid-template-columns:7.5em 4.5em 1fr"><span class="num muted">${fmtDate(n.date)}</span><span class="tag">${n.lg ? LEAGUES[n.lg].short : ''}</span><span>${esc(n.text)}</span></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>
    </section>`;
  }

  function draw() {
    root.innerHTML = `${masthead(`<span class="tag">Career · ${fmtDate(c.date)}</span>`)}
    <main class="stack-lg">
      ${jobsView()}
      ${nextView()}
      ${inboxView()}
      ${calendarView()}
      ${marketView()}
      ${leagueView()}
      ${newsView()}
    </main>${footer()}`;
  }

  const keep = (fn) => { const y = window.scrollY; fn(); draw(); window.scrollTo(0, y); };

  // Simulate event by event, repainting between them so the page stays responsive.
  async function advanceCalendar() {
    let guard = 0;
    const inboxBefore = c.inbox.filter((m) => !m.answered).length;
    while (guard++ < 60) {
      const ev = nextEvent(c);
      if (!ev || isUserEvent(c, ev)) break;
      ui.busy = `Simulating: ${eventTitle(ev)} (${fmtDate(ev.date)})`;
      draw();
      await new Promise((r) => setTimeout(r, 30));
      try { runEvent(c, ev); } catch (err) { ui.msg = `Something went wrong simulating ${eventTitle(ev)}: ${err.message}`; break; }
      ctx.save();
      if (c.inbox.filter((m) => !m.answered).length > inboxBefore) break;
    }
    const ev = nextEvent(c);
    if (ev && isUserEvent(c, ev)) c.date = ev.date.slice();
    ui.busy = null;
    ctx.save();
    draw();
  }

  root.onclick = (e) => {
    const row = e.target.closest('tr[data-team]');
    if (row && !e.target.closest('button')) return keep(() => { ui.team = ui.team === row.dataset.team ? null : row.dataset.team; });
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    try {
      if (b.dataset.tab) return keep(() => { ui.tab = b.dataset.tab; ui.team = null; g.hubTab = ui.tab; });
      if (b.dataset.accept) { answer(c, b.dataset.accept, true); ctx.save(); return keep(() => { ui.msg = null; }); }
      if (b.dataset.decline) { answer(c, b.dataset.decline, false); ctx.save(); return keep(() => {}); }
      if (b.dataset.ok) { const m = c.inbox.find((x) => x.id === b.dataset.ok); m.answered = 'seen'; ctx.save(); return keep(() => {}); }
      if (b.dataset.quit) { quitJob(c, b.dataset.quit); ctx.save(); return keep(() => {}); }
      if (b.dataset.take) { const [lg, team] = b.dataset.take.split(':'); takeJob(c, lg, team); ctx.save(); return keep(() => {}); }
      if (b.dataset.trade) { g.tradeContext = 'career'; g.tradeLeague = b.dataset.trade; ctx.go('trade'); return; }
    } catch (err) { return keep(() => { ui.msg = err.message; }); }
    const act = b.dataset.act;
    if (act === 'advance') advanceCalendar();
    else if (act === 'open') ctx.openEvent(nextEvent(c));
    else if (act === 'resume') ctx.resumeEvent();
  };
  draw();
}
