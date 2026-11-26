// MINYAWE-LINK V8.0 — كاش ذاكرة + كاش قاعدة بيانات (لروابط المزودين المؤقتة)
const { cacheDB } = require('./db');

const memoryCache = new Map();
const MEMORY_CACHE_MAX = 1000;

function setMemory(key, value, ttlMs = 300000) {
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const firstKey = memoryCache.keys().next().value;
    memoryCache.delete(firstKey);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function getMemory(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (item.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}

function delMemory(key) {
  memoryCache.delete(key);
}

// كاش مزدوج: ذاكرة سريعة + قاعدة بيانات (يبقى بين الـ cold starts)
async function set(key, value, ttlMs = 300000) {
  setMemory(key, value, ttlMs);
  try { await cacheDB.set(key, value, ttlMs); } catch {}
}

async function get(key) {
  const m = getMemory(key);
  if (m !== null) return m;
  try {
    const v = await cacheDB.get(key);
    if (v !== null) setMemory(key, v, 60000);
    return v;
  } catch { return null; }
}

function stats() {
  return { memoryKeys: memoryCache.size, memoryMax: MEMORY_CACHE_MAX };
}

module.exports = { setMemory, getMemory, delMemory, set, get, stats };
