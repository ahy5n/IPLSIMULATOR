// After the auction: grades, value for money, a share card and a season prediction.
import { esc, money, ordinal } from '../format.js';
import { gradeTeams, valueAnalysis, predictSeason } from '../engine/grading.js';
import { teamChip, osTag, roleTag, squadTable } from './components.js';
import { masthead, footer } from './shell.js';

const VERDICT_TAG = { 'Steal': 'tag-good', 'Fair price': '', 'Overpaid': 'tag-gold', 'Big overpay': 'tag-bad' };

export function render(root, ctx) {
  const { scn, game } = ctx;
  const a = game.auction;
  const me = game.setup.team;
  const T = scn.teamById;
  const realYear = Object.keys(scn.actual || {}).length > 0;
  const realLabel = scn.year === 2025 ? '24–25 Nov 2024' : '16 Dec 2025';
  const cardLine = realYear ? `IPL ${scn.year} ${scn.kind === 'mega' ? 'MEGA ' : ''}AUCTION · ${(scn.venue || '').toUpperCase()} · ${realLabel.toUpperCase()}` : `IPL ${scn.year} ${scn.kind === 'mega' ? 'MEGA ' : ''}AUCTION · ${game.setup.length === 'dynasty' ? 'DYNASTY' : 'SIMULATED'}`;
  const grades = gradeTeams(a, scn);
  const mine = grades.find((g) => g.id === me);
  const values = valueAnalysis(a, scn, me);
  const squads = Object.fromEntries(Object.values(a.teams).map((t) => [t.id, t.squad]));
  const pred = game.prediction || (game.prediction = predictSeason(squads, scn, { sims: 600, seed: game.setup.seed }));
  ctx.save();
  const predRows = Object.entries(pred).sort((x, y) => y[1].titles - x[1].titles || y[1].playoffs - x[1].playoffs);
  const myPred = pred[me];
  const spent = mine.spent;
  const best = values.filter((v) => v.verdict === 'Steal').sort((x, y) => y.fair - y.price - (x.fair - x.price))[0];

  root.innerHTML = `${masthead()}
  <main class="stack-lg">
    <section class="grid-2" style="align-items:end;padding-top:8px">
      <div class="stack">
        <span class="eyebrow">${esc(T[me].name)} · IPL ${scn.year}</span>
        <h1>Auction report</h1>
        <p class="muted">Spent ${money(spent)} on ${values.length} player${values.length === 1 ? '' : 's'}; ${money(a.teams[me].purse)} left in the purse. Squad rating ${mine.before.overall.toFixed(1)} → <strong>${mine.after.overall.toFixed(1)}</strong>, ${ordinal(rankBy(grades, me, (g) => g.after.overall))} strongest in the league.</p>
      </div>
      <div class="panel row" style="justify-content:space-between">
        <div><div class="eyebrow">Grade</div><div class="grade">${mine.grade}</div><div class="muted" style="font-size:.85rem">${ordinal(mine.rank)} of 10 auctions</div></div>
        <div class="stack" style="gap:8px;text-align:right">
          <div><div class="eyebrow">Playoffs</div><div class="display" style="font-size:1.8rem">${pct(myPred.playoffs)}</div></div>
          <div><div class="eyebrow">Title</div><div class="display" style="font-size:1.8rem">${pct(myPred.titles)}</div></div>
        </div>
      </div>
    </section>

    <section class="stack">
      <div class="section-head"><h3>Your buys, against value</h3><span class="muted" style="font-size:.85rem">${realYear ? `Scout value · what really happened on ${realLabel}` : 'Scout value'}</span></div>
      ${values.length ? `<div class="panel scroll-x"><table>
        <thead><tr><th>Player</th><th class="r">Paid</th><th class="r">Value</th><th>Verdict</th>${realYear ? '<th>Real auction</th>' : ''}</tr></thead>
        <tbody>${values.map((v) => {
          const p = scn.players[v.id];
          const real = v.real ? `${teamChip(T[v.real.team])} <span class="num">${money(v.real.price)}</span>${v.real.rtm ? ' <span class="tag tag-data">RTM</span>' : ''}` : '<span class="muted">Unsold</span>';
          return `<tr><td><strong>${esc(p.name)}</strong> ${osTag(p)} ${roleTag(p)}</td><td class="r">${money(v.price)}</td><td class="r muted">${money(v.fair)}</td><td><span class="tag ${VERDICT_TAG[v.verdict]}">${v.verdict}</span></td>${realYear ? `<td>${real}</td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted">You did not buy anyone.</p>'}
      ${best ? `<p class="muted">Best value: <strong>${esc(scn.players[best.id].name)}</strong> at ${money(best.price)}, worth about ${money(best.fair)}.</p>` : ''}
    </section>

    <section class="stack">
      <div class="section-head"><h3>Share card</h3></div>
      <img class="share-img" id="shareImg" alt="Share card for your auction" width="1200" height="630">
      <div class="row">
        <button class="btn" data-act="copy">Copy summary</button>
        <span class="muted" id="copyMsg" style="font-size:.85rem">Right-click or long-press the card to save it.</span>
      </div>
      <textarea id="shareText" class="sr-only" readonly></textarea>
    </section>

    <section class="stack">
      <div class="section-head"><h3>Every team's auction</h3><span class="muted" style="font-size:.85rem">60% squad strength, 40% strength gained per crore</span></div>
      <div class="panel scroll-x"><table>
        <thead><tr><th>#</th><th>Team</th><th>Grade</th><th class="r">Rating</th><th class="r">Spent</th><th class="r">Left</th><th class="hide-sm">Top buy</th></tr></thead>
        <tbody>${grades.map((g) => {
          const top = a.teams[g.id].bought.filter((b) => !b.traded).sort((x, y) => y.price - x.price)[0];
          return `<tr class="${g.id === me ? 'me' : ''}"><td class="num">${g.rank}</td><td>${teamChip(T[g.id])}</td><td><strong>${g.grade}</strong></td><td class="r">${g.after.overall.toFixed(1)}</td><td class="r">${money(g.spent)}</td><td class="r">${money(a.teams[g.id].purse)}</td><td class="hide-sm">${top ? `${esc(scn.players[top.id].name)} <span class="muted num">${money(top.price)}</span>` : '<span class="muted">—</span>'}</td></tr>`;
        }).join('')}</tbody></table></div>
    </section>

    <section class="stack">
      <div class="section-head"><h3>Season prediction</h3><span class="muted" style="font-size:.85rem">600 simulated seasons</span></div>
      <div class="panel prob">
        <span class="eyebrow">Team</span><span class="eyebrow">Playoffs</span><span class="eyebrow"></span><span class="eyebrow">Title</span>
        ${predRows.map(([id, r]) => `<span>${teamChip(T[id])}</span><span class="bar ${id === me ? 'hi' : ''}"><i style="width:${r.playoffs * 100}%"></i></span><span class="num r" style="text-align:right">${pct(r.titles)}</span><span class="bar ${id === me ? 'hi' : ''}"><i style="width:${Math.min(100, r.titles * 250)}%"></i></span>`).join('')}
      </div>
      <p class="muted" style="font-size:.85rem">Bars: playoff chance on the left, title chance on the right (scaled ×2.5 so the spread is visible).</p>
    </section>

    <section class="stack">
      <div class="section-head"><h3>Your ${scn.year} squad</h3><span class="muted" style="font-size:.85rem">${a.teams[me].squad.length} players</span></div>
      <div class="panel">${squadTable(a.teams[me].squad, scn, { prices: Object.fromEntries([...a.teams[me].squad.map((id) => [id, scn.players[id].price]), ...a.teams[me].bought.map((b) => [b.id, b.price])]), highlight: new Set(a.teams[me].bought.map((b) => b.id)) })}</div>
    </section>

    <div class="grid-2">
      ${game.season ? '' : `<button class="btn bid-btn" data-act="trade">Open the trade window${(a.trades || []).length ? ` · ${a.trades.length} made` : ''}</button>`}
      <button class="btn btn-primary bid-btn" data-act="season">${game.season ? 'Back to the season' : `Start the IPL ${scn.year} season`}</button>
    </div>
  </main>${footer()}`;

  const text = shareText();
  root.querySelector('#shareText').value = text;
  drawCard().then((url) => { root.querySelector('#shareImg').src = url; });

  root.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'season') {
      if (!game.season) ctx.startSeason();
      ctx.save();
      ctx.go('season');
    } else if (b.dataset.act === 'trade') {
      game.tradeContext = 'auction';
      ctx.go('trade');
    } else if (b.dataset.act === 'copy') {
      const msg = root.querySelector('#copyMsg');
      try { await navigator.clipboard.writeText(text); msg.textContent = 'Copied.'; }
      catch {
        const ta = root.querySelector('#shareText');
        ta.classList.remove('sr-only'); ta.style.width = '100%'; ta.rows = 6; ta.select();
        msg.textContent = 'Copy the selected text.';
      }
    }
  };

  function shareText() {
    const buys = values.slice(0, 5).map((v) => `${scn.players[v.id].name} ${money(v.price)}`).join(', ');
    return `My IPL ${scn.year} auction as ${T[me].name}: grade ${mine.grade} (${ordinal(mine.rank)} of 10). Bought ${buys || 'nobody'}. Spent ${money(spent)}, ${money(a.teams[me].purse)} left. Playoff chance ${pct(myPred.playoffs)}, title ${pct(myPred.titles)}.`;
  }

  async function drawCard() {
    try { await Promise.all([document.fonts.load('800 80px "Inter"'), document.fonts.load('600 24px "Inter"')]); } catch { /* fallback fonts */ }
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 630;
    const g = c.getContext('2d');
    const team = T[me];
    g.fillStyle = '#050e2b'; g.fillRect(0, 0, 1200, 630);
    g.fillStyle = '#e8590c'; g.fillRect(0, 618, 1200, 12);
    g.fillStyle = team.color; g.fillRect(0, 0, 1200, 14);
    g.fillStyle = team.color2; g.fillRect(0, 14, 1200, 6);
    const D = '"Inter", system-ui, sans-serif', B = '"Inter", system-ui, sans-serif';
    const accent = '#ff7a2f';
    g.fillStyle = '#aab6dc'; g.font = `600 22px ${B}`; g.fillText(cardLine, 60, 78);
    g.fillStyle = '#f2f4f8'; g.font = `800 76px ${D}`; g.fillText(team.name.toUpperCase(), 60, 160, 820);
    g.fillStyle = accent; g.font = `800 230px ${D}`; g.textAlign = 'right'; g.fillText(mine.grade, 1140, 300);
    g.textAlign = 'left';
    g.fillStyle = '#aab6dc'; g.font = `600 20px ${B}`; g.fillText('TOP BUYS', 60, 230);
    values.slice(0, 5).forEach((v, i) => {
      const y = 280 + i * 52;
      g.fillStyle = '#f2f4f8'; g.font = `700 38px ${D}`; g.fillText(scn.players[v.id].name.toUpperCase(), 60, y, 520);
      g.fillStyle = '#f5b82e'; g.font = `700 38px ${D}`; g.fillText(money(v.price), 600, y);
    });
    if (!values.length) { g.fillStyle = '#aab6dc'; g.font = `700 38px ${D}`; g.fillText('NO PURCHASES', 60, 280); }
    g.fillStyle = '#1c2f66'; g.fillRect(60, 545, 1080, 2);
    g.fillStyle = '#f2f4f8'; g.font = `600 24px ${B}`;
    g.fillText(`Spent ${money(spent)}  ·  Left ${money(a.teams[me].purse)}  ·  Playoffs ${pct(myPred.playoffs)}  ·  Title ${pct(myPred.titles)}`, 60, 590);
    g.fillStyle = '#aab6dc'; g.font = `600 20px ${B}`; g.textAlign = 'right'; g.fillText(`${ordinal(mine.rank)} of 10`, 1140, 340);
    return c.toDataURL('image/png');
  }
}

function pct(x) { return `${Math.round(x * 100)}%`; }
function rankBy(rows, id, key) { return rows.slice().sort((a, b) => key(b) - key(a)).findIndex((r) => r.id === id) + 1; }
export function unmount() {}
