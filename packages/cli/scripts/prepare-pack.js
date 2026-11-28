// npm does not bundle workspace symlinks. Stage the workspace as a real directory
// so npm's normal bundled-dependency traversal includes the review engine.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const destination = new URL('../node_modules/@dota2ai/review-engine/', import.meta.url);
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const entry of ['package.json', 'src', 'data']) {
  cpSync(new URL(`../../review-engine/${entry}`, import.meta.url), new URL(entry, destination), { recursive: true });
}

// The goal check runs the web page's own pure judge (lib/coach/goals.js and
// the knowledge table it reads), vendored so the tarball needs no checkout.
const vendor = new URL('../src/vendor/', import.meta.url);
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
for (const file of ['goals.js', 'knowledge.js']) {
  cpSync(new URL(`../../../lib/coach/${file}`, import.meta.url), new URL(file, vendor));
}
