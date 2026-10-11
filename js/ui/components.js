// Small HTML builders shared by the screens.
import { esc, money, ROLE_SHORT } from '../format.js';
import { BANDS, bandsLabel, styleLabel } from '../engine/batting.js';
import { typeOf, rolesLabel } from '../engine/bowling.js';

// Team colour mark: a thin two-tone stripe in the franchise's colours (no imitation logos).
export function badge(team, size = '') {
  return `<span class="badge ${size}" style="--c1:${team.color};--c2:${team.color2}" aria-hidden="true"></span>`;
}

export function teamChip(team) {
  return `<span class="chip">${badge(team, 'badge-sm')}<span>${esc(team.id)}</span></span>`;
}

// Role, batting archetype, bowling type and specialism, e.g. "BAT · Slogger" or "BOWL · Right-arm fast · Death".
export function roleTag(p) {
  const parts = [ROLE_SHORT[p.role]];
  if (styleLabel(p)) parts.push(styleLabel(p));
  const t = typeOf(p);
  if (t.label && p.bowl >= 40 && p.role !== 'BAT' && p.role !== 'WK') parts.push(t.label);
  if (rolesLabel(p)) parts.push(rolesLabel(p));
  return `<span class="tag">${parts.join(' · ')}</span>`;
}

// Squad grouped by where players bat: top order, middle order, lower order, then specialist bowlers.
export const POSITION_GROUPS = [['top', 'Top order'], ['middle', 'Middle order'], ['lower', 'Lower order'], ['tail', 'Bowlers']];
export function groupByPosition(ps) {
  const bands = (p) => (Array.isArray(p.pos) ? p.pos : ['middle']);
  const first = (p) => bands(p).reduce((best, b) => ((BANDS[b]?.[0] ?? 9) < (BANDS[best]?.[0] ?? 9) ? b : best), bands(p)[0]);
  const groups = POSITION_GROUPS.map(([key, label]) => ({ key, label, players: [] }));
  for (const p of ps) groups.find((g) => g.key === first(p)).players.push(p);
  for (const g of groups) g.players.sort((a, b) => (g.key === 'tail' ? b.bowl - a.bowl : b.bat - a.bat));
  return groups.filter((g) => g.players.length);
}

export function osTag(p) { return p.overseas ? '<span class="os" title="Overseas player">OS</span>' : ''; }

export function bar(label, v, hi = false) {
  return `<span>${label}</span><span class="bar ${hi ? 'hi' : ''}"><i style="width:${Math.max(2, Math.min(100, v))}%"></i></span><span class="num">${Math.round(v)}</span>`;
}

export function playerLine(p) {
  return `<span class="row" style="gap:6px"><strong>${esc(p.name)}</strong>${osTag(p)}</span>`;
}

export function statBlock(k, v, extra = '') {
  return `<div class="stat"><span class="k">${k}</span><span class="v ${extra}">${v}</span></div>`;
}

export function squadTable(ids, scn, { prices = {}, highlight = new Set() } = {}) {
  const groups = groupByPosition(ids.map((id) => scn.players[id]));
  return `<div class="scroll-x"><table>
    <thead><tr><th>Player</th><th>Role</th><th class="hide-sm">Bats</th><th class="r">Bat</th><th class="r">Bowl</th><th class="r">Price</th></tr></thead>
    <tbody>${groups.map((g) => `<tr class="group"><td colspan="6">${g.label}</td></tr>${g.players.map((p) => `<tr class="${highlight.has(p.id) ? 'me' : ''}">
      <td>${playerLine(p)}</td><td>${roleTag(p)}</td><td class="hide-sm muted">${bandsLabel(p)}</td><td class="r">${p.bat}</td><td class="r">${p.bowl}</td>
      <td class="r">${prices[p.id] != null ? money(prices[p.id]) : '—'}</td></tr>`).join('')}`).join('')}</tbody></table></div>`;
}

// Ten-segment meter, value 0-100. color is a CSS colour or variable.
export function meter(value, color = 'var(--data)', { large = false, label = '' } = {}) {
  const on = Math.round(Math.max(0, Math.min(100, value)) / 10);
  return `<span class="meter ${large ? 'meter-lg' : ''}" style="--m:${color}" role="img" aria-label="${label} ${Math.round(value)} of 100">${Array.from({ length: 10 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</span>`;
}

// Form -10..+10 shown as a labelled meter, coloured by direction.
export function formMeter(form, { label = true } = {}) {
  const c = form >= 2 ? 'var(--good)' : form <= -2 ? 'var(--bad)' : 'var(--data)';
  const m = meter((form + 10) * 5, c, { label: 'Form' });
  return label ? `<span class="meter-l"><span class="ml">Form</span>${m}<span class="mv">${formWord(form)}</span></span>` : m;
}

export function fitMeter(fit, { label = true } = {}) {
  const c = fit >= 80 ? 'var(--good)' : fit >= 65 ? 'var(--warn)' : 'var(--bad)';
  const m = meter(fit, c, { label: 'Fitness' });
  return label ? `<span class="meter-l"><span class="ml">Fitness</span>${m}<span class="mv">${Math.round(fit)}</span></span>` : m;
}

export function formWord(form) {
  return form >= 5 ? 'Hot' : form >= 2 ? 'Good' : form <= -5 ? 'Poor' : form <= -2 ? 'Patchy' : 'Steady';
}
