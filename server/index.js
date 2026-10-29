const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { setupDatabase } = require('./db');
const { requireAuth } = require('./middleware/auth');
const { attachAccess } = require('./utils/permissions');
const { validateBranchContext } = require('./middleware/validateBranchContext');
const { blockDemo } = require('./middleware/demo');
const { errorMiddleware } = require('./utils/errors');
const { requireModule } = require('./utils/businessTypes');
const { duplicateGuard } = require('./middleware/duplicateGuard');
const { initCatalogScraperJob } = require('./jobs/catalogScraper');
const { initDemoCleanupJob }    = require('./jobs/demoCleanup');
const { initBackupJob }         = require('./jobs/backupJob');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  contentSecurityPolicy: false, // API-only server; browser CSP is on the frontend
}));

// ── CORS — only allow the Vite dev server ─────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Org-ID', 'X-Branch-ID', 'Authorization'],
}));

// ── Body parsing — cap at 500 KB to block oversized payloads ─────────────────
app.use(express.json({ limit: '500kb' }));

// ── General API rate limit (loose — protects against scraping/flooding) ──────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api', generalLimiter);

// ── Auth guard — all /api routes except /auth/* and /health ──────────────────
// Fitment and catalog routes need a logged-in user so the business-type module check can run.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth') || req.path === '/health') return next();
  requireAuth(req, res, err => (err ? next(err) : attachAccess(req, res, next)));
});

// ── Branch context validation — org_admin X-Branch-ID header sanity check ────
// Ensures org_admins cannot target branches from other organisations.
app.use('/api', validateBranchContext);

// ── Demo role guard ───────────────────────────────────────────────────────────
// Block demo users from ALL destructive / administrative mutations.
// Demo users may GET anything and POST to create-only routes (sandboxed).
// Transactional data created by demo users is reset every 30 min by demoCleanup.
const DEMO_BLOCKED_PATHS = [
  /\/void$/,            // POST /sales/:id/void
  /\/status$/,          // PATCH /sales|purchases/:id/status
  /\/password$/,        // PATCH /users/:id/password
  /\/import-catalog$/,  // POST /inventory/import-catalog
  /\/scraper\//,        // POST /catalog/scraper/*
];
const DEMO_ALLOWED_POST_PREFIXES = [
  '/customers', '/suppliers', '/inventory', '/sales', '/purchases',
  '/products', '/payments', '/ledger', '/reports',
];

app.use('/api', (req, res, next) => {
  if (req.user?.role !== 'demo') return next();
  if (req.method === 'GET') return next();

  // Block specific mutation sub-paths regardless of method
  if (DEMO_BLOCKED_PATHS.some(p => p.test(req.path))) {
    return blockDemo(req, res, next);
  }

  // Allow sandboxed creates on whitelisted route prefixes
  if (req.method === 'POST' && DEMO_ALLOWED_POST_PREFIXES.some(p => req.path.startsWith(p))) {
    return next();
  }

  // Block everything else (DELETE, PUT, PATCH, admin POSTs)
  return blockDemo(req, res, next);
});

// ── Duplicate-submission guard for transaction-creating POSTs (after auth so req.user exists) ──
app.use('/api/sales',     duplicateGuard());
app.use('/api/purchases', duplicateGuard());
app.use('/api/inventory', duplicateGuard(/^\/(bulk|adjustments|transfers|reservations|counts)?$/));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/inventory', require('./routes/stock'));      // ledger, adjustments, reconciliation (falls through)
app.use('/api/inventory', require('./routes/stockControl')); // position, reservations, counts, in-transit
app.use('/api/inventory', require('./routes/insights'));        // dashboard + standard reports (read-only)
app.use('/api/inventory', require('./routes/warehouse'));       // warehouses, location access, network stock view, in-transit board
app.use('/api/inventory', require('./routes/losses'));          // waste, damage & obsolete stock: loss reports, supplier returns, patterns
app.use('/api/inventory', require('./routes/hazmat'));          // hazard classes, segregation, permitted locations, inspections, incidents
app.use('/api/inventory', require('./routes/quality'));         // quality status, recalls, inspections, disposals, alerts
app.use('/api/inventory', require('./routes/replenishment')); // reorder points, recommendations, approvals -> POs
app.use('/api/inventory', require('./routes/rotation'));     // rotation policies, pick guide, stock age, valuation records
app.use('/api/inventory', require('./routes/itemMaster')); // categories + barcode lookup (before /:id)
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/sales',     require('./routes/sales'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/settings',  require('./routes/settings'));
app.use('/api/lookups',   require('./routes/lookups'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/payments',      require('./routes/payments'));
app.use('/api/ledger',        require('./routes/ledger'));
app.use('/api/organizations', require('./routes/organizations'));
app.use('/api/branches',      require('./routes/branches'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/access',        require('./routes/access'));
app.use('/api/audit',         require('./routes/audit'));
app.use('/api/profile',       require('./routes/profile'));
app.use('/api/catalog',       requireModule('tyreCatalog'), require('./routes/catalog'));
app.use('/api/fitments',      requireModule('tyreFitment'), require('./routes/fitments'));
app.use('/api/reports',       require('./routes/reports'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Global error handler ──────────────────────────────────────────────────────
// One shape for every error: { error, code }. Known errors keep their status; unexpected ones are logged and answered generically.
app.use(errorMiddleware);

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await setupDatabase();
    await initCatalogScraperJob();
    initDemoCleanupJob();
    initBackupJob();
    app.listen(PORT, () => {
      console.log(`🚀 TuneGEN API running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
})();
