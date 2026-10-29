// AI provider adapter. The provider's only job is to turn a question into a structured report
// specification { reportId, period?, days?, limit?, entityName?, entityKind? } or a clarification.
// It never sees data, never writes SQL and never holds database credentials.
//
// To add a provider (cloud or local LLM), implement `interpret({ question, catalog, today })`
// returning the same spec shape and register it in PROVIDERS. Its output is re-validated by
// validator.js, so a faulty or manipulated model cannot reach anything outside the registry.
const { UNSUPPORTED } = require('./registry');

// ── Mock / rule-based interpreter (default; no external calls) ───────────────
const PERIOD_RULES = [
  [/\btoday\b/i, 'today'], [/\byesterday\b/i, 'yesterday'],
  [/this week/i, 'this_week'], [/(this|current) month|month to date/i, 'this_month'],
  [/last month|previous month/i, 'last_month'], [/(this|current) quarter/i, 'this_quarter'],
  [/(this|current) year/i, 'this_year'],
  [/(last|past) 30 days/i, 'last_30_days'], [/(last|past) 60 days/i, 'last_60_days'], [/(last|past) 90 days/i, 'last_90_days'],
];

function findPeriod(q) { for (const [re, name] of PERIOD_RULES) if (re.test(q)) return name; return undefined; }
function findDays(q)   { const m = q.match(/(\d{1,3})\s*days/i); return m ? Number(m[1]) : undefined; }

// Pull a person/company name out of phrases such as "Ahmad's account statement", "payments from Ali",
// "how much does Ahmad owe us". Returns undefined when none is found.
const NAME = "([A-Z][\\w.&'-]*(?:\\s+[A-Z][\\w.&'-]*){0,3})";
function findEntity(q) {
  const pats = [
    new RegExp(`statement (?:for|of) ${NAME}`), new RegExp(`${NAME}'s\\b`),
    new RegExp(`(?:from|by|for|of|to) ${NAME}`), new RegExp(`does ${NAME} owe`), new RegExp(`did ${NAME} pay`), new RegExp(`how much (?:did|does|has) ${NAME}`),
  ];
  const stop = /^(We|Our|This|Last|Each|Every|The|Which|What|How|Show|Compare|Current|Customers|Suppliers)$/;
  for (const re of pats) {
    const m = q.match(re);
    if (m && !stop.test(m[1].split(' ')[0])) return m[1].replace(/'s$/, '').trim();
  }
  return undefined;
}

const RULES = [
  { re: /net profit|operating expense|expenses?\b/i, kind: 'unsupported' },
  { re: /statement/i,                          report: 'statement' },
  { re: /\b(owe|owes|balance of|outstanding balance)\b/i, report: 'balance' },
  { re: /payments?\b.*(receiv|from|by)|how much did .* pay|paid us/i, report: 'customer_payments' },
  { re: /overdue|receivable|aging|ageing/i,    report: 'receivables_aging' },
  { re: /unpaid.*supplier|supplier.*unpaid|payable|owe.* suppliers?/i, report: 'supplier_unpaid' },
  { re: /(purchas|bought).*(supplier)|from each supplier|paid to each supplier/i, report: 'purchases_by_supplier' },
  { re: /compare|versus|\bvs\b/i,              report: 'revenue_compare' },
  { re: /gross profit|cost of goods/i,         report: 'gross_profit_by_product' },
  { re: /by branch|per branch|branch/i,        report: 'sales_by_branch' },
  { re: /most revenue|top (products|items)|best[- ]sell|generated the most/i, report: 'top_products' },
  { re: /run out|stock ?out|finish|deplet/i,   report: 'stock_depletion' },
  { re: /reorder|low stock|below.*level/i,     report: 'low_stock' },
  { re: /not sold|slow[- ]moving|dead stock|capital.*(tied|stock)|no sales/i, report: 'slow_moving' },
  { re: /revenue|sales|sold/i,                 report: 'revenue_summary' },
];

const MockProvider = {
  name: 'mock', isExternal: false,
  async interpret({ question }) {
    const q = String(question || '');
    for (const u of UNSUPPORTED) {
      if (u.match.test(q)) return { unsupported: u.reason };
    }
    const rule = RULES.find(r => r.re.test(q));
    if (!rule) return { clarification: "I couldn't map that to an approved report. Try rephrasing, or pick one of the suggested questions." };
    const entityName = findEntity(q);
    const period = findPeriod(q);
    const supplierWords = /supplier|vendor/i.test(q);
    let spec;
    switch (rule.report) {
      case 'statement':
        if (!entityName) return { clarification: 'Whose account statement do you need? Please name the customer or supplier.' };
        spec = { reportId: supplierWords ? 'supplier_statement' : 'customer_statement', entityName, entityKind: supplierWords ? 'supplier' : 'customer', period }; break;
      case 'balance':
        if (!entityName) return { clarification: 'Which customer or supplier balance do you need? Please include the name.' };
        spec = { reportId: 'account_balance', entityName, entityKind: supplierWords ? 'supplier' : undefined }; break;
      case 'customer_payments':
        spec = { reportId: 'payments_received', entityName, entityKind: 'customer', period }; break;
      case 'revenue_compare':
        spec = { reportId: 'revenue_compare', period }; break;
      case 'slow_moving': case 'stock_depletion':
        spec = { reportId: rule.report, days: findDays(q) }; break;
      default:
        spec = { reportId: rule.report, period, days: findDays(q) };
    }
    spec.confidence = 'rule-based';
    return spec;
  },
};

const PROVIDERS = { mock: MockProvider };

function getProvider() {
  const name = (process.env.AI_PROVIDER || 'mock').toLowerCase();
  if (!PROVIDERS[name]) {
    console.warn(`[reporting] Unknown AI_PROVIDER "${name}", falling back to mock.`);
    return MockProvider;
  }
  return PROVIDERS[name];
}

module.exports = { getProvider, PROVIDERS };
