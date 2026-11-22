#!/usr/bin/env node
/**
 * One-time interactive login for one Steam account. Asks for the login name,
 * the password (not echoed) and the Steam Guard code, then stores only the
 * refresh token Steam issues (about 200 days, renewed by the server while it
 * runs). Name and password are used for this login and kept nowhere.
 *
 *   STEAM_DATA_DIR=./data npm run login
 *
 * Use a spare account, never your main one.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import SteamUser from 'steam-user';
import { LABEL, readTokens, tokenExpiry, writeToken } from './src/tokens.mjs';

if (!process.stdin.isTTY) { console.error('Run this in an interactive terminal (docker: add -it).'); process.exit(1); }
const dataDir = resolve(process.env.STEAM_DATA_DIR || './data');
// Everything readline echoes goes through this stream, so it can be silenced
// while a password is typed.
let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = createInterface({ input: process.stdin, output: out, terminal: true });
const ask = (q, { secret = false } = {}) => new Promise((done) => {
  process.stdout.write(q);
  muted = secret;
  rl.question('', (answer) => { if (secret) process.stdout.write('\n'); muted = false; done(answer.trim()); });
});

const taken = new Set(readTokens(dataDir).map((a) => a.label));
let n = 1; while (taken.has(`acct-${n}`)) n += 1;
const label = (await ask(`Label for this account, shown in logs (not the login name) [acct-${n}]: `)) || `acct-${n}`;
if (!LABEL.test(label)) { console.error('Label: lowercase letters, digits, - or _ (max 32).'); process.exit(1); }
if (taken.has(label)) console.log(`"${label}" exists and will be replaced.`);
const accountName = await ask('Steam login name: ');
const password = await ask('Steam password: ', { secret: true });
if (!accountName || !password) { console.error('Login name and password are both needed.'); process.exit(1); }

const client = new SteamUser({ dataDirectory: join(dataDir, 'steam'), autoRelogin: false });
let saved = false;
client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
  if (lastCodeWrong) console.log('That code was not accepted. Wait for a new one.');
  callback(await ask(domain ? `Steam Guard code sent to your email (…@${domain}): ` : 'Steam Guard code from the mobile app: '));
});
client.on('refreshToken', (token) => {
  writeToken(dataDir, label, token);
  saved = true;
  const exp = tokenExpiry(token);
  console.log(`Saved ${join(dataDir, 'tokens', `${label}.token`)}${exp ? ` (valid until ${new Date(exp).toISOString().slice(0, 10)})` : ''}.`);
});
client.on('loggedOn', () => {
  console.log(saved ? 'Logged on. Done: start the server with "npm start".' : 'Logged on, but Steam issued no refresh token. Nothing was saved.');
  client.logOff();
  rl.close();
  setTimeout(() => process.exit(saved ? 0 : 1), 500);
});
client.on('error', (err) => {
  console.error(`Login failed: ${SteamUser.EResult[err?.eresult] ?? 'error'}`);
  rl.close();
  process.exit(1);
});
client.logOn({ accountName, password });
