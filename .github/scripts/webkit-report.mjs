// Turns the WebKit test results (reports/results.json) into a readable iPad to-do list.
// Run by .github/workflows/build.yml after the WebKit tests. It writes:
//   reports/webkit.md             the list, in Markdown (it becomes the body of the "iPad" issue)
//   reports/webkit-failures.json  just the names of the failing tests, to spot what changed since last time
// and adds the list to the run's summary page, plus a warning for each failing test.
// It never fails the build: a missing or empty results file just says so.

import fs from 'node:fs';

const RESULTS = 'reports/results.json';
const MAX_ERROR_LINES = 20;   // how much of each error to keep
const TEST_DIR = 'tests';     // testDir in playwright.config.js

const env = process.env;
const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
const commit = (env.GITHUB_SHA || '').slice(0, 7);
const plain = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').split(process.cwd() + '/').join('');   // drop terminal colours and this machine's folder

let data = null;
try { data = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch {}

const failing = [];
let total = 0;
function walk(suite, titles) {
  const here = suite.title && !suite.title.endsWith('.js') ? [...titles, suite.title] : titles;
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      total++;
      if (t.status !== 'unexpected' && t.status !== 'flaky') continue;
      const last = t.results[t.results.length - 1] || {};
      const err = plain((last.error && (last.error.stack || last.error.message)) || (last.errors || []).map((e) => e.message).join('\n'));
      failing.push({
        id: `${TEST_DIR}/${spec.file} › ${[...here, spec.title].join(' › ')}`,
        where: `${TEST_DIR}/${spec.file}:${spec.line}`,
        title: [...here, spec.title].join(' › '),
        flaky: t.status === 'flaky',
        error: err.split('\n').slice(0, MAX_ERROR_LINES).join('\n').trim() || '(no error message)',
        has: (last.attachments || []).map((a) => a.name),   // screenshot, trace...
      });
    }
  }
  for (const s of suite.suites || []) walk(s, here);
}
for (const s of (data && data.suites) || []) walk(s, []);

const lines = [];
lines.push(`<!-- webkit-failures: ${JSON.stringify(failing.map((f) => f.id))} -->`);
if (!data) {
  lines.push('## iPad early warning: the WebKit tests did not run', '', 'No results file was made, so the tests probably stopped before starting (for example, WebKit failed to install). Check the run log.');
} else if (!failing.length) {
  lines.push(`## iPad early warning: all ${total} tests pass in WebKit`);
} else {
  lines.push(`## iPad early warning: ${failing.length} of ${total} tests fail in WebKit`);
}
lines.push('', `Checked on commit \`${commit || 'local'}\`, ${new Date().toISOString().slice(0, 10)}.${runUrl ? ` [This run](${runUrl}): download **webkit-report** at the bottom of the page (kept 90 days) for the full report, a screenshot of each failure, and a step-by-step replay (drop \`trace.zip\` onto https://trace.playwright.dev).` : ''}`);
lines.push('', `WebKit on Linux is close to Safari on an iPad, but not the same. [docs/IPAD.md](${env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/main/docs/IPAD.md` : 'docs/IPAD.md'}) lists what only a real iPad can check.`);
if (failing.length) {
  lines.push('', '### To fix', '');
  for (const f of failing) {
    lines.push(`- [ ] **${f.title}**${f.flaky ? ' (failed, then passed when run again)' : ''}`);
    lines.push(`  \`${f.where}\`${f.has.length ? ` · saved: ${[...new Set(f.has)].join(', ')}` : ''}`);
    lines.push('  ```', ...f.error.split('\n').map((l) => '  ' + l), '  ```');
  }
  lines.push('', 'Run just these on a Mac or Linux machine: `npx playwright install webkit`, then `npm run test:webkit`.');
}
const md = lines.join('\n') + '\n';

fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/webkit.md', md);
fs.writeFileSync('reports/webkit-failures.json', JSON.stringify(failing.map((f) => f.id)));
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md.replace(/^<!--.*-->\n/, ''));
for (const f of failing) console.log(`::warning file=${f.where.split(':')[0]},line=${f.where.split(':')[1]},title=Fails in WebKit (iPad)::${f.title}`);
console.log(failing.length ? `${failing.length} of ${total} tests fail in WebKit (this never blocks a merge).` : `All ${total} WebKit tests pass.`);
