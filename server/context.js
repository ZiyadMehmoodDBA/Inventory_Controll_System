// Extracts organization_id and branch_id from the verified JWT payload (req.user),
// set by requireAuth middleware. The X-Branch-ID header is used only as a hint
// for org_admin users (branch_id = null) who can operate across branches.
function getContext(req) {
  const orgId = req.user.orgId;

  // org_admin has branch_id = null in the token; let the client pick a branch
  // within their org via X-Branch-ID header.
  const branchId = req.user.branchId != null
    ? req.user.branchId
    : (parseInt(req.headers['x-branch-id'], 10) || 1);

  return { orgId, branchId };
}

module.exports = { getContext };
