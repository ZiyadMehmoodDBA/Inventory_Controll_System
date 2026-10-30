'use strict';
// Polite, SSRF-safe page fetching for the catalogue scraper. Users supply the URLs, so the server must never be usable to reach its own
// network: every connection (and every redirect) is checked against private, loopback, link-local and metadata ranges at connect time, which
// also defeats DNS rebinding. robots.txt is honoured, requests to one host are spaced out, failures retry with backoff, bodies are size-capped.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const axios = require('axios');

const UA = 'TuneGENCatalogueBot/1.0 (+inventory catalogue import; honours robots.txt)';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MIN_GAP_MS = Number(process.env.CATALOGUE_MIN_GAP_MS || 1200);
const MAX_REDIRECTS = 3;
const RETRIES = 2;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

// Test servers set CATALOGUE_ALLOW_LOOPBACK=on to scrape a fixture on 127.0.0.1. It opens loopback only, never private networks or metadata.
const allowLoopback = () => process.env.CATALOGUE_ALLOW_LOOPBACK === 'on';

const ipv4 = s => s.split('.').map(Number);
/** Eight 16-bit groups of an IPv6 address (handles :: and a trailing dotted IPv4), or null when it cannot be read. */
function expandV6(addr) {
  let x = addr.toLowerCase().split('%')[0];
  const tail = x.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) { const [a, b, c, d] = tail.slice(1).map(Number); if ([a, b, c, d].some(n => n > 255)) return null; x = x.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16); }
  const parts = x.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [], rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const g = [...head, ...Array(fill).fill('0'), ...rest].map(p => parseInt(p || '0', 16));
  return g.length === 8 && g.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}

function isBlockedAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = ipv4(addr);
    if (a === 127) return !allowLoopback();
    return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(addr)) {
    const h = expandV6(addr);
    if (!h) return true;
    const zero = n => h.slice(0, n).every(x => x === 0);
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (zero(7) && h[7] === 1) return !allowLoopback();                         // ::1
    if (zero(5) && h[5] === 0xffff) return isBlockedAddress(v4(h[6], h[7]));     // ::ffff:a.b.c.d (IPv4-mapped)
    if (zero(6)) return true;                                                    // :: and ::a.b.c.d (IPv4-compatible)
    if (h[0] === 0x64 && h[1] === 0xff9b) return true;                           // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64 reaches IPv4 hosts)
    if (h[0] === 0x2002) return true;                                            // 6to4: an IPv4 address in disguise
    if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return true;          // Teredo, documentation
    if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;   // 100::/64 discard
    return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] & 0xff00) === 0xff00;   // unique-local, link-local, site-local, multicast
  }
  return true;
}

/** Throws a plain Error with a user-readable reason when the URL must not be fetched. Returns the parsed URL. */
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses can be scraped');
  if (u.username || u.password) throw new Error('Addresses with a user name or password are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const testLoopback = allowLoopback() && (host === 'localhost' || host === '::1' || /^127\./.test(host));   // fixture servers use any port
  if (!ALLOWED_PORTS.has(u.port) && !testLoopback) throw new Error('That port is not allowed (use 80, 443, 8080 or 8443)');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    if (!(allowLoopback() && host === 'localhost')) throw new Error('Local and internal addresses cannot be scraped');
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new Error('Private, local and cloud-metadata addresses cannot be scraped');
  return u;
}

// Resolved at connect time, so a name that resolves to a private address later is still refused.
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter(a => !isBlockedAddress(a.address));
    if (!ok.length) return cb(new Error('Private, local and cloud-metadata addresses cannot be scraped'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
const httpAgent = new http.Agent({ lookup: safeLookup, keepAlive: false });
const httpsAgent = new https.Agent({ lookup: safeLookup, keepAlive: false });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastHit = new Map();      // host -> time of the previous request
async function throttle(host) {
  const wait = (lastHit.get(host) || 0) + MIN_GAP_MS - Date.now();
  lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) || 0) + MIN_GAP_MS));
  if (wait > 0) await sleep(wait);
}

/** One GET with manual redirects (each hop re-checked). Returns { url, status, headers, data(string) }. */
async function getOnce(raw, accept) {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = checkUrl(url);
    await throttle(u.host);
    const res = await axios.get(u.href, {
      timeout: TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true, responseType: 'text', transformResponse: x => x,
      maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, httpAgent, httpsAgent,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) { url = new URL(res.headers.location, u).href; continue; }
    return { url: u.href, status: res.status, headers: res.headers, data: typeof res.data === 'string' ? res.data : '' };
  }
  throw new Error('Too many redirects');
}

async function fetchWithRetry(url, accept) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const r = await getOnce(url, accept);
      if (r.status === 429 || r.status >= 500) { last = new Error(`The site answered ${r.status}`); await sleep(1000 * 2 ** i); continue; }
      return r;
    } catch (e) {
      if (/cannot be scraped|not allowed|not a valid|Only http|Too many redirects/.test(e.message)) throw e;   // not worth retrying
      last = new Error(e.code === 'ECONNABORTED' ? 'The site took too long to answer' : e.message);
      await sleep(1000 * 2 ** i);
    }
  }
  throw last || new Error('The site could not be reached');
}

// ── robots.txt ──
const robotsCache = new Map();   // origin -> { at, rules }
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), val = m[2];
    if (k === 'user-agent') { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === 'allow' || k === 'disallow') && cur.rules.length < 500) cur.rules.push({ allow: k === 'allow', path: val.slice(0, 200) });
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && 'tunegencataloguebot'.includes(a)));
  return (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
}
// Wildcard match without building a regex from site-controlled text (a hostile robots.txt must not be able to stall the server):
// pieces between * must appear in order, anchored at the start, and at the end when the pattern ends in $.
const ruleMatches = (path, pattern) => {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (pieces.length === 1) return anchored ? path === pieces[0] : path.startsWith(pieces[0]);
  if (!path.startsWith(pieces[0])) return false;
  let pos = pieces[0].length;
  const last = anchored ? pieces[pieces.length - 1] : '';
  const middle = pieces.slice(1, anchored ? -1 : undefined);
  for (const p of middle) {
    if (!p) continue;                                              // consecutive stars
    const at = path.indexOf(p, pos);
    if (at < 0) return false;
    pos = at + p.length;
  }
  return !anchored || (path.endsWith(last) && path.length - last.length >= pos);
};
function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(path, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
async function allowedByRobots(raw) {
  const u = checkUrl(raw);
  const hit = robotsCache.get(u.origin);
  let rules;
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) rules = hit.rules;
  else {
    try {
      const r = await getOnce(u.origin + '/robots.txt', 'text/plain');
      if (r.status === 401 || r.status === 403) rules = [{ allow: false, path: '/' }];      // the site closed itself to robots
      else rules = r.status === 200 ? parseRobots(r.data) : [];
    } catch (e) { if (/cannot be scraped/.test(e.message)) throw e; rules = []; }
    robotsCache.set(u.origin, { at: Date.now(), rules });
  }
  return robotsAllows(rules, u.pathname + u.search);
}

/** Fetch an HTML (or JSON) page politely. Never bypasses robots.txt, logins, CAPTCHAs or blocks: those end the page with a reason. */
async function fetchPage(url) {
  if (!(await allowedByRobots(url))) { const e = new Error('The site\'s robots.txt does not allow this page to be fetched'); e.code = 'ROBOTS'; throw e; }
  const r = await fetchWithRetry(url, 'text/html,application/xhtml+xml,application/json;q=0.8');
  if (r.status === 401 || r.status === 402 || r.status === 403) { const e = new Error(`The site refused access (${r.status}). Pages behind a login, paywall or bot protection are not scraped.`); e.code = 'DENIED'; throw e; }
  if (r.status >= 400) throw new Error(`The page answered ${r.status}`);
  const ct = String(r.headers['content-type'] || '');
  if (!/html|xml|json|text/i.test(ct)) throw new Error('The address does not return a web page');
  if (/captcha|are you a robot|verify you are human|cf-challenge|access denied/i.test(r.data.slice(0, 6000)) && r.data.length < 20000) {
    const e = new Error('The site is showing a human-verification page. It is not bypassed; pick another source.'); e.code = 'DENIED'; throw e;
  }
  return { url: r.url, html: r.data, contentType: ct };
}

module.exports = { fetchPage, checkUrl, isBlockedAddress, parseRobots, robotsAllows, UA };
