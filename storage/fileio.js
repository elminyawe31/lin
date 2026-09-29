// تخزين file.io - مجاني وبدون حساب (لكن الملفات تُحذف بعد 14 يوم)
async function upload(buffer, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  
  const r = await fetch('https://file.io', { method: 'POST', body: fd });
  const data = await r.json();
  
  if (!r.ok || !data.success) {
    throw new Error('file.io rejected: ' + JSON.stringify(data).slice(0, 120));
  }
  
  return data.link;
}

module.exports = { upload, name: 'fileio' };
