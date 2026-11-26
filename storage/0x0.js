// تخزين 0x0.st — مجاني، 512MB، الاحتفاظ من 30 يوم لسنة (يتجدد مع الاستخدام)
const UA = 'MINYAWE-LINK/8.0 (+https://github.com/elminyawe31/lin)';

async function upload(buffer, filename, mimetype) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mimetype || 'application/octet-stream' }), filename);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://0x0.st', {
      method: 'POST',
      body: fd,
      headers: { 'User-Agent': UA },
      signal: ctrl.signal
    });
    const txt = (await r.text()).trim();
    if (!r.ok || !txt.startsWith('http')) {
      throw new Error('0x0 rejected (' + r.status + '): ' + txt.slice(0, 100));
    }
    return { directUrl: txt, stored: txt.split('/').pop() || filename };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { upload, name: '0x0' };
