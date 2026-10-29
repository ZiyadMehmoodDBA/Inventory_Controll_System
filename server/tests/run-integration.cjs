// Runs the integration suites (tests/integration/*.cjs) against a spare API on TEST_PORT (default 3055), each on a freshly started
// server because the API rate limiter would otherwise reject the later suites. Every suite builds its own throwaway organisation
// and removes it afterwards. Usage: node tests/run-integration.cjs [name ...]     (e.g. smoke16 smoke17)
// Needs the SQL Server from server/.env. Browser suites (tests/e2e) are run separately with tests/e2e/e2e.cjs.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.TEST_PORT || '3055';
const root = path.resolve(__dirname, '..');
const dir = path.join(__dirname, 'integration');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const all = fs.readdirSync(dir).filter(f => f.endsWith('.cjs')).map(f => f.replace(/\.cjs$/, '')).sort(natural);
const wanted = process.argv.slice(2);
const suites = wanted.length ? all.filter(s => wanted.includes(s)) : all;

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/api/health`); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('API did not start');
}

(async () => {
  let failed = 0;
  for (const name of suites) {
    const api = spawn(process.execPath, ['index.js'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
    try {
      await waitForApi();
      const r = spawnSync(process.execPath, [path.join(dir, `${name}.cjs`)], { cwd: root, encoding: 'utf8', timeout: 600000 });
      const out = (r.stdout || '') + (r.stderr || '');
      const last = out.trim().split('\n').pop();
      const bad = r.status !== 0;
      if (bad) failed++;
      console.log(`${bad ? 'FAIL' : 'ok  '} ${name}: ${last}`);
      if (bad) console.log(out.split('\n').filter(l => /^(FAIL|EXC)/.test(l)).slice(0, 8).join('\n'));
    } finally { api.kill(); await new Promise(r => setTimeout(r, 800)); }
  }
  console.log(failed ? `\n${failed} suite(s) failed` : '\nall integration suites passed');
  process.exit(failed ? 1 : 0);
})();
