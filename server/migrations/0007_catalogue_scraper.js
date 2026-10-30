// Business-aware catalogue scraper: per-organisation profile overrides, scrape jobs, raw extraction (kept apart from normalised records),
// and the normalised records a user reviews before anything reaches the product master.
exports.description = 'catalogue_profiles, catalogue_jobs, catalogue_raw, catalogue_records';

exports.up = async (tx, sql) => {
  const run = s => new sql.Request(tx).batch(s);

  await run(`
    IF OBJECT_ID('catalogue_profiles') IS NULL
    CREATE TABLE catalogue_profiles (
      organization_id INT           NOT NULL,
      business_type   NVARCHAR(30)  NOT NULL,
      config          NVARCHAR(MAX) NOT NULL,
      updated_by      INT           NULL,
      updated_at      DATETIME2     NOT NULL CONSTRAINT DF_cat_profiles_at DEFAULT SYSUTCDATETIME(),
      CONSTRAINT PK_catalogue_profiles PRIMARY KEY (organization_id, business_type)
    )`);

  await run(`
    IF OBJECT_ID('catalogue_jobs') IS NULL
    BEGIN
      CREATE TABLE catalogue_jobs (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        organization_id INT            NOT NULL,
        business_type   NVARCHAR(30)   NOT NULL,
        source_name     NVARCHAR(100)  NOT NULL,
        source_url      NVARCHAR(500)  NOT NULL,
        keywords        NVARCHAR(500)  NULL,
        category        NVARCHAR(100)  NULL,
        config          NVARCHAR(MAX)  NULL,
        status          NVARCHAR(12)   NOT NULL CONSTRAINT DF_cat_jobs_status DEFAULT 'queued'
                        CONSTRAINT CK_cat_jobs_status CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
        pages_fetched   INT            NOT NULL CONSTRAINT DF_cat_jobs_pages DEFAULT 0,
        found           INT            NOT NULL CONSTRAINT DF_cat_jobs_found DEFAULT 0,
        message         NVARCHAR(500)  NULL,
        created_by      INT            NULL,
        created_at      DATETIME2      NOT NULL CONSTRAINT DF_cat_jobs_created DEFAULT SYSUTCDATETIME(),
        started_at      DATETIME2      NULL,
        finished_at     DATETIME2      NULL
      );
      CREATE INDEX IX_catalogue_jobs_org ON catalogue_jobs (organization_id, id DESC);
    END`);

  // What the site returned, as found, with where and when. Normalised records point back here.
  await run(`
    IF OBJECT_ID('catalogue_raw') IS NULL
    BEGIN
      CREATE TABLE catalogue_raw (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        job_id          INT            NOT NULL,
        organization_id INT            NOT NULL,
        source_url      NVARCHAR(1000) NOT NULL,
        fetched_at      DATETIME2      NOT NULL CONSTRAINT DF_cat_raw_at DEFAULT SYSUTCDATETIME(),
        via             NVARCHAR(12)   NOT NULL,
        payload         NVARCHAR(MAX)  NOT NULL
      );
      CREATE INDEX IX_catalogue_raw_job ON catalogue_raw (job_id);
    END`);

  await run(`
    IF OBJECT_ID('catalogue_records') IS NULL
    BEGIN
      CREATE TABLE catalogue_records (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        job_id           INT            NOT NULL,
        organization_id  INT            NOT NULL,
        raw_id           INT            NULL,
        source_url       NVARCHAR(1000) NOT NULL,
        extracted_at     DATETIME2      NOT NULL CONSTRAINT DF_cat_rec_at DEFAULT SYSUTCDATETIME(),
        name             NVARCHAR(200)  NOT NULL,
        brand            NVARCHAR(80)   NULL,
        sku              NVARCHAR(60)   NULL,
        barcode          NVARCHAR(20)   NULL,
        oem              NVARCHAR(60)   NULL,
        category         NVARCHAR(100)  NULL,
        subcategory      NVARCHAR(100)  NULL,
        price            DECIMAL(18,2)  NULL,
        wholesale_price  DECIMAL(18,2)  NULL,
        currency         NVARCHAR(3)    NULL,
        unit             NVARCHAR(20)   NULL,
        pack_size        NVARCHAR(60)   NULL,
        image_url        NVARCHAR(500)  NULL,
        description      NVARCHAR(1500) NULL,
        attributes       NVARCHAR(MAX)  NULL,
        status           NVARCHAR(10)   NOT NULL CONSTRAINT DF_cat_rec_status DEFAULT 'pending'
                         CONSTRAINT CK_cat_rec_status CHECK (status IN ('pending', 'validated', 'duplicate', 'ignored', 'imported')),
        issues           NVARCHAR(500)  NULL,
        duplicate_item_id INT           NULL,
        duplicate_reason NVARCHAR(200)  NULL,
        edited           BIT            NOT NULL CONSTRAINT DF_cat_rec_edited DEFAULT 0,
        item_id          INT            NULL,
        imported_by      INT            NULL,
        imported_at      DATETIME2      NULL
      );
      CREATE INDEX IX_catalogue_records_job ON catalogue_records (job_id, status);
      CREATE INDEX IX_catalogue_records_org ON catalogue_records (organization_id);
    END`);
};
