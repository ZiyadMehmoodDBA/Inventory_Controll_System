// Validates a report specification (from any provider or a saved report) against the registry.
// Returns { ok: true, params } with fully resolved, clamped, typed parameters, or { ok: false, error }.
const { REPORTS } = require('./registry');
const { resolvePeriod, isIsoDate, PERIODS } = require('./periods');

// Heuristics for logging/blocking obviously hostile input. Safety does not depend on them:
// user text is never executed or concatenated into SQL.
const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above) (instructions|rules)/i,
  /(reveal|show|print).{0,30}(system prompt|instructions|api key|password|secret|connection string)/i,
  /\b(drop|truncate|alter|delete|insert|update|exec(ute)?|xp_cmdshell)\b.{0,40}\b(table|database|from|into|set|proc)/i,
  /;\s*(select|drop|delete|update|insert|exec)\b/i,
  /\bunion\s+select\b/i,
  /--\s*$/,
];
const looksHostile = text => INJECTION.some(re => re.test(String(text || '')));

function validateSpec(spec, policy) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'Invalid report specification.' };
  const def = REPORTS[spec.reportId];
  if (!Object.prototype.hasOwnProperty.call(REPORTS, spec.reportId) || !def) return { ok: false, error: 'Unknown report.' };

  const params = {};
  for (const [key, rule] of Object.entries(def.params)) {
    if (rule.type === 'period') {
      let name = spec.period || rule.default;
      if (typeof name === 'object' && name) {
        // custom range
        if (!isIsoDate(name.from) || !isIsoDate(name.to) || name.from > name.to) return { ok: false, error: 'Invalid date range.' };
        const days = (new Date(name.to) - new Date(name.from)) / 86400000;
        if (days > 731) return { ok: false, error: 'Date range may not exceed two years.' };
        params.period = { name: 'custom', label: `${name.from} to ${name.to}`, from: name.from, to: name.to };
      } else {
        if (!Object.prototype.hasOwnProperty.call(PERIODS, name)) return { ok: false, error: 'Unsupported period.' };
        params.period = resolvePeriod(name);
      }
    } else if (rule.type === 'int') {
      let v = spec[key] === undefined || spec[key] === null ? rule.default : Number(spec[key]);
      if (!Number.isInteger(v)) return { ok: false, error: `Parameter ${key} must be a whole number.` };
      v = Math.min(Math.max(v, rule.min), rule.max);
      params[key] = v;
    } else if (rule.type === 'entity') {
      const id = spec.entityId;
      if (id === undefined || id === null) {
        if (rule.required) return { ok: false, error: 'An account must be selected.', needsEntity: true };
        params.entityId = null;
      } else {
        if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Invalid account reference.' };
        params.entityId = id;
        params.entityKind = spec.entityKind || (rule.kind === 'any' ? 'customer' : rule.kind);
        if (!['customer', 'supplier'].includes(params.entityKind)) return { ok: false, error: 'Invalid account type.' };
        if (rule.kind !== 'any' && params.entityKind !== rule.kind) return { ok: false, error: 'Account type does not match this report.' };
      }
    }
  }
  if (params.limit !== undefined) params.limit = Math.min(params.limit, policy.row_limit);
  else params.limit = Math.min(200, policy.row_limit);
  return { ok: true, def, params };
}

module.exports = { validateSpec, looksHostile };
