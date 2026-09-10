import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SKILL_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SKILL_DIR, '../../..');
export const RUN_DIR = path.join(SKILL_DIR, '.run');
export const STATE_PATH = path.join(RUN_DIR, 'state.json');
export const EVIDENCE_DIR = path.join(SKILL_DIR, 'evidence');
export const LAST_RUN_PATH = path.join(EVIDENCE_DIR, 'LAST_RUN.txt');

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_VITE_PORT = 5173;
export const DEFAULT_API_PORT = 8080;

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

export function writeState(state) {
  ensureDir(RUN_DIR);
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function loadDotenv(filePath = path.join(REPO_ROOT, '.env')) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function childEnv(overrides = {}) {
  const fromFile = loadDotenv();
  return {
    ...process.env,
    ...fromFile,
    ...overrides,
  };
}

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function tmpChromeDir(runId) {
  return path.join(os.tmpdir(), `dota2-ai-verify-chrome-${runId}`);
}
