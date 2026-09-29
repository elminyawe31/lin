// تخزين 0x0.st - مجاني وبدون حساب
async function upload(buffer, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  
  const r = await fetch('https://0x0.st', { method: 'POST', body: fd });
  const t = (await r.text()).trim();
  
  if (!r.ok || !t.startsWith('http')) {
    throw new Error('0x0.st rejected: ' + t.slice(0, 120));
  }
  
  return t;
}

module.exports = { upload, name: '0x0' };
