// Data classification, role access and resource limits. Enforced in code, never by prompt.
const CLASSIFICATIONS = {
  internal:               'Internal - routine operational statistics',
  confidential_financial: 'Confidential financial - prices, costs, revenue, balances, supplier terms',
  personal_regulated:     'Personal and regulated - personal, employee or patient data (not exposed by built-in reports)',
};

// Which classifications each role may query. Unknown roles get nothing.
const ROLE_ACCESS = {
  org_admin:      ['internal', 'confidential_financial'],
  branch_manager: ['internal', 'confidential_financial'],
  demo:           ['internal', 'confidential_financial'],
  staff:          ['internal'],
};

const DEFAULT_POLICY = {
  row_limit: 500,
  timeout_ms: 15000,
  external_ai_approved: false,    // cloud providers blocked until org approves
  send_results_to_model: false,   // result rows never go to the LLM unless approved
  history_retention_days: 90,
};

function canAccess(role, classification) {
  return (ROLE_ACCESS[role] || []).includes(classification);
}

// Scope comes only from the verified JWT. Request bodies and headers are never trusted.
function scopeFromUser(user) {
  return {
    orgId: user.orgId,
    branchId: user.branchId ?? null,   // null = org_admin, all branches of own org
    userId: user.userId,
    role: user.role,
  };
}

module.exports = { CLASSIFICATIONS, ROLE_ACCESS, DEFAULT_POLICY, canAccess, scopeFromUser };
