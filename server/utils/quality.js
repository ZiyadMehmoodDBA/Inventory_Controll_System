// Product quality: batch quality status, shelf-life / inspection rules and the SQL that resolves them.
//   Effective rule for an item = its own value > its quality profile > its category's profile > company default.
//   (A profile field left empty inherits; an inspection interval of 0 on the item switches inspection off for it.)
// Standalone on purpose (no imports from stock.js) so the ledger can use the fragments without a circular require.
const QUALITY_STATUSES = {
  released: 'Released',
  on_hold:  'On quality hold',
  recalled: 'Recalled',
  damaged:  'Damaged',
};
const isRestricted = status => !!status && status !== 'released';

const DISPOSAL_METHODS = {
  destroy:            'Destroyed / disposed',
  return_to_supplier: 'Returned to supplier',
  write_off:          'Written off',
};
const RECALL_SEVERITIES = { class1: 'Class I (serious health risk)', class2: 'Class II (temporary or reversible risk)', class3: 'Class III (unlikely to cause harm)', voluntary: 'Voluntary / quality' };

// Company defaults live in the settings table as qa_<name>.
const COMPANY_KEYS = ['near_expiry_days', 'inspection_interval_days', 'min_remaining_days', 'require_mfg_date', 'release_approval', 'stale_hold_days', 'disposal_admin_value'];
const DEFAULT_NEAR_EXPIRY = 30, DEFAULT_STALE_HOLD = 14;

/** Joins for a query over `tires t`: the item's profile (ip) and its category's profile (cp). */
const QA_JOINS = `
  LEFT JOIN quality_profiles ip ON ip.id = t.quality_profile_id AND ip.organization_id = t.organization_id
  LEFT JOIN item_categories qc ON qc.id = t.category_id
  LEFT JOIN quality_profiles cp ON cp.id = qc.quality_profile_id AND cp.organization_id = t.organization_id`;

const company = k => `(SELECT TOP 1 value FROM settings WHERE organization_id = t.organization_id AND [key] = 'qa_${k}')`;
const QA_COLUMNS = `
  COALESCE(t.near_expiry_days, ip.near_expiry_days, cp.near_expiry_days, TRY_CAST(${company('near_expiry_days')} AS INT), ${DEFAULT_NEAR_EXPIRY}) AS eff_near_expiry_days,
  COALESCE(t.inspection_interval_days, ip.inspection_interval_days, cp.inspection_interval_days, TRY_CAST(${company('inspection_interval_days')} AS INT)) AS eff_inspection_days,
  COALESCE(t.min_remaining_days, ip.min_remaining_days, cp.min_remaining_days, TRY_CAST(${company('min_remaining_days')} AS INT)) AS eff_min_remaining_days,
  COALESCE(t.require_mfg_date, ip.require_mfg_date, cp.require_mfg_date, TRY_CAST(${company('require_mfg_date')} AS BIT), 0) AS eff_require_mfg,
  COALESCE(ip.release_approval, cp.release_approval, ${company('release_approval')}, 'manager') AS eff_release_approval`;

module.exports = { QUALITY_STATUSES, DISPOSAL_METHODS, RECALL_SEVERITIES, isRestricted, COMPANY_KEYS, DEFAULT_NEAR_EXPIRY, DEFAULT_STALE_HOLD, QA_JOINS, QA_COLUMNS };
