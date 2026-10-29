// Resolves named reporting periods to inclusive YYYY-MM-DD ranges (server local time zone).
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const PERIODS = {
  today:         { label: 'Today' },
  yesterday:     { label: 'Yesterday' },
  this_week:     { label: 'This week (Mon-today)' },
  this_month:    { label: 'Current calendar month' },
  last_month:    { label: 'Previous calendar month' },
  this_quarter:  { label: 'Current calendar quarter' },
  this_year:     { label: 'Current calendar year' },
  last_30_days:  { label: 'Last 30 days' },
  last_60_days:  { label: 'Last 60 days' },
  last_90_days:  { label: 'Last 90 days' },
};

function resolvePeriod(name, now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let from, to;
  switch (name) {
    case 'today':        from = to = t; break;
    case 'yesterday':    from = to = addDays(t, -1); break;
    case 'this_week':    from = addDays(t, -((t.getDay() + 6) % 7)); to = t; break;
    case 'this_month':   from = new Date(t.getFullYear(), t.getMonth(), 1); to = new Date(t.getFullYear(), t.getMonth() + 1, 0); break;
    case 'last_month':   from = new Date(t.getFullYear(), t.getMonth() - 1, 1); to = new Date(t.getFullYear(), t.getMonth(), 0); break;
    case 'this_quarter': { const q = Math.floor(t.getMonth() / 3) * 3; from = new Date(t.getFullYear(), q, 1); to = new Date(t.getFullYear(), q + 3, 0); break; }
    case 'this_year':    from = new Date(t.getFullYear(), 0, 1); to = new Date(t.getFullYear(), 11, 31); break;
    case 'last_30_days': from = addDays(t, -29); to = t; break;
    case 'last_60_days': from = addDays(t, -59); to = t; break;
    case 'last_90_days': from = addDays(t, -89); to = t; break;
    default: return null;
  }
  return { name, label: PERIODS[name].label, from: iso(from), to: iso(to) };
}

// Equal-length period immediately before the given one (for comparisons).
function previousPeriod(p) {
  const from = new Date(`${p.from}T00:00:00`), to = new Date(`${p.to}T00:00:00`);
  if (p.name === 'this_month' || p.name === 'last_month') {
    const pf = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    return { name: 'previous', label: 'Previous month', from: iso(pf), to: iso(new Date(pf.getFullYear(), pf.getMonth() + 1, 0)) };
  }
  const days = Math.round((to - from) / 86400000) + 1;
  return { name: 'previous', label: `Previous ${days} days`, from: iso(addDays(from, -days)), to: iso(addDays(from, -1)) };
}

function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`)); }

module.exports = { PERIODS, resolvePeriod, previousPeriod, isIsoDate, iso };
