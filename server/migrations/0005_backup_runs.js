// Evidence of backups and recovery drills: one row per run, success or failure.
exports.description = 'backup_runs: log of backups, restore drills and point-in-time drills';

exports.up = async (tx, sql) => {
  await new sql.Request(tx).batch(`
    IF OBJECT_ID('backup_runs') IS NULL
    CREATE TABLE backup_runs (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      kind        NVARCHAR(30)  NOT NULL,            -- full | log | drill | pitr
      started_at  DATETIME2     NOT NULL,
      finished_at DATETIME2     NOT NULL,
      ok          BIT           NOT NULL,
      [file]      NVARCHAR(500) NULL,
      message     NVARCHAR(MAX) NULL
    )`);
};
