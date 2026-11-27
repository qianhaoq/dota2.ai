/**
 * Express 4 async route wrapper and final error handler.
 *
 * Express 4 does not catch rejected promises returned by `async` handlers,
 * turning unexpected rejections into process-crashing `unhandledRejection`s.
 * Wrapping every `async` route with `asyncHandler` forwards rejections to
 * Express's error pipeline, where `internalErrorHandler` logs a minimal,
 * non-sensitive summary and responds with a generic JSON 500.
 */

/**
 * @template {import('express').RequestHandler} T
 * @param {T} fn
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Final 4-argument Express error middleware. Never returns `err.message` or
 * stack traces to clients.
 * @param {{ log?: (msg: string) => void }} [options]
 */
export function internalErrorHandler({ log = (msg) => console.error(msg) } = {}) {
  return (err, req, res, _next) => {
    const kind = err?.name && typeof err.name === 'string' ? err.name : 'Error';
    log(`[express] unhandled error ${req?.method ?? ''} ${req?.path ?? ''}: ${kind}`);
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json({ code: 'internal_error', error: 'Internal Server Error' });
  };
}
