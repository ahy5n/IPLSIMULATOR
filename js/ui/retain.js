// Off-season: see how the squad changed, then choose who to retain for the next auction.
// Mini years: keep anyone at his current salary. Mega years: keep up to six (five capped, two uncapped)
// at the fixed slabs; every retention you do not use becomes a right-to-match card.
import { esc, money } from '../format.js';
import { purseCap, teamPlayers, suggestFor, retentionCostFor, retentionProblemFor, megaRetentionCost, rtmCards, nextKind, MEGA_MAX, MEGA_SLABS, UNCAPPED_SLAB, isIcon, teamIcons } from '../engine/dynasty.js';
import { marketValue } from '../engine/valuation.js';
import { SQUAD_MAX, OVERSEAS_MAX } from '../engine/rules.js';
import { bandsLabel } from '../engine/batting.js';
import { badge, osTag, roleTag, statBlock, groupByPosition } from './components.js';
import { masthead, footer } from './shell.js';
import { LEAGUES } from '../engine/league.js';

export function unmount() {}

export function render(root, ctx) {
  const g = ctx.game, w = g.world, me = g.setup.team;
  const P = w.players;
  const team = ctx.base().teamById[me];
  const off = g.offseason || { before: {}, retiredMine: [], retiredStars: [], prospects: 0 };
  const kind = nextKind(w);
  const mega = kind === 'mega';
  const squad = teamPlayers(w, me);
  const suggested = new Set(suggestFor(w, me));
  const picks = new Set((g.retainPicks || [...suggested]).filter((id) => squad.includes(id)).concat(teamIcons(w, me)));
  const cap = w.cap ?? purseCap(w.year);
  // Career mode runs this screen for any league; the IPL keeps its slabs and right-to-match cards.
  const L = g.career ? LEAGUES[g.league] : LEAGUES.ipl;
  const LG = L.short;
  const ipl = L.id === 'ipl';
  const maxKeep = ipl ? MEGA_MAX.total : L.cycle.megaMax;
  const keepNormal = w.miniMax ?? SQUAD_MAX;   // most players kept in a normal year

  function intro() {
    if (g.career) {
      const last = w.history[w.history.length - 1];
      const recap = last?.champion ? `${LG} ${last.year}: ${esc(ctx.base().teamById[last.champion]?.name || last.champion)} won the title. ` : '';
      if (mega && ipl) return `${recap}It is a mega-auction year. Retain up to six (at most five capped, two uncapped) at the slabs: capped ₹18, 14, 11, 18 and 14 Cr in order, uncapped ₹4 Cr. Unused retentions become right-to-match cards. The salary cap is ${money(cap)}.`;
      if (mega) return `${recap}A full ${LG} auction this year: keep up to ${maxKeep} players at their current fee; everyone else goes back into the auction. The salary cap is ${money(cap)}.`;
      return `${recap}Keep up to ${keepNormal} at their current fee; everyone you release goes into the ${LG} ${w.year} auction.${ipl ? '' : ` Every third year the ${LG} resets and clubs keep only ${maxKeep}.`} The salary cap is ${money(cap)}.`;
    }
    if (off.intro === 'projected') return `The real IPL 2026 squads, one year on. Retentions for 2027 are due in November 2026; until they are published, you decide yours and AI teams decide theirs. Keep anyone at his current salary; everyone released goes into the IPL 2027 auction.`;
    if (off.intro === 'custom') return `A mega auction from the real 2026 squads. Every team has ${money(cap)}. Retain up to six (at most five capped, two uncapped) at the fixed slabs; each retention you do not use becomes a right-to-match card for the players you release.`;
    const last = w.history[w.history.length - 1];
    const recap = last?.champion ? `IPL ${last.year}: ${esc(ctx.base().teamById[last.champion].name)} won the title; you finished ${esc(last.finish)}. ` : '';
    return mega
      ? `${recap}It is a mega-auction year. Retain up to six (at most five capped, two uncapped) at the slabs: capped ₹18, 14, 11, 18 and 14 Cr in order, uncapped ₹4 Cr. Unused retentions become right-to-match cards. The salary cap is ${money(cap)}.`
      : `${recap}A year older, every player's rating has moved with age and form. Keep anyone at his current salary; everyone you release goes into the IPL ${w.year} mini auction. The salary cap is ${money(cap)}.`;
  }

  function draw() {
    const ids = [...picks];
    const cost = retentionCostFor(w, ids);
    const os = ids.filter((id) => P[id].overseas).length;
    const problem = retentionProblemFor(w, ids) || (os > OVERSEAS_MAX ? `At most ${OVERSEAS_MAX} overseas players` : null);
    const slabs = mega ? megaRetentionCost(w, ids).each : {};
    const cards = mega ? rtmCards(w, ids) : null;
    const capped = ids.filter((id) => P[id].capped).length;
    const groups = groupByPosition(squad.map((id) => P[id]));
    root.innerHTML = `${masthead(`<span class="tag ${mega ? 'tag-accent' : ''}">${LG} ${w.year} · ${mega ? (ipl ? 'Mega' : 'Full') : 'Mini'} auction</span>`)}
    <main class="stack-lg" style="padding-top:8px">
      <section class="stack">
        <div class="row">${badge(team)}<span class="eyebrow">${esc(team.name)} · retentions for ${LG} ${w.year}</span></div>
        <h1>Retentions</h1>
        <p class="muted">${intro()}</p>
        <div class="stats">
          ${statBlock('Retained', mega ? `${ids.length}/${maxKeep}` : `${ids.length}/${keepNormal}`)}
          ${mega && ipl ? statBlock('Capped / uncapped', `${capped} / ${ids.length - capped}`) : ''}
          ${statBlock('Cost', money(cost))}
          ${statBlock('Auction purse', money(cap - cost), 'accent')}
          ${mega && ipl ? statBlock('RTM cards', cards.rtm, 'accent') : statBlock('Overseas', `${os}/${OVERSEAS_MAX}`, os > OVERSEAS_MAX ? 'bad' : '')}
        </div>
        <div class="notice ${problem ? 'bad' : ''}">${problem ? esc(problem) : mega && ipl
          ? `${cards.rtm} right-to-match card${cards.rtm === 1 ? '' : 's'}${cards.rtm && cards.rtmCapped < cards.rtm ? ` (${cards.rtmCapped} usable on capped players)` : ''}. You can use them on anyone you release.`
          : `Retaining ${ids.length} leaves ${SQUAD_MAX - ids.length} slots to fill. The AI suggestion keeps players worth their salary.`}</div>
      </section>

      ${off.retiredMine?.length || off.retiredStars?.length ? `<section class="panel stack" style="gap:6px">
        <h3>Retirements</h3>
        ${off.retiredMine.length ? `<p>From your squad: ${off.retiredMine.map((id) => `<strong>${esc(P[id].name)}</strong> (${P[id].age})`).join(', ')}.</p>` : ''}
        ${off.retiredStars.length ? `<p class="muted">Around the league: ${off.retiredStars.filter((id) => !off.retiredMine.includes(id)).map((id) => `${esc(P[id].name)} (${P[id].age})`).join(', ') || 'none of note'}.</p>` : ''}
        <p class="muted" style="font-size:.85rem">${off.prospects} new uncapped prospects have registered for the auction.</p>
      </section>` : ''}

      <section class="stack">
        <div class="section-head"><h3>Your squad</h3><div class="row">
          <button class="btn btn-sm" data-act="suggest">Use AI suggestion</button>
          <button class="btn btn-sm btn-ghost" data-act="none">Release all</button></div></div>
        <div class="panel scroll-x"><table>
          <thead><tr><th>Keep</th><th>Player</th><th class="r">Age</th><th class="r">Rating</th><th class="r">${mega ? 'Cost' : 'Salary'}</th><th class="r hide-sm">Value</th><th class="hide-sm">AI</th></tr></thead>
          <tbody>${groups.map((g) => `<tr class="group"><td colspan="7">${g.label}</td></tr>${g.players.map((p) => {
            const b = off.before?.[p.id];
            const d = b != null ? p.ovr - b : 0;
            // In a mega year an unpicked capped player would cost the next slab in order.
            const nextSlab = capped < MEGA_SLABS.length ? MEGA_SLABS[capped] : null;
            const cost = mega && ipl ? (slabs[p.id] ?? (p.capped ? nextSlab : UNCAPPED_SLAB)) : (p.price || 30);
            const v = marketValue({ ...p, base: 30 });
            return `<tr class="${picks.has(p.id) ? 'me' : ''}">
              <td><input type="checkbox" data-keep="${p.id}" ${picks.has(p.id) ? 'checked' : ''} ${isIcon(w, p.id) ? 'disabled title="Franchise icon: never released"' : ''} aria-label="Retain ${esc(p.name)}" style="width:20px;height:20px;accent-color:var(--accent)"></td>
              <td><strong>${esc(p.name)}</strong> ${osTag(p)} ${roleTag(p)} ${p.capped ? '' : '<span class="tag">Uncapped</span>'}${isIcon(w, p.id) ? '<span class="tag tag-data">Franchise icon</span>' : ''}<span class="sub-line">${bandsLabel(p)}</span></td>
              <td class="r">${p.age}</td>
              <td class="r"><strong>${p.ovr}</strong> <span class="${d > 0 ? 'good' : d < 0 ? 'bad' : 'muted'}" style="font-size:.8rem">${d > 0 ? '+' + d : d < 0 ? d : ''}</span></td>
              <td class="r">${cost != null ? (mega && ipl && !picks.has(p.id) ? `<span class="muted">${money(cost)}</span>` : money(cost)) : '<span class="muted">—</span>'}</td>
              <td class="r hide-sm ${cost != null && v >= cost ? 'good' : 'muted'}">${money(v)}</td>
              <td class="hide-sm"><span class="tag ${suggested.has(p.id) ? 'tag-good' : ''}">${suggested.has(p.id) ? 'Keep' : 'Release'}</span></td></tr>`;
          }).join('')}`).join('')}</tbody></table></div>
      </section>

      <div class="spread"><span class="muted" style="font-size:.88rem">${(g.preTrades || []).length ? `${g.preTrades.length} trade${g.preTrades.length === 1 ? '' : 's'} made this off-season.` : 'Want to reshape the squad first? The trade window is open until you confirm retentions.'}</span>
        <button class="btn" data-act="trade">Open the trade window</button></div>
      <button class="btn btn-primary btn-block bid-btn" data-act="confirm" ${problem ? 'disabled' : ''}>Confirm ${ids.length} retention${ids.length === 1 ? '' : 's'} · ${g.career ? 'back to your career' : `go to the IPL ${w.year} auction`}</button>
    </main>${footer()}`;
  }

  const keepScroll = (fn) => { const y = window.scrollY; fn(); draw(); window.scrollTo(0, y); g.retainPicks = [...picks]; ctx.save(); };
  root.onchange = (e) => {
    const id = e.target.dataset.keep;
    if (!id) return;
    keepScroll(() => { if (e.target.checked) picks.add(id); else picks.delete(id); });
  };
  root.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'suggest') keepScroll(() => { picks.clear(); suggested.forEach((id) => picks.add(id)); });
    else if (b.dataset.act === 'none') keepScroll(() => { picks.clear(); teamIcons(w, me).forEach((id) => picks.add(id)); });
    else if (b.dataset.act === 'confirm') { root.onclick = root.onchange = null; g.preTrades = null; ctx.confirmRetentions([...picks]); }
    else if (b.dataset.act === 'trade') { g.retainPicks = [...picks]; g.tradeContext = g.career ? 'career' : 'retain'; g.tradeLeague = g.league; ctx.save(); ctx.go('trade'); }
  };
  draw();
}
