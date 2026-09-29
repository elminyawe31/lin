const catbox = require('./catbox');
const zerox0 = require('./0x0');
const fileio = require('./fileio');
const local = require('./local');

// سلسلة التخزين: كل مجاني وبدون حساب
// التخزين المحلي هو خيار احتياطي أخير فقط
const STORAGE_CHAIN = [
  { name: 'catbox', driver: catbox, priority: 1 },
  { name: '0x0', driver: zerox0, priority: 2 },
  { name: 'fileio', driver: fileio, priority: 3 },
  { name: 'local', driver: local, priority: 4, isFallback: true }
];

// ترتيب حسب الأولوية
STORAGE_CHAIN.sort((a, b) => a.priority - b.priority);

async function uploadWithFallback(buffer, filename, fileId) {
  const errors = [];
  
  for (const storage of STORAGE_CHAIN) {
    try {
      console.log(`  [storage] trying ${storage.name}...`);
      const result = await storage.driver.upload(buffer, filename, fileId);
      console.log(`  [storage] ${storage.name} success`);
      return {
        ...result,
        driver: storage.name,
        isFallback: storage.isFallback || false
      };
    } catch (e) {
      console.log(`  [storage] ${storage.name} failed: ${e.message}`);
      errors.push({ driver: storage.name, error: e.message });
    }
  }
  
  throw new Error('All storage providers failed: ' + JSON.stringify(errors));
}

function getDriver(name) {
  return STORAGE_CHAIN.find(s => s.name === name)?.driver;
}

function getActiveDrivers() {
  return STORAGE_CHAIN.map(s => s.name);
}

function getPrimaryDrivers() {
  return STORAGE_CHAIN.filter(s => !s.isFallback).map(s => s.name);
}

module.exports = {
  uploadWithFallback,
  getDriver,
  getActiveDrivers,
  getPrimaryDrivers,
  STORAGE_CHAIN
};
