const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function ensureDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// التخزين المحلي - خيار احتياطي أخير فقط (بدون ضغط)
async function upload(buffer, filename, fileId) {
  ensureDir();
  
  const ext = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  const stored = fileId + ext;
  const filePath = path.join(UPLOAD_DIR, stored);
  
  // حفظ الملف كما هو بدون ضغط
  fs.writeFileSync(filePath, buffer);
  
  return {
    stored,
    directUrl: `/i/${fileId}`,
    compressed: 0
  };
}

function getFilePath(stored) {
  const p = path.join(UPLOAD_DIR, stored);
  if (!p.startsWith(UPLOAD_DIR + path.sep)) return null;
  if (!fs.existsSync(p)) return null;
  return p;
}

function deleteFile(stored) {
  try {
    const p = path.join(UPLOAD_DIR, stored);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

module.exports = { upload, getFilePath, deleteFile, name: 'local' };
