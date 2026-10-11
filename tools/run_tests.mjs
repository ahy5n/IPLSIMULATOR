// Headless test runner for CI: opens tests/index.html and fails the job if any test fails.
// Usage: node tools/run_tests.mjs http://127.0.0.1:8765/tests/index.html
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8765/tests/index.html';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url);
const res = await page.waitForFunction(() => window.__testResults, null, { timeout: 600000 }).then((h) => h.jsonValue());
for (const r of res.results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.err ? `\n     ${r.err}` : ''}`);
console.log(`\n${res.pass} passed, ${res.fail} failed`);
await browser.close();
process.exit(res.fail ? 1 : 0);
