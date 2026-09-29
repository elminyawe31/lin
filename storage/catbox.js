// تخزين Catbox - مجاني وبدون حساب
async function upload(buffer, filename) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('fileToUpload', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  
  const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd });
  const t = (await r.text()).trim();
  
  if (!r.ok || !t.startsWith('http')) {
    throw new Error('catbox rejected: ' + t.slice(0, 120));
  }
  
  return t;
}

module.exports = { upload, name: 'catbox' };
