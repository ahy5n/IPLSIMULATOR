// Bowling types. Each type has its own strengths by phase, its own risk profile (wickets against runs),
// and its own response to pitch conditions. Captains use these to plan who bowls when.
//
//   phase: rating points added in the powerplay (overs 1-6), middle (7-15) and death (16-20)
//   wicket / boundary: multipliers on the ball-by-ball chance of a wicket or a boundary
//   pitch: extra rating points on each pitch, on top of the general pace/spin effect

export const BOWL_TYPES = {
  RF: { label: 'Right-arm fast', short: 'RF', kind: 'pace', phase: { pp: 3, mid: -2, death: 3 }, wicket: 1.12, boundary: 1.06, pitch: { green: 1, flat: 0, turning: 0 } },
  RFM: { label: 'Right-arm fast-medium', short: 'RFM', kind: 'pace', phase: { pp: 3, mid: 0, death: 0 }, wicket: 1, boundary: 1, pitch: { green: 3, flat: 0, turning: 0 } },
  RM: { label: 'Right-arm medium', short: 'RM', kind: 'pace', phase: { pp: -1, mid: 1, death: 1 }, wicket: 0.9, boundary: 0.97, pitch: { green: 1, flat: -3, turning: 2 } },
  LF: { label: 'Left-arm fast', short: 'LF', kind: 'pace', phase: { pp: 4, mid: -1, death: 2 }, wicket: 1.1, boundary: 1.03, pitch: { green: 1, flat: 0, turning: 0 } },
  LFM: { label: 'Left-arm fast-medium', short: 'LFM', kind: 'pace', phase: { pp: 3, mid: 0, death: 1 }, wicket: 1.04, boundary: 1, pitch: { green: 3, flat: 0, turning: 0 } },
  OB: { label: 'Off-spin', short: 'OB', kind: 'spin', phase: { pp: -1, mid: 2, death: -3 }, wicket: 0.92, boundary: 0.94, pitch: { green: 0, flat: -2, turning: 3 } },
  LB: { label: 'Leg-spin', short: 'LB', kind: 'spin', phase: { pp: -3, mid: 3, death: -1 }, wicket: 1.18, boundary: 1.08, pitch: { green: 0, flat: 0, turning: 1 } },
  SLA: { label: 'Left-arm orthodox', short: 'SLA', kind: 'spin', phase: { pp: 0, mid: 2, death: -3 }, wicket: 0.92, boundary: 0.93, pitch: { green: 0, flat: -2, turning: 3 } },
  LWS: { label: 'Left-arm wrist spin', short: 'LWS', kind: 'spin', phase: { pp: -3, mid: 3, death: -2 }, wicket: 1.2, boundary: 1.1, pitch: { green: 0, flat: 0, turning: 1 } },
};

// Specialisms: rating points in their phase, and how captains plan them.
export const BOWL_ROLES = {
  newball: { label: 'New-ball specialist', short: 'New ball', phase: 'pp', bonus: 4 },
  death: { label: 'Death specialist', short: 'Death', phase: 'death', bonus: 4 },
};

export function rolesOf(p) { return Array.isArray(p.br) ? p.br : []; }
export function rolesLabel(p) { return rolesOf(p).map((r) => BOWL_ROLES[r]?.short).filter(Boolean).join(' · '); }
export function roleBonus(p, phase) { return rolesOf(p).reduce((n, r) => n + (BOWL_ROLES[r]?.phase === phase ? BOWL_ROLES[r].bonus : 0), 0); }

const NEUTRAL = { label: '', short: '', kind: null, phase: { pp: 0, mid: 0, death: 0 }, wicket: 1, boundary: 1, pitch: {} };

// The type of a player, falling back on pace/spin for older data.
export function typeOf(p) {
  if (p.bt && BOWL_TYPES[p.bt]) return BOWL_TYPES[p.bt];
  if (p.bowlType === 'pace') return BOWL_TYPES.RFM;
  if (p.bowlType === 'spin') return BOWL_TYPES.OB;
  return NEUTRAL;
}

export function typeLabel(p) { return p.bowl >= 40 ? typeOf(p).label : ''; }

export function phaseBonus(p, phase) { return (typeOf(p).phase[phase] || 0) + roleBonus(p, phase); }

// Variety in an attack: captains like a left-arm seamer and a wrist spinner, and several different types.
export function attackVariety(ids, players) {
  const types = ids.map((id) => players[id]).filter((p) => p.bowl >= 55).map((p) => p.bt || (p.bowlType === 'spin' ? 'OB' : 'RFM'));
  const set = new Set(types);
  let v = 0;
  if (set.has('LF') || set.has('LFM')) v += 1.5;
  if (set.has('LB') || set.has('LWS')) v += 1.5;
  if (set.has('RF') || set.has('LF')) v += 1;
  v += Math.min(4, set.size) * 0.5;
  // ...and someone to take the new ball and someone to bowl at the death.
  const roles = ids.map((id) => players[id]).filter((p) => p.bowl >= 55).flatMap(rolesOf);
  if (roles.includes('newball')) v += 1;
  if (roles.includes('death')) v += 1.5;
  return v;
}
