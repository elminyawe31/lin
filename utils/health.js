// MINYAWE-LINK V8.0 — مراقبة الصحة (متوافقة مع serverless: فحص عند الطلب + كاش)
const { fileDB } = require('./db');

const UA = 'Mozilla/5.0 (compatible; MINYAWE-LINK/8.0)';
let providerCache = { at: 0, data: null };

function fetchWithTimeout(url, ms = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

async function checkProviders() {
  const now = Date.now();
  if (providerCache.data && now - providerCache.at < 5 * 60 * 1000) return providerCache.data;
  const targets = {
    onlyfiles: 'https://onlyfiles.com/',
    '0x0': 'https://0x0.st/'
  };
  if (process.env.PIXELDRAIN_API_KEY) targets.pixeldrain = 'https://pixeldrain.com/';
  // catbox معطّل افتراضياً — بيحجب عناوين مراكز البيانات، فحصه بيضيف ضجيج بلا فايدة
  if (process.env.ENABLE_CATBOX === 'true') targets.catbox = 'https://catbox.moe/';
  const entries = await Promise.all(Object.entries(targets).map(async ([name, url]) => {
    const started = Date.now();
    try {
      const r = await fetchWithTimeout(url);
      return [name, { ok: r.status < 500, status: r.status, latencyMs: Date.now() - started }];
    } catch {
      return [name, { ok: false, status: 0, latencyMs: Date.now() - started }];
    }
  }));
  const data = Object.fromEntries(entries);
  providerCache = { at: now, data };
  return data;
}

async function getHealthStatus() {
  const checks = {};

  // قاعدة البيانات
  try {
    const count = await fileDB.count();
    checks.database = { connected: true, fileCount: count, healthy: true };
  } catch (e) {
    checks.database = { connected: false, healthy: false, error: String((e && e.message) || e).slice(0, 120) };
  }

  // الذاكرة
  const mu = process.memoryUsage();
  const usedMB = Math.round(mu.rss / 1048576);
  checks.memory = { usedMB, healthy: usedMB < 900 };

  // المزودين
  try { checks.providers = await checkProviders(); } catch { checks.providers = {}; }

  const dbOk = checks.database.healthy;
  const providersOk = Object.values(checks.providers).some(p => p.ok);
  const status = dbOk && providersOk ? 'healthy' : (dbOk || providersOk ? 'warning' : 'critical');

  return { status, lastCheck: Date.now(), checks };
}

module.exports = { getHealthStatus };
