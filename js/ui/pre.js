// Before the auction: the user's retained squad and the purse, slots and overseas slots of every team.
import { esc, money } from '../format.js';
import { MODES, openSlots, overseasSlots, SQUAD_MIN, SQUAD_MAX, OVERSEAS_MAX } from '../engine/rules.js';
import { teamStrength } from '../engine/squad.js';
import { badge, squadTable, statBlock, teamChip } from './components.js';
import { masthead, footer } from './shell.js';

export function render(root, ctx) {
  const { scn, game } = ctx;
  const a = game.auction;
  const me = scn.teamById[game.setup.team];
  const myT = a.teams[me.id];
  const rows = scn.teams.map((t) => {
    const s = a.teams[t.id];
    return { t, purse: s.purse, squad: s.squad.length, slots: openSlots(s), os: overseasSlots(s, scn.players), rtm: s.rtm || 0, str: teamStrength(s.squad, scn.players).overall };
  });
  const mode = MODES[game.setup.mode];
  const mainLots = a.queue.length;
  const mega = a.kind === 'mega';
  const cost = me.retained.reduce((n, id) => n + (scn.players[id].price || 0), 0);
  const LG = scn.league?.short || 'IPL';
  const intro = scn.year > 2026 || mega || scn.league
    ? `${LG} ${scn.year} ${mega ? (LG === 'IPL' ? 'mega' : 'full') : 'mini'} auction. Salary cap ${money(myT.purse + cost)}; your retentions cost ${money(cost)}. ${scn.pool.length} players in the auction.${a.inflation > 1.05 ? ` With ${money(rows.reduce((n, r) => n + r.purse, 0))} chasing ${rows.reduce((n, r) => n + r.slots, 0)} slots, expect prices about ${a.inflation.toFixed(1)}× normal levels.` : ''}${mega && LG === 'IPL' ? ` Right-to-match: when a player you held last season is about to be sold, you can match the price; the buyer then gets one final raise.` : ''}`
    : '';
  root.innerHTML = `${masthead()}
  <main class="stack-lg">
    <section class="stack" style="padding-top:8px">
      <div class="row">${badge(me)}<span class="eyebrow">Your franchise · retained for ${scn.year}</span></div>
      <h1>${esc(me.name)}</h1>
      ${intro ? `<p class="muted">${intro}</p>` : ''}
      <div class="stats">
        ${statBlock('Purse', money(myT.purse), 'accent')}
        ${statBlock('Squad', `${myT.squad.length}/${SQUAD_MAX}`)}
        ${statBlock('Open slots', openSlots(myT))}
        ${statBlock('Overseas slots', overseasSlots(myT, scn.players))}
        ${mega && LG === 'IPL' ? statBlock('RTM cards', myT.rtm, 'accent') : ''}
      </div>
      <p class="muted">You need at least ${SQUAD_MIN} players and can have up to ${SQUAD_MAX}, with no more than ${OVERSEAS_MAX} from overseas. ${mode.label}: ${mainLots} lots in the opening sets, then ${mode.acceleratedRounds === 1 ? 'one accelerated round' : 'two accelerated rounds'} where teams nominate the players they want.</p>
    </section>

    <section class="stack">
      <div class="section-head"><h3>Every franchise before the hammer</h3><span class="muted" style="font-size:.85rem">${money(rows.reduce((n, r) => n + r.purse, 0))} for ${rows.reduce((n, r) => n + r.slots, 0)} slots</span></div>
      <div class="panel scroll-x"><table>
        <thead><tr><th>Team</th><th class="r">Purse</th><th class="r">Squad</th><th class="r">Slots</th><th class="r">Overseas</th>${mega ? '<th class="r">RTM</th>' : ''}<th class="r hide-sm">Rating</th></tr></thead>
        <tbody>${rows.sort((x, y) => y.purse - x.purse).map((r) => `<tr class="${r.t.id === me.id ? 'me' : ''}">
          <td>${teamChip(r.t)}</td><td class="r">${money(r.purse)}</td><td class="r">${r.squad}</td><td class="r">${r.slots}</td><td class="r">${r.os}</td>${mega ? `<td class="r">${r.rtm}</td>` : ''}<td class="r hide-sm">${r.str.toFixed(1)}</td></tr>`).join('')}
        </tbody></table></div>
    </section>

    <section class="stack">
      <div class="section-head"><h3>Your retained squad</h3><span class="muted" style="font-size:.85rem">Retention price</span></div>
      <div class="panel">${squadTable(myT.squad, scn, { prices: Object.fromEntries(myT.squad.map((id) => [id, scn.players[id].price])) })}</div>
    </section>

    <button class="btn btn-primary btn-block bid-btn" data-act="go">Enter the auction room</button>
  </main>${footer()}`;
  root.querySelector('[data-act="go"]').onclick = () => ctx.go('auction');
}
