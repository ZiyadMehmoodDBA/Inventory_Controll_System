// Next fire times for a 5-field cron expression (minute hour day-of-month month day-of-week). Supports *, N, A-B, lists, and /step on any of them.
// Used to show "next run" in the backup console and to refuse schedules that fire too often. Numeric fields only (no names), so what the
// UI composes and what node-cron runs mean the same thing.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(text, [lo, hi]) {
  const out = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) return null;
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else { a = Number(m[2]); b = m[3] != null ? Number(m[3]) : (m[4] ? hi : a); }
    if (a < lo || b > hi || a > b) return null;
    for (let x = a; x <= b; x += step) out.add(x);
  }
  return out;
}

/** Parsed schedule, or null when the expression is not a valid 5-field numeric cron expression. */
function parse(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const sets = f.map((t, i) => parseField(t, RANGES[i]));
  if (sets.some(s => !s || !s.size)) return null;
  // Day-of-week 7 is not accepted; 0 is Sunday.
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow: sets[4], domStar: f[2].startsWith('*'), dowStar: f[4].startsWith('*') };
}

const matches = (s, d) => {
  if (!s.min.has(d.getMinutes()) || !s.hour.has(d.getHours()) || !s.mon.has(d.getMonth() + 1)) return false;
  const domOk = s.dom.has(d.getDate()), dowOk = s.dow.has(d.getDay());
  // Standard cron: when both day fields are restricted either may match; otherwise the restricted one decides.
  return s.domStar && s.dowStar ? true : s.domStar ? dowOk : s.dowStar ? domOk : domOk || dowOk;
};

/** The next `count` fire times after `from` (local time), looking at most `horizonDays` ahead. */
function nextRuns(expr, count = 1, from = new Date(), horizonDays = 400) {
  const s = parse(expr);
  if (!s) return [];
  const out = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < horizonDays * 1440 && out.length < count; i++, d.setMinutes(d.getMinutes() + 1)) {
    if (matches(s, d)) out.push(new Date(d.getTime()));
  }
  return out;
}

/** Smallest gap, in minutes, between consecutive runs within the next weeks. Infinity when it fires at most once in that window. */
function minGapMinutes(expr, from = new Date()) {
  const r = nextRuns(expr, 50, from, 60);
  if (r.length < 2) return Infinity;
  let g = Infinity;
  for (let i = 1; i < r.length; i++) g = Math.min(g, (r[i] - r[i - 1]) / 60000);
  return g;
}

module.exports = { parse, nextRuns, minGapMinutes };
