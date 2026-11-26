// تخزين Pixeldrain — اختياري (يحتاج PIXELDRAIN_API_KEY)، حتى 20GB
// يُضاف للسلسلة تلقائياً لو المفتاح موجود
async function upload(buffer, filename, mimetype) {
  const key = process.env.PIXELDRAIN_API_KEY || '';
  if (!key) throw new Error('pixeldrain: no API key configured');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://pixeldrain.com/api/file/' + encodeURIComponent(filename), {
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(':' + key).toString('base64'),
        'Content-Type': mimetype || 'application/octet-stream'
      },
      body: buffer,
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.id) {
      const msg = j && j.message ? j.message : 'HTTP ' + r.status;
      throw new Error('pixeldrain rejected: ' + String(msg).slice(0, 100));
    }
    return { directUrl: 'https://pixeldrain.com/api/file/' + j.id, stored: j.id };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { upload, name: 'pixeldrain', maxMB: 20480 };
