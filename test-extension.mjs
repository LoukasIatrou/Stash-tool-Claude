import { chromium } from 'playwright-core';

const CDP_URL = 'http://localhost:9222';

let browser;
try {
  browser = await chromium.connectOverCDP(CDP_URL);
} catch {
  console.error('Could not connect to Edge on port 9222.');
  console.error('Launch Edge with the debug port first:\n');
  console.error('  & "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=9222 --no-first-run\n');
  process.exit(1);
}

const [defaultCtx] = browser.contexts();
const allPages = defaultCtx.pages();
const page = allPages.find(p => p.url().includes('claude.ai')) ?? allPages[0];

if (!page) {
  console.error('No open tabs found. Navigate to claude.ai in Edge and try again.');
  await browser.close();
  process.exit(1);
}

console.log(`Attached to: ${page.url()}\n`);

const errors = [];
const warnings = [];
const logs = [];

page.on('console', msg => {
  const entry = { type: msg.type(), text: msg.text(), location: msg.location() };
  if (msg.type() === 'error') errors.push(entry);
  else if (msg.type() === 'warning') warnings.push(entry);
  else logs.push(entry);
});

page.on('pageerror', err => {
  errors.push({ type: 'pageerror', text: err.message, stack: err.stack });
});

await page.waitForTimeout(500);
console.log('Triggering page refresh...');
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);

// ---- Report ----
console.log('\n========== CONSOLE ERRORS ==========');
if (errors.length === 0) {
  console.log('No errors.');
} else {
  errors.forEach((e, i) => {
    console.log(`\n[${i + 1}] ${e.type.toUpperCase()}: ${e.text}`);
    if (e.location?.url) console.log(`    at ${e.location.url}:${e.location.lineNumber}`);
    if (e.stack) console.log(e.stack);
  });
}

console.log('\n========== WARNINGS ==========');
if (warnings.length === 0) {
  console.log('No warnings.');
} else {
  warnings.forEach((w, i) => console.log(`[${i + 1}] ${w.text}`));
}

console.log('\n========== SUMMARY ==========');
console.log(`Errors:   ${errors.length}`);
console.log(`Warnings: ${warnings.length}`);
console.log(`Logs:     ${logs.length}`);

await browser.close();
