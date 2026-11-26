// تخزين Catbox — مجاني، دائم، بدون حساب
// مع CATBOX_USERHASH (اختياري): الرفع يتم في حسابك = ضمان أكبر ضد الحجب
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

async function upload(buffer, filename, mimetype) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  const userhash = process.env.CATBOX_USERHASH || '';
  if (userhash) fd.append('userhash', userhash);
  fd.append('fileToUpload', new Blob([buffer], { type: mimetype || 'application/octet-stream' }), filename);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: fd,
      headers: { 'User-Agent': UA },
      signal: ctrl.signal
    });
    const txt = (await r.text()).trim();
    if (!r.ok || !txt.startsWith('http')) {
      throw new Error('catbox rejected (' + r.status + '): ' + txt.slice(0, 100));
    }
    return { directUrl: txt, stored: txt.split('/').pop() || filename };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { upload, name: 'catbox' };
