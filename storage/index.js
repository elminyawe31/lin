// MINYAWE-LINK V8.0 — مدير سلسلة التخزين السحابي
// الترتيب: onlyfiles (دائم، 100MB) -> pixeldrain (20GB، keep-alive يومي) -> 0x0 (احتياطي أخير)
// catbox معطّل افتراضياً: بيحجب كل عناوين IP المراكز البيانات (وفيها Vercel) حتى قبل استقبال الطلب
// — لو حبيت تفعّله من بروكسي خاص: ENABLE_CATBOX=true + CATBOX_USERHASH=...
// كله سحابي 100% — مفيش أي تخزين محلي
const onlyfiles = require('./onlyfiles');
const pixeldrain = require('./pixeldrain');
const zerox0 = require('./0x0');
const catbox = require('./catbox');
const { fileDB } = require('../utils/db');

const STORAGE_CHAIN = [
  { name: 'onlyfiles', driver: onlyfiles, priority: 1 },
  { name: '0x0', driver: zerox0, priority: 3 }
];
if (process.env.PIXELDRAIN_API_KEY) {
  STORAGE_CHAIN.push({ name: 'pixeldrain', driver: pixeldrain, priority: 2 });
}
// catbox: اختياري تماماً — افتراضياً خارج السلسلة (حجب datacenter IPs)
if (process.env.ENABLE_CATBOX === 'true' && process.env.CATBOX_USERHASH) {
  STORAGE_CHAIN.push({ name: 'catbox', driver: catbox, priority: 9 });
}
STORAGE_CHAIN.sort((a, b) => a.priority - b.priority);

// دايرة أمان: مزود فاشل يتخطى مؤقتاً بدل ما يعلّق كل رفع
const BREAKER = new Map(); // name -> { failUntil, fails }
const BREAKER_FAILS = 2;
const BREAKER_COOLDOWN = 10 * 60 * 1000;

function breakerOpen(name) {
  const b = BREAKER.get(name);
  return !!(b && b.failUntil > Date.now());
}

function breakerFail(name) {
  const b = BREAKER.get(name) || { fails: 0, failUntil: 0 };
  b.fails++;
  if (b.fails >= BREAKER_FAILS) {
    b.failUntil = Date.now() + BREAKER_COOLDOWN;
    b.fails = 0;
  }
  BREAKER.set(name, b);
}

function breakerPass(name) {
  BREAKER.delete(name);
}

// أسماء عامة للعرض — مش بنكشف أسماء المزودين للواجهة
function displayName(name) {
  const idx = STORAGE_CHAIN.findIndex(s => s.name === name);
  return 'CLOUD-' + (idx >= 0 ? idx + 1 : '?');
}

async function uploadWithFallback(buffer, filename, mimetype, fileId) {
  const errors = [];
  for (const storage of STORAGE_CHAIN) {
    if (breakerOpen(storage.name)) {
      errors.push({ driver: storage.name, error: 'breaker open (recent failures)' });
      continue;
    }
    try {
      console.log(`  [storage] trying ${storage.name} for ${fileId}...`);
      const result = await storage.driver.upload(buffer, filename, mimetype, fileId);
      console.log(`  [storage] ${storage.name} success for ${fileId}`);
      breakerPass(storage.name);
      return { ...result, driver: storage.name };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 160);
      console.log(`  [storage] ${storage.name} failed: ${msg}`);
      breakerFail(storage.name);
      errors.push({ driver: storage.name, error: msg });
    }
  }
  throw new Error('all storage providers failed: ' + JSON.stringify(errors));
}

// جلب الرابط المباشر الحقيقي للتحميل/التشغيل (302 — صفر بايتات عبر السيرفر)
async function resolveDirectUrl(meta) {
  if (!meta || !meta.directUrl) return null;
  if (meta.driver === 'onlyfiles') {
    try { return await onlyfiles.resolve(meta); } catch { return meta.directUrl; }
  }
  return meta.directUrl;
}

// ===== Keep-alive يومي (Vercel Cron) =====
// pixeldrain بيحذف الملفات اللي متشغّلتش خلال فترة عدم النشاط، و0x0 بيقلل مدة الاحتفاظ
// — بنلمس كل ملف (طلب GET صغير بالـ Range) عشان نصفّر مؤقّت النشاط. تكلفة: بايتات معدودة من المزود، صفر من فاتورة Vercel.
const KEEPALIVE_DRIVERS = ['pixeldrain', '0x0'];
const KEEPALIVE_MAX = 400; // حد أمان لمدة الـ serverless

function pingUrl(meta) {
  if (meta.driver === 'pixeldrain' && meta.stored) {
    return 'https://pixeldrain.com/api/file/' + encodeURIComponent(meta.stored);
  }
  if (meta.driver === '0x0' && meta.directUrl) return meta.directUrl;
  return null;
}

async function keepAlive() {
  const out = { checked: 0, pinged: 0, failed: 0, drivers: {} };
  let files = [];
  try {
    files = await fileDB.getAll(KEEPALIVE_MAX * 2, 0);
  } catch (e) {
    return { ...out, error: String((e && e.message) || e).slice(0, 120) };
  }
  const now = Date.now();
  const targets = files
    .filter(m => KEEPALIVE_DRIVERS.includes(m.driver) && (!m.expiryAt || m.expiryAt > now))
    .slice(0, KEEPALIVE_MAX);

  await Promise.all(targets.map(async m => {
    const url = pingUrl(m);
    if (!url) return;
    out.checked++;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, {
        headers: {
          'Range': 'bytes=0-1024',
          'User-Agent': 'Mozilla/5.0 (compatible; MINYAWE-LINK/8.0 keep-alive)'
        },
        signal: ctrl.signal
      });
      await r.arrayBuffer().catch(() => {});
      if (r.ok || r.status === 206) { out.pinged++; out.drivers[m.driver] = (out.drivers[m.driver] || 0) + 1; }
      else out.failed++;
    } catch {
      out.failed++;
    } finally {
      clearTimeout(t);
    }
  }));

  return out;
}

function getChainNames() { return STORAGE_CHAIN.map(s => s.name); }
function getDisplayChain() { return STORAGE_CHAIN.map(s => displayName(s.name)); }

// المزودون اللي بيستقبلوا رفع مباشر من المتصفح (CORS مفتوح على الرفع)
// pixeldrain مش منهم: الـ preflight بيرجع بدون Access-Control-Allow-Origin على PUT
function getDirectProviders() {
  return ['onlyfiles'];
}

function isProviderAllowed(provider) {
  return getDirectProviders().includes(String(provider || ''));
}

module.exports = {
  uploadWithFallback,
  resolveDirectUrl,
  keepAlive,
  getChainNames,
  getDisplayChain,
  getDirectProviders,
  isProviderAllowed,
  displayName,
  STORAGE_CHAIN
};
