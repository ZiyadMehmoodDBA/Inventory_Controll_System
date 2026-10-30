// Backup schedules are stored as five-field cron expressions (minute hour day-of-month month day-of-week). This turns the handful of
// patterns the console offers into plain words and back, and falls back to showing the raw expression for anything else.
export type Preset = 'every' | 'hourly' | 'daily' | 'weekly' | 'custom';

export interface Schedule { preset: Preset; every: number; minute: number; hour: number; dow: number; cron: string }

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const EVERY_CHOICES = [5, 10, 15, 20, 30];

const pad = (n: number) => String(n).padStart(2, '0');

export function compose(s: Schedule): string {
  switch (s.preset) {
    case 'every':  return `*/${s.every} * * * *`;
    case 'hourly': return `${s.minute} * * * *`;
    case 'daily':  return `${s.minute} ${s.hour} * * *`;
    case 'weekly': return `${s.minute} ${s.hour} * * ${s.dow}`;
    default:       return s.cron.trim();
  }
}

export function parseCron(cron: string): Schedule {
  const base: Schedule = { preset: 'custom', every: 30, minute: 0, hour: 2, dow: 0, cron };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [mi, h, dom, mon, dow] = f;
  const num = (x: string, max: number) => (/^\d+$/.test(x) && Number(x) <= max ? Number(x) : null);
  if (dom !== '*' || mon !== '*') return base;
  const step = /^\*\/(\d+)$/.exec(mi);
  if (step && EVERY_CHOICES.includes(Number(step[1])) && h === '*' && dow === '*') return { ...base, preset: 'every', every: Number(step[1]) };
  const m = num(mi, 59);
  if (m === null) return base;
  if (h === '*' && dow === '*') return { ...base, preset: 'hourly', minute: m };
  const hh = num(h, 23);
  if (hh === null) return base;
  if (dow === '*') return { ...base, preset: 'daily', minute: m, hour: hh };
  const d = num(dow, 6);
  if (d !== null) return { ...base, preset: 'weekly', minute: m, hour: hh, dow: d };
  return base;
}

export function describeCron(cron: string): string {
  const s = parseCron(cron);
  switch (s.preset) {
    case 'every':  return `Every ${s.every} minutes`;
    case 'hourly': return `Hourly at :${pad(s.minute)}`;
    case 'daily':  return `Daily at ${pad(s.hour)}:${pad(s.minute)}`;
    case 'weekly': return `${DAYS[s.dow]}s at ${pad(s.hour)}:${pad(s.minute)}`;
    default:       return `Custom (${cron})`;
  }
}
