// Minimal test runner for the browser. Tests register with test(); run() executes them in order.
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }

export const assert = {
  ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); },
  equal(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
  deepEqual(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  },
  between(v, lo, hi, msg) { if (!(v >= lo && v <= hi)) throw new Error(msg || `expected ${v} to be between ${lo} and ${hi}`); },
  throws(fn, re, msg) {
    try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`threw "${e.message}", expected ${re}`); return; }
    throw new Error(msg || 'expected an error');
  },
};

export async function run(out) {
  let pass = 0, fail = 0;
  const results = [];
  for (const t of tests) {
    const t0 = performance.now();
    try { await t.fn(); pass++; results.push({ name: t.name, ok: true, ms: performance.now() - t0 }); }
    catch (e) { fail++; results.push({ name: t.name, ok: false, err: e.message, ms: performance.now() - t0 }); console.error(t.name, e); }
  }
  out.innerHTML = `<h1>${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed</h1>` + results.map((r) =>
    `<div class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'PASS' : 'FAIL'} ${r.name} <small>${r.ms.toFixed(0)}ms</small>${r.err ? `<pre>${r.err}</pre>` : ''}</div>`).join('');
  window.__testResults = { pass, fail, results };
  return { pass, fail };
}
