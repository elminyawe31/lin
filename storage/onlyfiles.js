// تخزين OnlyFiles — مجاني، CORS مفتوح، حتى 100MB
// الميزة الوحيدة اللي بتسمح بالرفع المباشر من المتصفح (صفر بايتات عبر Vercel)
// رابط الملف المباشر بياخد token مؤقت — بنجيبه وقت الطلب من صفحة الملف
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const cache = require('../utils/cache');

async function upload(buffer, filename, mimetype) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mimetype || 'application/octet-stream' }), filename);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://api.onlyfiles.com/v1/upload', {
      method: 'POST',
      body: fd,
      headers: { 'User-Agent': UA, 'Referer': 'https://onlyfiles.com/' },
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.status || !j.data || !j.data.file) {
      const msg = j && j.error && j.error.message ? j.error.message : 'HTTP ' + r.status;
      throw new Error('onlyfiles rejected: ' + String(msg).slice(0, 100));
    }
    const f = j.data.file;
    return {
      directUrl: f.url.full,
      mirrorUrl: f.url.short,
      stored: f.metadata.id || ''
    };
  } finally {
    clearTimeout(t);
  }
}

// استخراج رابط التحميل المباشر الطازج من صفحة الملف (بتكلفة صفر على الفاتورة)
async function resolve(meta) {
  if (!meta || !meta.directUrl) throw new Error('onlyfiles: no page url');
  const cacheKey = 'ofd:' + (meta.stored || meta.id);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(meta.directUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://onlyfiles.com/' },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('onlyfiles page HTTP ' + r.status);
    const html = await r.text();
    let m = html.match(/(?:href|src)="(\/dl\/[^"]+)"/);
    if (!m) m = html.match(/(dl\/[A-Za-z0-9._%-]+\/[A-Za-z0-9._%-]+\/[^\s"'<>]+)/);
    if (!m) throw new Error('onlyfiles: dl link not found');
    const path = m[1].startsWith('/') ? m[1] : '/' + m[1];
    const url = new URL(path, 'https://onlyfiles.com').href;
    await cache.set(cacheKey, url, 180000); // 3 دقائق — الـ token بيفضل صالح وقت أطول بكتير
    return url;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { upload, resolve, name: 'onlyfiles', maxMB: 100 };
