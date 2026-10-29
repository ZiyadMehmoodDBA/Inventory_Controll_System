// Persistence for the reporting module: supporting tables, policy, history, access audit, saved reports.
// Result rows are never stored here; history keeps only the question, report id, parameters and outcome.
const { getPool, sql } = require('../db');
const { REPORTS } = require('./registry');
const { METRICS } = require('./metrics');
const { DEFAULT_POLICY } = require('./policy');

async function initReportingTables(pool) {
  const run = q => pool.request().query(q);
  await run(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='report_definitions' AND xtype='U')
    CREATE TABLE report_definitions (
      report_id      NVARCHAR(60)  NOT NULL PRIMARY KEY,
      title          NVARCHAR(200) NOT NULL,
      domain         NVARCHAR(50)  NOT NULL,
      classification NVARCHAR(40)  NOT NULL,
      metric_id      NVARCHAR(60)  NULL,
      description    NVARCHAR(500) NULL,
      is_enabled     BIT           NOT NULL DEFAULT 1,
      updated_at     DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await run(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='metric_definitions' AND xtype='U')
    CREATE TABLE metric_definitions (
      metric_id  NVARCHAR(60)   NOT NULL PRIMARY KEY,
      name       NVARCHAR(200)  NOT NULL,
      basis      NVARCHAR(100)  NULL,
      definition NVARCHAR(1000) NOT NULL,
      updated_at DATETIME2      NOT NULL DEFAULT GETDATE()
    )`);
  await run(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='saved_reports' AND xtype='U')
    CREATE TABLE saved_reports (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      user_id         INT           NOT NULL,
      name            NVARCHAR(150) NOT NULL,
      report_id       NVARCHAR(60)  NOT NULL,
      params_json     NVARCHAR(MAX) NOT NULL,
      question        NVARCHAR(500) NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await run(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='report_execution_history' AND xtype='U')
    CREATE TABLE report_execution_history (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NULL,
      user_id         INT           NOT NULL,
      question        NVARCHAR(500) NULL,
      report_id       NVARCHAR(60)  NULL,
      params_json     NVARCHAR(MAX) NULL,
      outcome         NVARCHAR(20)  NOT NULL,
      row_count       INT           NULL,
      duration_ms     INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await run(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='report_access_audit' AND xtype='U')
    CREATE TABLE report_access_audit (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NULL,
      user_id         INT           NOT NULL,
      report_id       NVARCHAR(60)  NULL,
      classification  NVARCHAR(40)  NULL,
      action          NVARCHAR(20)  NOT NULL,
      outcome         NVARCHAR(20)  NOT NULL,
      detail          NVARCHAR(200) NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await run(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='reporting_policy_configuration' AND xtype='U')
    CREATE TABLE reporting_policy_configuration (
      organization_id        INT       NOT NULL PRIMARY KEY,
      row_limit              INT       NOT NULL DEFAULT 500,
      timeout_ms             INT       NOT NULL DEFAULT 15000,
      external_ai_approved   BIT       NOT NULL DEFAULT 0,
      send_results_to_model  BIT       NOT NULL DEFAULT 0,
      history_retention_days INT       NOT NULL DEFAULT 90,
      updated_at             DATETIME2 NOT NULL DEFAULT GETDATE()
    )`);
  await run(`IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_report_history_org_user')
    CREATE INDEX IX_report_history_org_user ON report_execution_history (organization_id, user_id, created_at DESC)`);
  await run(`IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_report_audit_org')
    CREATE INDEX IX_report_audit_org ON report_access_audit (organization_id, created_at DESC)`);

  await syncDefinitions(pool);
  await purgeExpired(pool);
}

// Keep the catalogue tables in step with the code registry (the registry is authoritative).
async function syncDefinitions(pool) {
  for (const m of METRICS) {
    await pool.request()
      .input('id', sql.NVarChar(60), m.id).input('name', sql.NVarChar(200), m.name)
      .input('basis', sql.NVarChar(100), m.basis).input('def', sql.NVarChar(1000), m.definition)
      .query(`MERGE metric_definitions AS t USING (SELECT @id AS metric_id) s ON t.metric_id = s.metric_id
              WHEN MATCHED THEN UPDATE SET name=@name, basis=@basis, definition=@def, updated_at=GETDATE()
              WHEN NOT MATCHED THEN INSERT (metric_id,name,basis,definition) VALUES (@id,@name,@basis,@def);`);
  }
  for (const [id, r] of Object.entries(REPORTS)) {
    await pool.request()
      .input('id', sql.NVarChar(60), id).input('title', sql.NVarChar(200), r.title).input('domain', sql.NVarChar(50), r.domain)
      .input('cls', sql.NVarChar(40), r.classification).input('metric', sql.NVarChar(60), r.metric).input('desc', sql.NVarChar(500), r.description)
      .query(`MERGE report_definitions AS t USING (SELECT @id AS report_id) s ON t.report_id = s.report_id
              WHEN MATCHED THEN UPDATE SET title=@title, domain=@domain, classification=@cls, metric_id=@metric, description=@desc, updated_at=GETDATE()
              WHEN NOT MATCHED THEN INSERT (report_id,title,domain,classification,metric_id,description) VALUES (@id,@title,@domain,@cls,@metric,@desc);`);
  }
}

async function purgeExpired(pool) {
  await pool.request().query(`
    DELETE h FROM report_execution_history h
    LEFT JOIN reporting_policy_configuration c ON c.organization_id = h.organization_id
    WHERE h.created_at < DATEADD(DAY, -ISNULL(c.history_retention_days, ${DEFAULT_POLICY.history_retention_days}), GETDATE())`);
}

async function getPolicy(orgId) {
  try {
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).query('SELECT * FROM reporting_policy_configuration WHERE organization_id = @o');
    const row = r.recordset[0];
    return row ? { ...DEFAULT_POLICY, ...row, external_ai_approved: !!row.external_ai_approved, send_results_to_model: !!row.send_results_to_model } : { ...DEFAULT_POLICY };
  } catch { return { ...DEFAULT_POLICY }; }
}

// Audit/history writes never throw: a logging failure must not break (or leak through) a report.
async function recordHistory(scope, { question, reportId, params, outcome, rowCount, durationMs }) {
  try {
    const pool = await getPool();
    await pool.request()
      .input('o', sql.Int, scope.orgId).input('b', sql.Int, scope.branchId).input('u', sql.Int, scope.userId)
      .input('q', sql.NVarChar(500), question ? String(question).slice(0, 500) : null)
      .input('r', sql.NVarChar(60), reportId || null)
      .input('p', sql.NVarChar(sql.MAX), params ? JSON.stringify(params) : null)
      .input('out', sql.NVarChar(20), outcome).input('n', sql.Int, rowCount ?? null).input('d', sql.Int, durationMs ?? null)
      .query(`INSERT INTO report_execution_history (organization_id,branch_id,user_id,question,report_id,params_json,outcome,row_count,duration_ms)
              VALUES (@o,@b,@u,@q,@r,@p,@out,@n,@d)`);
  } catch (e) { console.error('[reporting] history write failed:', e.message); }
}

async function recordAccess(scope, { reportId, classification, action, outcome, detail }) {
  try {
    const pool = await getPool();
    await pool.request()
      .input('o', sql.Int, scope.orgId).input('b', sql.Int, scope.branchId).input('u', sql.Int, scope.userId)
      .input('r', sql.NVarChar(60), reportId || null).input('c', sql.NVarChar(40), classification || null)
      .input('a', sql.NVarChar(20), action).input('out', sql.NVarChar(20), outcome).input('d', sql.NVarChar(200), detail ? String(detail).slice(0, 200) : null)
      .query(`INSERT INTO report_access_audit (organization_id,branch_id,user_id,report_id,classification,action,outcome,detail)
              VALUES (@o,@b,@u,@r,@c,@a,@out,@d)`);
  } catch (e) { console.error('[reporting] access audit write failed:', e.message); }
}

async function listHistory(scope, limit = 50) {
  const pool = await getPool();
  const own = scope.role === 'org_admin' ? '' : 'AND h.user_id = @u';
  const r = await pool.request().input('o', sql.Int, scope.orgId).input('u', sql.Int, scope.userId).input('n', sql.Int, limit)
    .query(`SELECT TOP (@n) h.id, h.user_id, h.question, h.report_id, h.outcome, h.row_count, h.duration_ms, h.created_at
            FROM report_execution_history h WHERE h.organization_id = @o ${own} ORDER BY h.created_at DESC`);
  return r.recordset;
}

async function listSaved(scope) {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, scope.orgId).input('u', sql.Int, scope.userId)
    .query('SELECT id, name, report_id, question, created_at FROM saved_reports WHERE organization_id = @o AND user_id = @u ORDER BY created_at DESC');
  return r.recordset;
}

async function getSaved(scope, id) {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, scope.orgId).input('u', sql.Int, scope.userId).input('id', sql.Int, id)
    .query('SELECT * FROM saved_reports WHERE id = @id AND organization_id = @o AND user_id = @u');
  const row = r.recordset[0];
  return row ? { ...row, params: JSON.parse(row.params_json) } : null;
}

async function createSaved(scope, { name, reportId, spec, question }) {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, scope.orgId).input('u', sql.Int, scope.userId)
    .input('n', sql.NVarChar(150), name).input('r', sql.NVarChar(60), reportId)
    .input('p', sql.NVarChar(sql.MAX), JSON.stringify(spec)).input('q', sql.NVarChar(500), question ? String(question).slice(0, 500) : null)
    .query(`INSERT INTO saved_reports (organization_id,user_id,name,report_id,params_json,question)
            OUTPUT INSERTED.id VALUES (@o,@u,@n,@r,@p,@q)`);
  return r.recordset[0].id;
}

async function deleteSaved(scope, id) {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, scope.orgId).input('u', sql.Int, scope.userId).input('id', sql.Int, id)
    .query('DELETE FROM saved_reports WHERE id = @id AND organization_id = @o AND user_id = @u');
  return r.rowsAffected[0] > 0;
}

module.exports = { initReportingTables, getPolicy, recordHistory, recordAccess, listHistory, listSaved, getSaved, createSaved, deleteSaved };
