// Money is stored in lakh of the IPL scale. ₹1 crore = 100 lakh. Other leagues show it in their own
// currency: setCurrency() is called when the active league changes (js/engine/league.js).
let CUR = null;
export function setCurrency(c) { CUR = c; }

// Amount in a currency: { sym, rate (local units per lakh), unit: 'crore' | 'thousand' }.
export function moneyIn(c, lakh, { short = false } = {}) {
  if (lakh == null) return '—';
  if (!c) return money(lakh, { short, raw: true });
  const local = lakh * c.rate;
  const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, '');
  if (c.unit === 'crore') {   // PKR crore and lakh, like the IPL
    return local >= 100 ? `${c.sym}${short ? '' : ' '}${trim(local / 100, 2)}${short ? 'Cr' : ' Cr'}` : `${c.sym}${short ? '' : ' '}${Math.round(local)}${short ? 'L' : ' L'}`;
  }
  // thousands of rand or pounds
  return local >= 1000 ? `${c.sym}${trim(local / 1000, 2)}m` : `${c.sym}${Math.round(local / 5) * 5}k`;
}

export function money(lakh, { short = false, raw = false } = {}) {
  if (lakh == null) return '—';
  if (CUR && !raw) return moneyIn(CUR, lakh, { short });
  if (lakh >= 100) {
    const cr = lakh / 100;
    const s = cr.toFixed(2).replace(/\.?0+$/, '');
    return short ? `₹${s}Cr` : `₹${s} Cr`;
  }
  return short ? `₹${lakh}L` : `₹${lakh} L`;
}

export const ROLE_LABEL = { BAT: 'Batter', WK: 'Wicketkeeper', AR: 'All-rounder', BOWL: 'Bowler' };
export const ROLE_SHORT = { BAT: 'BAT', WK: 'WK', AR: 'AR', BOWL: 'BOWL' };

export function oversText(balls) {
  return `${Math.floor(balls / 6)}${balls % 6 ? '.' + (balls % 6) : ''}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
