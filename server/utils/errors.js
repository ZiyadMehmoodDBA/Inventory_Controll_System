// One place that turns any error into an HTTP response, so every route answers the same way:
//   { error: <message the user may read>, code: <stable machine code>, ...details }
// Known errors keep their own message and status; anything unexpected is logged here and answered with a generic 500 (no internals leak).

/** An error a route throws on purpose: carries its HTTP status and a stable code. */
class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Request body or query failed validation. `fields` maps a field name to what is wrong with it. */
class ValidationError extends AppError {
  constructor(message, fields = {}) {
    super(message, 400, 'VALIDATION_FAILED', { fields });
    this.name = 'ValidationError';
  }
}

const DUPLICATE_KEY = new Set([2601, 2627]);      // unique index / unique constraint
const DEADLOCK = 1205;                            // chosen as a deadlock victim: the caller may simply retry
const CONSTRAINT = new Set([547]);                // CHECK or FOREIGN KEY violation
const LEDGER_GUARD = 51000;                       // raised by the append-only triggers (migration 0001)

/** { status, body } for an error, without sending anything. */
function describe(err) {
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 600 && err.code) {
    return { status: err.status, body: { error: err.message, code: err.code, ...(err.details && typeof err.details === 'object' ? err.details : {}) } };
  }
  const n = err && (err.number ?? err.originalError?.info?.number);
  if (DUPLICATE_KEY.has(n)) return { status: 409, body: { error: 'This record already exists', code: 'DUPLICATE' } };
  if (n === DEADLOCK) return { status: 409, body: { error: 'The system was busy with another change to the same stock. Please try again.', code: 'CONFLICT_RETRY' } };
  if (n === LEDGER_GUARD || (err && /append-only/i.test(err.message || ''))) return { status: 409, body: { error: 'This history is append-only and cannot be changed or removed', code: 'IMMUTABLE' } };
  if (CONSTRAINT.has(n)) return { status: 409, body: { error: 'The change breaks a data rule and was not saved', code: 'CONSTRAINT_VIOLATION' } };
  if (err && err.type === 'entity.parse.failed') return { status: 400, body: { error: 'The request body is not valid JSON', code: 'INVALID_JSON' } };
  if (err && err.type === 'entity.too.large') return { status: 413, body: { error: 'The request is too large', code: 'PAYLOAD_TOO_LARGE' } };
  return null;
}

/** Send the response for `err`. Unknown errors are logged with `scope` and answered with a generic 500. */
function handleError(res, err, scope = 'api') {
  const known = describe(err);
  if (known) return res.status(known.status).json(known.body);
  console.error(`[${scope}]`, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  return res.status(500).json({ error: 'An internal error occurred', code: 'INTERNAL' });
}

/** Express error middleware (must be registered last). */
function errorMiddleware(err, req, res, next) {      // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  return handleError(res, err, 'api');
}

module.exports = { AppError, ValidationError, describe, handleError, errorMiddleware };
