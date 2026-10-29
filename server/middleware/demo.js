/**
 * Demo-role middleware
 *
 * blockDemo   — blocks any request from a demo user that isn't a safe read.
 *               Applied to destructive routes (DELETE, void, admin mutations).
 *
 * sandboxNote — purely informational; used for POST routes that allow
 *               demo creates (data gets cleaned up by demoCleanup cron).
 */

function blockDemo(req, res, next) {
  if (req.user?.role === 'demo') {
    return res.status(403).json({
      error: 'This action is not available in demo mode.',
      code:  'DEMO_BLOCKED',
    });
  }
  next();
}

module.exports = { blockDemo };
