import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { findChrome, tmpChromeDir } from './paths.mjs';

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${url}`));
    });
  });
}

export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 200, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function launchChrome({ runId, debugPort }) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error('Chrome/Chromium not found. Set CHROME_PATH or use the Cursor computerUse browser with the same ARIA handles.');
  }
  const userDataDir = tmpChromeDir(runId);
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,800',
    'about:blank',
  ];
  const child = spawn(chrome, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const version = await waitFor(async () => {
    try { return await requestJson(`http://127.0.0.1:${debugPort}/json/version`); } catch { return null; }
  }, { timeoutMs: 20000, label: 'chrome DevTools' });
  const page = await waitFor(async () => {
    try {
      const list = await requestJson(`http://127.0.0.1:${debugPort}/json/list`);
      if (!Array.isArray(list)) return null;
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    } catch { return null; }
  }, { timeoutMs: 15000, label: 'chrome page target' });
  const wsUrl = page.webSocketDebuggerUrl || version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('Chrome DevTools page websocket missing');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome websocket open timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); }, { once: true });
  });
  const cdp = new CdpSession(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Accessibility.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { cdp, chromePid: child.pid, userDataDir, debugPort, chromePath: chrome };
}

const FINDER = `({ role, name, placeholder, textIncludes }) => {
  const visible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const accName = (el) => {
    const labelled = el.getAttribute('aria-label');
    if (labelled) return labelled.trim();
    return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'nav') return 'navigation';
    if (tag === 'input' || tag === 'textarea') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
    return tag;
  };
  const nodes = [...document.querySelectorAll('button, a, input, textarea, [role], h1, h2, h3, nav, [aria-label]')];
  for (const el of nodes) {
    if (!visible(el)) continue;
    const elRole = roleOf(el);
    const elName = accName(el);
    if (placeholder && el.getAttribute('placeholder') === placeholder) return el;
    if (role && elRole !== role) continue;
    if (name && elName === name) return el;
    if (textIncludes && elName.includes(textIncludes)) return el;
    if (!name && !textIncludes && !placeholder && role && elRole === role) return el;
  }
  return null;
}`;

export async function clickHandle(cdp, handle) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(${FINDER})(${JSON.stringify(handle)})`,
    returnByValue: false,
  });
  if (!result.result || result.result.subtype === 'null' || result.result.type === 'undefined') {
    throw new Error(`no visible control matching ${JSON.stringify(handle)}`);
  }
  await cdp.send('Runtime.callFunctionOn', {
    objectId: result.result.objectId,
    functionDeclaration: `function () { this.focus(); this.click(); }`,
  });
}

export async function fillHandle(cdp, handle, value) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(${FINDER})(${JSON.stringify(handle)})`,
    returnByValue: false,
  });
  if (!result.result || result.result.subtype === 'null') {
    throw new Error(`no field matching ${JSON.stringify(handle)}`);
  }
  await cdp.send('Runtime.callFunctionOn', {
    objectId: result.result.objectId,
    functionDeclaration: `function (value) {
      this.focus();
      const proto = this.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(this, value) : (this.value = value);
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    arguments: [{ value }],
  });
}

export async function pageText(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `document.body ? document.body.innerText : ''`,
    returnByValue: true,
  });
  return result.result?.value || '';
}

export async function waitForText(cdp, snippet, timeoutMs = 30000) {
  await waitFor(async () => {
    const text = await pageText(cdp);
    return text.includes(snippet) ? text : null;
  }, { timeoutMs, label: `text ${JSON.stringify(snippet)}` });
}

export async function screenshotPng(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
}

function flattenAx(nodes) {
  const byId = new Map((nodes || []).map((n) => [n.nodeId, n]));
  const lines = [];
  const walk = (node, depth) => {
    if (!node) return;
    const ignored = node.ignored ? ' ignored' : '';
    const name = node.name?.value ? ` name="${node.name.value.replace(/"/g, '\\"')}"` : '';
    const role = node.role?.value || 'unknown';
    lines.push(`${'  '.repeat(depth)}${role}${name}${ignored}`);
    for (const childId of node.childIds || []) walk(byId.get(childId), depth + 1);
  };
  const roots = (nodes || []).filter((n) => !n.parentId);
  for (const root of roots) walk(root, 0);
  return lines.join('\n');
}

export async function ariaDump(cdp) {
  const tree = await cdp.send('Accessibility.getFullAXTree');
  return flattenAx(tree.nodes);
}

export async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(async () => {
    const ready = await cdp.send('Runtime.evaluate', {
      expression: `document.readyState === 'interactive' || document.readyState === 'complete'`,
      returnByValue: true,
    });
    return ready.result?.value ? true : null;
  }, { timeoutMs: 30000, label: `navigate ${url}` });
}
