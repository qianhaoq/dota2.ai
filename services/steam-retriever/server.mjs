#!/usr/bin/env node
/**
 * dota2.ai Steam retriever. Configuration (environment only):
 *   STEAM_RETRIEVER_SECRET  required, 24+ chars: the Bearer token callers send
 *   STEAM_DATA_DIR          default ./data: refresh tokens, quota counters
 *   PORT / HOST             default 5700 / 0.0.0.0
 *   MAX_MATCHES_PER_ACCOUNT_DAY (95) · MAX_MATCHES_PER_IP_DAY (480)
 *   MAX_HISTORY_PER_ACCOUNT_DAY (300) · GC_TIMEOUT_MS (6000)
 *   ENABLE_GC_HISTORY=1     turn /history on (the GC only answers for the logged-in account)
 * Accounts are added with `npm run login`, never through the environment.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRetrieverApp } from './src/app.mjs';
import { createDailyQuota } from './src/quota.mjs';
import { createSteamPool } from './src/steamPool.mjs';
import { readTokens, tokenExpiry, writeToken } from './src/tokens.mjs';

const log = (line) => console.log(`${new Date().toISOString()} [retriever] ${line}`);
function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) { console.error(`${name} must be a positive integer`); process.exit(1); }
  return n;
}

const secret = process.env.STEAM_RETRIEVER_SECRET ?? '';
if (secret.length < 24) {
  // Fail closed: never serve GC data without a secret.
  console.error('STEAM_RETRIEVER_SECRET is not set or shorter than 24 characters. Refusing to start.');
  process.exit(1);
}
const dataDir = resolve(process.env.STEAM_DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const accounts = readTokens(dataDir);
if (accounts.length === 0) {
  console.error(`No accounts in ${join(dataDir, 'tokens')}. Add one with: npm run login`);
  process.exit(1);
}
for (const a of accounts) {
  const exp = tokenExpiry(a.refreshToken);
  const days = exp == null ? null : Math.floor((exp - Date.now()) / 86_400_000);
  if (days != null && days < 14) log(`${a.label}: stored token ${days < 0 ? 'has expired' : `expires in ${days} day(s)`}; run "npm run login" for it`);
}

const quotaFile = join(dataDir, 'quota.json');
const quota = createDailyQuota({
  matchPerAccount: positiveInt('MAX_MATCHES_PER_ACCOUNT_DAY', 95),
  matchPerIp: positiveInt('MAX_MATCHES_PER_IP_DAY', 480),
  historyPerAccount: positiveInt('MAX_HISTORY_PER_ACCOUNT_DAY', 300),
  load: () => JSON.parse(readFileSync(quotaFile, 'utf8')),
  save: (state) => { writeFileSync(`${quotaFile}.tmp`, JSON.stringify(state), { mode: 0o600 }); renameSync(`${quotaFile}.tmp`, quotaFile); },
});

const gc = createSteamPool({ accounts, dataDir: join(dataDir, 'steam'), onRefreshToken: (label, token) => writeToken(dataDir, label, token), log });
const app = createRetrieverApp({ secret, gc, quota, log, gcTimeoutMs: positiveInt('GC_TIMEOUT_MS', 6000), historyEnabled: process.env.ENABLE_GC_HISTORY === '1' });

const port = positiveInt('PORT', 5700);
const host = process.env.HOST || '0.0.0.0';
const server = createServer(app);
server.requestTimeout = 30_000;
server.listen(port, host, () => log(`listening on ${host}:${port} with ${accounts.length} account(s)`));
const report = setInterval(() => log(`accounts ${JSON.stringify(gc.states())}, today ${JSON.stringify(quota.snapshot(gc.size()))}`), 10 * 60_000);
report.unref();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    gc.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
