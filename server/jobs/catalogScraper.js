'use strict';
/**
 * Catalog Scraper Job — schedules periodic catalog updates via node-cron.
 * Call initCatalogScraperJob() once after the DB is ready.
 * Call rescheduleJob(enabled, scheduleKey) whenever settings change.
 */

const cron                      = require('node-cron');
const { runScraper }            = require('../scraper/scraperService');
const { getPool, sql }          = require('../db');
const { isModuleEnabled }       = require('../utils/businessTypes');

/* ─── Schedule options ────────────────────────────────────────────────────── */
const SCHEDULE_OPTIONS = {
  every_6h:  { cron: '0 */6 * * *',  label: 'Every 6 Hours'       },
  every_12h: { cron: '0 */12 * * *', label: 'Every 12 Hours'      },
  daily_2am: { cron: '0 2 * * *',    label: 'Daily at 2 AM'       },
  daily_6am: { cron: '0 6 * * *',    label: 'Daily at 6 AM'       },
  weekly:    { cron: '0 2 * * 0',    label: 'Weekly (Sunday 2 AM)' },
  manual:    { cron: null,            label: 'Manual Only'          },
};

/* ─── In-process state ────────────────────────────────────────────────────── */
let currentTask = null;   // node-cron ScheduledTask
let isRunning   = false;  // guard against concurrent runs

/* ─── Execute the scrape (called by cron or manually) ────────────────────── */
async function executeJob() {
  if (isRunning) {
    console.log('[CatalogJob] Already running — skipped');
    return;
  }
  isRunning = true;
  try {
    // The scraper config lives on org 1; skip scheduled runs unless that business uses the tyre catalog.
    if (!(await isModuleEnabled(1, 'tyreCatalog'))) {
      console.log('[CatalogJob] Tyre catalog module disabled — skipped');
      return;
    }
    await runScraper('gtr', 'schedule');
  } catch (err) {
    console.error('[CatalogJob] Job error:', err.message);
  } finally {
    isRunning = false;
  }
}

/* ─── Stop the current schedule ──────────────────────────────────────────── */
function stopCurrentTask() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    console.log('[CatalogJob] Schedule stopped');
  }
}

/* ─── Start a new schedule ───────────────────────────────────────────────── */
function startSchedule(scheduleKey) {
  stopCurrentTask();
  const opt = SCHEDULE_OPTIONS[scheduleKey] || SCHEDULE_OPTIONS.manual;
  if (!opt.cron) {
    console.log('[CatalogJob] Manual-only mode — no cron schedule');
    return;
  }
  if (!cron.validate(opt.cron)) {
    console.warn('[CatalogJob] Invalid cron expression:', opt.cron);
    return;
  }
  currentTask = cron.schedule(opt.cron, executeJob, {
    scheduled: true,
    timezone:  'Asia/Karachi',
  });
  console.log(`[CatalogJob] Scheduled — ${opt.label} (${opt.cron})`);
}

/* ─── Read config from settings table ────────────────────────────────────── */
async function getScraperConfig() {
  try {
    const pool   = await getPool();
    const result = await pool.request().query(`
      SELECT [key], value FROM settings
      WHERE [key] IN ('scraper_enabled', 'scraper_schedule')
        AND organization_id = 1
    `);
    const map = {};
    for (const row of result.recordset) map[row.key] = row.value;
    return {
      enabled:  map.scraper_enabled  === '1',
      schedule: map.scraper_schedule || 'daily_2am',
    };
  } catch {
    return { enabled: false, schedule: 'daily_2am' };
  }
}

/* ─── Public API ──────────────────────────────────────────────────────────── */

/** Called once on server boot (after DB is ready). */
async function initCatalogScraperJob() {
  const { enabled, schedule } = await getScraperConfig();
  if (!enabled) {
    console.log('[CatalogJob] Disabled — no schedule started');
    return;
  }
  startSchedule(schedule);
}

/** Called when settings change (from the catalog config API route). */
function rescheduleJob(enabled, scheduleKey) {
  if (!enabled) {
    stopCurrentTask();
    return;
  }
  startSchedule(scheduleKey);
}

/** Used by the status API to report live job state. */
function getJobStatus() {
  return {
    isRunning,
    isScheduled: currentTask !== null,
  };
}

/** Trigger a manual run (fire-and-forget). */
async function triggerManualRun() {
  if (isRunning) return false;
  isRunning = true;
  runScraper('gtr', 'manual')
    .catch(err => console.error('[CatalogJob] Manual run error:', err.message))
    .finally(() => { isRunning = false; });
  return true;
}

module.exports = {
  initCatalogScraperJob,
  rescheduleJob,
  getJobStatus,
  triggerManualRun,
  SCHEDULE_OPTIONS,
};
