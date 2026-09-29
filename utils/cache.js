const { cacheDB } = require('./db');

// ذاكرة مؤقتة في الذاكرة للبيانات الساخنة
const memoryCache = new Map();
const MEMORY_CACHE_MAX = 1000;

// تخزين في الذاكرة
function setMemory(key, value, ttlMs = 300000) {
  // تنظيف إذا كانت الذاكرة ممتلئة
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const firstKey = memoryCache.keys().next().value;
    memoryCache.delete(firstKey);
  }
  
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

// استرجاع من الذاكرة
function getMemory(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  
  if (item.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  
  return item.value;
}

// حذف من الذاكرة
function deleteMemory(key) {
  memoryCache.delete(key);
}

// تخزين في قاعدة البيانات
function setDB(key, value, ttlMs = 3600000) {
  cacheDB.set(key, value, ttlMs);
}

// استرجاع من قاعدة البيانات
function getDB(key) {
  return cacheDB.get(key);
}

// حذف من قاعدة البيانات
function deleteDB(key) {
  cacheDB.delete(key);
}

// تخزين مع فحص الذاكرة أولاً
function set(key, value, ttlMs = 3600000) {
  setMemory(key, value, Math.min(ttlMs, 300000));
  setDB(key, value, ttlMs);
}

// استرجاع مع فحص الذاكرة أولاً
function get(key) {
  // فحص الذاكرة أولاً
  const memValue = getMemory(key);
  if (memValue !== null) return memValue;
  
  // فحص قاعدة البيانات
  const dbValue = getDB(key);
  if (dbValue !== null) {
    // تخزين في الذاكرة للاستخدام المستقبلي
    setMemory(key, dbValue);
    return dbValue;
  }
  
  return null;
}

// حذف من كلا الذاكرة وقاعدة البيانات
function del(key) {
  deleteMemory(key);
  deleteDB(key);
}

// تنظيف الذاكرة
function cleanup() {
  const now = Date.now();
  for (const [key, item] of memoryCache.entries()) {
    if (item.expiresAt < now) {
      memoryCache.delete(key);
    }
  }
}

// إحصائيات التخزين المؤقت
function stats() {
  return {
    memory: {
      size: memoryCache.size,
      max: MEMORY_CACHE_MAX
    },
    db: {
      // يمكن إضافة إحصائيات قاعدة البيانات هنا
    }
  };
}

module.exports = {
  set,
  get,
  del,
  setMemory,
  getMemory,
  deleteMemory,
  setDB,
  getDB,
  deleteDB,
  cleanup,
  stats
};
