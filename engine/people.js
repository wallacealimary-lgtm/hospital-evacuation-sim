// people.js — who is in the building, and how each kind of person behaves.
//
// This is the file to edit when you want to "teach" the people something.
// Every person has a profile. A profile says how fast they walk, how long they
// take to react to the alarm, and whether they need staff to help them move.

export const PROFILES = {
  staff:       { label: 'Staff',                     speed: 1.30, radius: 0.23, premove: [20, 60],   colour: '#2a7de1' },
  visitor:     { label: 'Visitor / outpatient',      speed: 1.15, radius: 0.24, premove: [45, 150],  colour: '#e0a100' },
  ambulant:    { label: 'Ambulant patient',          speed: 0.70, radius: 0.25, premove: [60, 180],  colour: '#2fa36b' },
  // Dependent patients cannot leave alone: they wait for `helpers` staff,
  // then move together at `escortSpeed`. On a stair they are slowed by `stairFactor`.
  wheelchair:  { label: 'Dependent patient',         speed: 0, escortSpeed: 0.80, helpers: 1, radius: 0.40, stairFactor: 3, premove: [0, 0], colour: '#d9480f' },
  bed:         { label: 'Very high dependency (bed)', speed: 0, escortSpeed: 0.50, helpers: 2, radius: 0.60, stairFactor: 5, premove: [0, 0], colour: '#c2255c' },
};

const STAFF_ROOM = /staff|office|admin|on-call|nurse|duty|seminar|records|reception|store|pantry|utility|clean|dirty|anaesth|recovery|scrub|prep|control|plant|kitchen|beverage|sluice|equipment|linen|disposal|workroom|bay|station|base|hub/i;

// Turn each room's design occupancy into people. `shift` changes the mix:
//   day   = design occupancy (patients, visitors, outpatients and staff)
//   night = patients stay, no visitors/outpatients
// `staffing` scales the staff on duty: 1 = design staffing (every staff space full, ~620 people).
// Night default 0.07 is about 40 staff for 66 beds + critical care + theatres: an assumption, not data.
export const DEFAULT_STAFFING = { day: 1, night: 0.07 };

export function populate(building, shift, rand, staffing = DEFAULT_STAFFING[shift]) {
  // fractional staff are rounded at random, so 0.34 x 3 people is sometimes 1, sometimes 2
  const staffCount = n => Math.floor(n * staffing + rand());
  const out = [];
  const add = (room, profile, n) => { for (let k = 0; k < n; k++) out.push({ room, profile }); };
  building.rooms.forEach((r, ri) => {
    if (!r.occupancy && !r.beds) return;
    const dep = r.dependency;
    let patients = r.beds, patientProfile = dep === 'very high dependency' ? 'bed' : dep === 'dependent' ? 'wheelchair' : 'ambulant';
    // A theatre or isolation room with no bed count still holds one patient.
    if (!patients && dep === 'very high dependency') patients = 1;
    add(ri, patientProfile, patients);
    let others = Math.max(0, r.occupancy - patients);
    if (!others) return;
    const isWard = r.beds > 0;
    const staffy = dep === 'very high dependency' || STAFF_ROOM.test(r.name) || r.level !== 'L00';
    if (isWard) {                                     // bedroom: the extra people are visitors
      if (shift === 'day') add(ri, 'visitor', others);
    } else if (staffy) {
      add(ri, 'staff', staffCount(others));
    } else if (shift === 'day') {                     // waiting areas, consult rooms, WCs on the ground floor
      const s = Math.round(others * 0.25);
      add(ri, 'staff', staffCount(s)); add(ri, 'visitor', others - s);
    }
  });
  return out;
}

export const between = (rand, [a, b]) => a + (b - a) * rand();

// Walking speed drops as a crowd gets denser (Weidmann's fundamental diagram).
// density in persons per m²; returns a 0..1 multiplier.
export function crowdFactor(density) {
  if (density < 0.5) return 1;
  const rho = Math.min(density, 5.3);
  return Math.max(0.12, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4)));
}
