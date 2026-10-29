// Runs the browser suites (tests/e2e/e2e_*.cjs) one by one, each against a freshly started API (port 3055) and a Vite dev server (port 5199).
// Vite is started here (and warmed up so its first-load dependency optimisation cannot reload a page mid-test). A suite that fails is run once more:
// pass-on-retry is reported as FLAKY (never silently green), fail-twice as FAILED. Exit code 1 on any FAILED.
//   node tests/run-e2e.cjs [module ...]      e.g. quality roles
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const project = path.resolve(root, '..');
const dir = path.join(__dirname, 'e2e');
const API = process.env.TEST_PORT || '3055', WEB = '5199';
const mods = fs.readdirSync(dir).filter(f => /^e2e_.+\.cjs$/.test(f)).map(f => f.slice(4, -4)).sort();
const wanted = process.argv.slice(2);
const suites = wanted.length ? mods.filter(m => wanted.includes(m)) : mods;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(url, ms = 60000) {
  for (let t = 0; t < ms; t += 500) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up */ } await sleep(500); }
  throw new Error(`${url} did not come up`);
}
const killTree = p => { try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };

async function once(mod) {
  const api = spawn(process.execPath, ['index.js'], { cwd: root, env: { ...process.env, PORT: API }, stdio: 'ignore' });
  try {
    await until(`http://localhost:${API}/api/health`);
    const r = spawnSync(process.execPath, [path.join(dir, 'e2e.cjs'), `run_${mod}`, 'extra', path.join(dir, `e2e_${mod}.cjs`)], { cwd: root, encoding: 'utf8', timeout: 300000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const last = out.trim().split('\n').pop();
    return { ok: r.status === 0 && /\b0 failed/.test(last), last, detail: out.split('\n').filter(l => /^(FAIL|EXC)/.test(l)).slice(0, 6).join('\n') || `(no FAIL line) exit ${r.status}${r.error ? ' ' + r.error.message : ''}: ` + out.trim().split('\n').slice(-6).join('\n') };
  } finally { killTree(api); await sleep(800); }
}

(async () => {
  const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', WEB, '--strictPort'], { cwd: project, stdio: 'ignore', shell: true });
  let failed = 0, flaky = 0;
  try {
    await until(`http://localhost:${WEB}/tunegen/`);
    for (const p of ['/tunegen/src/main.tsx', '/tunegen/src/App.tsx']) await fetch(`http://localhost:${WEB}${p}`).catch(() => {});   // warm the module graph
    await sleep(4000);
    for (const mod of suites) {
      let r = await once(mod);
      if (r.ok) { console.log(`ok     ${mod}: ${r.last}`); continue; }
      const second = await once(mod);
      if (second.ok) { flaky++; console.log(`FLAKY  ${mod}: failed once, passed on retry\n  first run: ${r.detail.replace(/\n/g, '\n  ')}`); }
      else { failed++; console.log(`FAILED ${mod}: ${second.last}\n  ${second.detail.replace(/\n/g, '\n  ')}`); }
    }
  } finally { killTree(vite); }
  console.log(failed ? `\n${failed} suite(s) FAILED, ${flaky} flaky` : flaky ? `\nall passed; ${flaky} needed a retry (flaky)` : '\nall browser suites passed first time');
  process.exit(failed ? 1 : 0);
})();
