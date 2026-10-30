// Backup console: who may operate the platform, the editable backup configuration, and the editable job list.
exports.description = 'platform admin flag, platform_settings, backup_jobs, backup_runs.job_id/source';

exports.up = async (tx, sql) => {
  const run = s => new sql.Request(tx).batch(s);

  // Backups cover every organisation's data, so only designated platform operators may run or configure them.
  // The administrators of the first organisation (the one that owns this installation) are granted it once; after that it is changed only by
  // scripts/grant-platform-admin.js, never from the UI, so a tenant administrator cannot promote themselves.
  await run(`
    IF COL_LENGTH('users', 'is_platform_admin') IS NULL
      ALTER TABLE users ADD is_platform_admin BIT NOT NULL CONSTRAINT DF_users_platform_admin DEFAULT 0`);
  await run(`
    UPDATE users SET is_platform_admin = 1
    WHERE role = 'org_admin' AND organization_id = (SELECT MIN(id) FROM organizations)`);

  await run(`
    IF OBJECT_ID('platform_settings') IS NULL
    CREATE TABLE platform_settings (
      key_name   NVARCHAR(60)   NOT NULL PRIMARY KEY,
      value      NVARCHAR(1000) NULL,
      updated_at DATETIME2      NOT NULL CONSTRAINT DF_platform_settings_at DEFAULT SYSUTCDATETIME(),
      updated_by INT            NULL
    )`);

  await run(`
    IF OBJECT_ID('backup_jobs') IS NULL
    BEGIN
      CREATE TABLE backup_jobs (
        id         INT IDENTITY(1,1) PRIMARY KEY,
        name       NVARCHAR(60)  NOT NULL,
        kind       NVARCHAR(10)  NOT NULL CONSTRAINT CK_backup_jobs_kind CHECK (kind IN ('full', 'log', 'drill', 'pitr', 'prune')),
        cron_expr  NVARCHAR(60)  NOT NULL,
        enabled    BIT           NOT NULL CONSTRAINT DF_backup_jobs_enabled DEFAULT 1,
        created_at DATETIME2     NOT NULL CONSTRAINT DF_backup_jobs_created DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2     NOT NULL CONSTRAINT DF_backup_jobs_updated DEFAULT SYSUTCDATETIME(),
        updated_by INT           NULL
      );
      INSERT INTO backup_jobs (name, kind, cron_expr) VALUES
        (N'Nightly full backup',          'full',  '0 2 * * *'),
        (N'Transaction log backup',       'log',   '*/30 * * * *'),
        (N'Weekly restore drill',         'drill', '30 3 * * 0'),
        (N'Weekly point-in-time drill',   'pitr',  '0 4 * * 0'),
        (N'Prune old backup files',       'prune', '0 5 * * *');
    END`);

  await run(`IF COL_LENGTH('backup_runs', 'job_id') IS NULL ALTER TABLE backup_runs ADD job_id INT NULL`);
  await run(`IF COL_LENGTH('backup_runs', 'source') IS NULL ALTER TABLE backup_runs ADD source NVARCHAR(10) NOT NULL CONSTRAINT DF_backup_runs_source DEFAULT 'cli'`);

  // The master switch starts from the existing BACKUP_JOB environment setting; once saved from the console the database value wins.
  await run(`
    IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key_name = 'backup_enabled')
      INSERT INTO platform_settings (key_name, value) VALUES ('backup_enabled', '${String(process.env.BACKUP_JOB || '').toLowerCase() === 'on' ? 'on' : 'off'}')`);
};
