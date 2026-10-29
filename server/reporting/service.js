// Orchestrates the controlled reporting flow:
// question -> interpret -> authorise -> validate -> resolve entity -> execute -> validate output -> audit.
const { getPool, sql } = require('../db');
const { REPORTS } = require('./registry');
const { METRICS } = require('./metrics');
const { canAccess, CLASSIFICATIONS } = require('./policy');
const { getProvider } = require('./provider');
const { validateSpec, looksHostile } = require('./validator');
const { executeTemplate } = require('./engine');
const store = require('./store');

const metricById = Object.fromEntries(METRICS.map(m => [m.id, m]));
const round2 = n => Math.round(n * 100) / 100;

const SUGGESTIONS = [
  "What is this month's revenue?",
  "Compare this month's sales with last month",
  'Which products generated the most revenue?',
  'Which products are below their reorder points?',
  'Which products are likely to run out before the end of this month?',
  'Which customers have overdue balances?',
  'What supplier invoices remain unpaid?',
  'How much have we purchased from each supplier this month?',
  'Which items have not sold in the last 60 days?',
  'Show gross profit by item this month',
];

const escLike = s => s.replace(/[\\%_[]/g, ch => `\\${ch}`);

async function findEntities(scope, name, kind) {
  const pool = await getPool();
  const pat = `%${escLike(name)}%`;
  const out = [];
  const kinds = kind === 'supplier' ? ['supplier'] : kind === 'customer' ? ['customer'] : ['customer', 'supplier'];
  for (const k of kinds) {
    const r = await pool.request().input('o', sql.Int, scope.orgId).input('p', sql.NVarChar(120), pat)
      .query(`SELECT TOP 6 id, name FROM ${k === 'customer' ? 'customers' : 'suppliers'} WHERE organization_id = @o AND name LIKE @p ESCAPE '\\' ORDER BY name`);
    r.recordset.forEach(row => out.push({ kind: k, id: row.id, name: row.name }));
  }
  return out;
}

async function entityExists(scope, kind, id) {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, scope.orgId).input('id', sql.Int, id)
    .query(`SELECT name FROM ${kind === 'supplier' ? 'suppliers' : 'customers'} WHERE id = @id AND organization_id = @o`);
  return r.recordset[0]?.name ?? null;
}

function describeScope(scope) { return scope.branchId == null ? 'All branches in your organisation' : 'Your branch only'; }

function applyStatement(def, rows) {
  const sign = def.statement.debitIncreases ? 1 : -1;
  let running = 0, totalDebit = 0, totalCredit = 0, opening = 0;
  const out = rows.map((r, i) => {
    const d = r.debit || 0, c = r.credit || 0;
    if (i === 0 && r.entry_type === 'Opening balance') {
      opening = running = round2(sign * (d - c));
      return { ...r, debit: null, credit: null, running_balance: running };
    }
    totalDebit += d; totalCredit += c;
    running = round2(running + sign * (d - c));
    return { ...r, running_balance: running };
  });
  const hasOpening = out[0]?.entry_type === 'Opening balance';
  if (!hasOpening) out.unshift({ entry_date: null, entry_type: 'Opening balance', reference_no: '', description: 'Balance brought forward', debit: null, credit: null, running_balance: 0 });
  return {
    rows: out,
    kpis: [
      { label: 'Opening balance', value: opening, type: 'currency' },
      { label: def.statement.debitIncreases ? 'Invoiced' : 'Purchased', value: round2(def.statement.debitIncreases ? totalDebit : totalCredit), type: 'currency' },
      { label: def.statement.debitIncreases ? 'Received' : 'Paid', value: round2(def.statement.debitIncreases ? totalCredit : totalDebit), type: 'currency' },
      { label: 'Closing balance', value: running, type: 'currency' },
    ],
    closing: running,
  };
}

function followUps(reportId) {
  const map = {
    revenue_summary: ['Compare this month\'s sales with last month', 'Which products generated the most revenue?'],
    revenue_compare: ['Show sales by branch for the current quarter', 'Show gross profit by item this month'],
    top_products: ['Show gross profit by item this month'],
    receivables_aging: ['Show payments received this month'],
    low_stock: ['Which products are likely to run out before the end of this month?'],
    stock_depletion: ['Which products are below their reorder points?'],
    slow_moving: ['Which products are below their reorder points?'],
  };
  return map[reportId] || [];
}

// Runs a full spec (from the interpreter, a clarification option, or a saved report).
// Always re-authorises and re-validates; nothing is trusted from earlier executions.
async function runSpec(scope, spec, { question, action = 'run' } = {}) {
  const started = Date.now();
  const policy = await store.getPolicy(scope.orgId);
  const def0 = Object.prototype.hasOwnProperty.call(REPORTS, spec?.reportId) ? REPORTS[spec.reportId] : null;

  if (!def0) {
    await store.recordHistory(scope, { question, reportId: null, outcome: 'error' });
    return { status: 'error', message: 'That report is not available.' };
  }
  if (!canAccess(scope.role, def0.classification)) {
    await store.recordAccess(scope, { reportId: spec.reportId, classification: def0.classification, action, outcome: 'denied' });
    await store.recordHistory(scope, { question, reportId: spec.reportId, outcome: 'denied' });
    return { status: 'denied', message: `Your role does not have access to ${CLASSIFICATIONS[def0.classification].split(' - ')[0].toLowerCase()} reports.` };
  }

  const v = validateSpec(spec, policy);
  if (!v.ok) {
    await store.recordHistory(scope, { question, reportId: spec.reportId, outcome: 'error' });
    return { status: v.needsEntity ? 'clarification' : 'error', message: v.error };
  }
  const { def, params } = v;

  // Entity must exist inside the caller's organisation (also enforced again by every SQL template).
  let entityName = null;
  if (params.entityId) {
    entityName = await entityExists(scope, params.entityKind, params.entityId);
    if (!entityName) {
      await store.recordHistory(scope, { question, reportId: spec.reportId, outcome: 'error' });
      return { status: 'error', message: 'Account not found in your scope.' };
    }
  }

  let exec;
  try {
    exec = await executeTemplate(def, def.build(scope, params), policy, params.limit);
  } catch (err) {
    const timedOut = err.message === 'REPORT_TIMEOUT';
    console.error('[reporting] execution failed:', spec.reportId, err.message);
    await store.recordAccess(scope, { reportId: spec.reportId, classification: def.classification, action, outcome: timedOut ? 'timeout' : 'error' });
    await store.recordHistory(scope, { question, reportId: spec.reportId, params: { ...spec, entityName: undefined }, outcome: timedOut ? 'timeout' : 'error', durationMs: Date.now() - started });
    return { status: 'error', message: timedOut ? 'The report took too long and was stopped. Try a shorter period.' : 'The report could not be generated.' };
  }

  let { rows } = exec;
  if (def.postProcess) rows = def.postProcess(rows);
  let summary;
  if (def.statement) {
    const st = applyStatement(def, rows);
    rows = st.rows;
    summary = { headline: `${entityName}: closing balance ${st.closing.toLocaleString('en-PK', { maximumFractionDigits: 2 })} for ${params.period.label}.`, kpis: st.kpis };
  } else {
    summary = def.summarize(rows);
  }

  const caveats = [...def.caveats];
  if (exec.truncated) caveats.push(`Results limited to the first ${params.limit} rows. Narrow the period or filters for a complete list.${def.statement ? ' This statement is incomplete and will not reconcile.' : ''}`);
  if (!rows.length || (def.statement && rows.length <= 1)) caveats.push('No matching records were found for these filters.');

  const metric = metricById[def.metric];
  await store.recordAccess(scope, { reportId: spec.reportId, classification: def.classification, action, outcome: 'success', detail: `rows=${rows.length}` });
  await store.recordHistory(scope, { question, reportId: spec.reportId, params: spec, outcome: 'success', rowCount: rows.length, durationMs: Date.now() - started });

  return {
    status: 'ok',
    question: question || null,
    reportId: spec.reportId,
    title: def.title,
    classification: def.classification,
    interpretation: {
      metric: metric?.name, period: params.period?.label ?? null,
      from: params.period?.from ?? null, to: params.period?.to ?? null,
      filters: entityName ? { account: entityName, type: params.entityKind } : {}, limit: params.limit, scope: describeScope(scope),
    },
    summary,
    evidence: { columns: def.columns, rows, rowCount: rows.length, truncated: exec.truncated },
    calculation: metric ? { id: metric.id, name: metric.name, basis: metric.basis, definition: metric.definition } : null,
    caveats,
    visualization: { table: true, chart: def.chart ?? null },
    actions: followUps(spec.reportId),
    spec: { ...spec, entityId: params.entityId ?? undefined, entityKind: params.entityKind },
    generatedAt: new Date().toISOString(),
  };
}

async function ask(scope, { question, spec }) {
  // A pre-built spec (clarification choice) skips interpretation but not validation/authorisation.
  if (spec) return runSpec(scope, spec, { question });

  const text = String(question || '').trim();
  if (!text) return { status: 'error', message: 'Please enter a question.' };
  if (text.length > 500) return { status: 'error', message: 'Questions are limited to 500 characters.' };

  if (looksHostile(text)) {
    await store.recordAccess(scope, { action: 'ask', outcome: 'blocked', detail: 'hostile-pattern' });
    await store.recordHistory(scope, { question: '[blocked input]', outcome: 'blocked' });
    return { status: 'blocked', message: 'That request looks like an attempt to override system rules or run database commands. Only business questions are supported.' };
  }

  let interpreted;
  try {
    interpreted = await getProvider().interpret({ question: text, catalog: Object.entries(REPORTS).map(([id, r]) => ({ id, title: r.title, description: r.description })), today: new Date().toISOString().slice(0, 10) });
  } catch (err) {
    console.error('[reporting] provider failed:', err.message);
    await store.recordHistory(scope, { question: text, outcome: 'error' });
    return { status: 'error', message: 'The AI service is unavailable. You can still pick a suggested question or use the standard Reports page.' };
  }

  if (interpreted?.unsupported) {
    await store.recordHistory(scope, { question: text, outcome: 'unsupported' });
    return { status: 'unsupported', message: `${interpreted.unsupported} This figure cannot be calculated from the data currently recorded.` };
  }
  if (interpreted?.clarification) {
    await store.recordHistory(scope, { question: text, outcome: 'clarification' });
    return { status: 'clarification', message: interpreted.clarification, suggestions: SUGGESTIONS.slice(0, 5) };
  }

  const def = Object.prototype.hasOwnProperty.call(REPORTS, interpreted?.reportId) ? REPORTS[interpreted.reportId] : null;
  if (!def) {
    await store.recordHistory(scope, { question: text, outcome: 'clarification' });
    return { status: 'clarification', message: "I couldn't map that to an approved report.", suggestions: SUGGESTIONS.slice(0, 5) };
  }
  // Authorise before touching any data, including name lookups.
  if (!canAccess(scope.role, def.classification)) return runSpec(scope, interpreted, { question: text });

  const next = { ...interpreted };
  if (interpreted.entityName) {
    const matches = await findEntities(scope, interpreted.entityName, interpreted.entityKind);
    if (matches.length === 0) {
      await store.recordHistory(scope, { question: text, reportId: interpreted.reportId, outcome: 'clarification' });
      return { status: 'clarification', message: `I couldn't find an account matching "${interpreted.entityName}". Check the spelling or use the full name.` };
    }
    if (matches.length > 1) {
      await store.recordHistory(scope, { question: text, reportId: interpreted.reportId, outcome: 'clarification' });
      return {
        status: 'clarification',
        message: `"${interpreted.entityName}" matches more than one account. Which one do you mean?`,
        options: matches.map(m => ({ label: `${m.name} (${m.kind})`, spec: { ...interpreted, entityName: undefined, entityId: m.id, entityKind: m.kind, reportId: resolveReportForKind(interpreted.reportId, m.kind) } })),
      };
    }
    next.entityId = matches[0].id;
    next.entityKind = matches[0].kind;
    next.reportId = resolveReportForKind(interpreted.reportId, matches[0].kind);
  }
  return runSpec(scope, next, { question: text });
}

// "Ahmad's statement" resolved to a supplier should use the supplier statement, etc.
function resolveReportForKind(reportId, kind) {
  if (reportId === 'customer_statement' && kind === 'supplier') return 'supplier_statement';
  if (reportId === 'supplier_statement' && kind === 'customer') return 'customer_statement';
  return reportId;
}

function listDefinitions(role) {
  return Object.entries(REPORTS)
    .filter(([, r]) => canAccess(role, r.classification))
    .map(([id, r]) => ({ id, title: r.title, domain: r.domain, classification: r.classification, description: r.description, metric: r.metric,
      params: Object.fromEntries(Object.entries(r.params).map(([k, p]) => [k, { type: p.type, required: !!p.required, default: p.default ?? null, kind: p.kind }])) }));
}

module.exports = { ask, runSpec, listDefinitions, SUGGESTIONS };
