// Money is stored in lakh. ₹1 crore = 100 lakh.
export function money(lakh, { short = false } = {}) {
  if (lakh == null) return '—';
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
