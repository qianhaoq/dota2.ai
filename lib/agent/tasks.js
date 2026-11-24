/**
 * Queued work for the review agent, on Cloud Tasks.
 *
 * A parse or a deep review takes minutes. Started as a background job of the
 * instance that answered the click, it dies when that instance does (every
 * deploy replaces it), and outside a request Cloud Run gives it almost no CPU.
 * Handed to a queue instead, the work arrives back as a request of its own
 * (POST /internal/agent/run) and runs inside it: Cloud Run lets a request that
 * is being processed finish when traffic moves to a new revision, the CPU
 * stays allocated for as long as it runs, the reader may close the page, and
 * a request that fails is delivered again.
 *
 * - `createTaskDispatcher` puts a task on the queue (the instance's own
 *   service account, through the metadata server; no client library).
 * - `createTaskAuth` checks that a request to the run route is such a task:
 *   the service is public, so the route trusts only Google's ID token for the
 *   expected service account and audience.
 */
const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
export const RUN_PATH = '/internal/agent/run';

/**
 * @param {{ queue: string, url: string, serviceAccount: string, fetchImpl?: typeof fetch, deadlineSec?: number }} o
 *   queue: `projects/<p>/locations/<l>/queues/<q>`; url: this service's own https origin (also the token's audience);
 *   deadlineSec: how long Cloud Tasks waits for the run to answer (its maximum is 30 minutes).
 * @returns {(job: object) => Promise<void>} rejects when the task could not be queued
 */
export function createTaskDispatcher({ queue, url, serviceAccount, fetchImpl = fetch, deadlineSec = 1800 }) {
  const base = String(url).replace(/\/+$/, '');
  return async function dispatch(job) {
    const tok = await fetchImpl(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
    if (!tok.ok) throw new Error('tasks_identity_failed');
    const access = (await tok.json())?.access_token;
    if (!access) throw new Error('tasks_identity_failed');
    const res = await fetchImpl(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: {
        dispatchDeadline: `${deadlineSec}s`,
        httpRequest: {
          url: `${base}${RUN_PATH}`, httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(job)).toString('base64'),
          oidcToken: { serviceAccountEmail: serviceAccount, audience: base },
        },
      } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error('tasks_enqueue_failed'), { code: res.status });
  };
}

/**
 * @param {{ audience: string, serviceAccount: string, fetchImpl?: typeof fetch, now?: () => number }} o
 * @returns {(req: { headers?: Record<string, any> }) => Promise<boolean>} true only for Google's ID token, issued
 *   to `serviceAccount` for `audience` and not expired. Anything unreadable is a no.
 */
export function createTaskAuth({ audience, serviceAccount, fetchImpl = fetch, now = () => Date.now() }) {
  const aud = String(audience).replace(/\/+$/, '');
  return async function allowed(req) {
    const m = /^Bearer ([\w.-]+)$/.exec(String(req?.headers?.authorization ?? ''));
    if (!m) return false;
    try {
      // Google checks the signature; what is left to check here is who the token is for and from.
      const res = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(m[1])}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const c = await res.json();
      return c?.aud === aud && c.email === serviceAccount && String(c.email_verified) === 'true'
        && ISSUERS.has(c.iss) && Number(c.exp) * 1000 > now();
    } catch { return false; }
  };
}
