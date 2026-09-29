const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDB } = require('./db');
const { notifySecurity, notifyStorage } = require('./notifications');

const DATA_DIR = process.env.DATA_DIR || '/data';

// حالة الصحة
let healthStatus = {
  status: 'healthy',
  lastCheck: null,
  checks: {}
};

// فحص مساحة القرص
function checkDiskSpace() {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    const freeMB = Math.floor(stats.bavail * stats.bsize / 1048576);
    const totalMB = Math.floor(stats.blocks * stats.bsize / 1048576);
    const usedPercent = Math.round((1 - stats.bavail / stats.blocks) * 100);
    
    return {
      freeMB,
      totalMB,
      usedPercent,
      healthy: freeMB > 100 && usedPercent < 90
    };
  } catch (e) {
    return { error: e.message, healthy: false };
  }
}

// فحص قاعدة البيانات
function checkDatabase() {
  try {
    const db = getDB();
    const result = db.prepare('SELECT COUNT(*) as count FROM files').get();
    return {
      connected: true,
      fileCount: result.count,
      healthy: true
    };
  } catch (e) {
    return { connected: false, error: e.message, healthy: false };
  }
}

// فحص الذاكرة
function checkMemory() {
  const used = process.memoryUsage();
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = Math.round((used.rss / total) * 100);
  
  return {
    usedMB: Math.round(used.rss / 1048576),
    totalMB: Math.round(total / 1048576),
    freeMB: Math.round(free / 1048576),
    usedPercent,
    healthy: usedPercent < 80
  };
}

// فحص التخزين
function checkStorage() {
  const storageStatus = {};
  
  // فحص التخزين المحلي
  try {
    const uploadDir = path.join(DATA_DIR, 'uploads');
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      storageStatus.local = {
        available: true,
        fileCount: files.length
      };
    } else {
      storageStatus.local = { available: false, error: 'Directory not found' };
    }
  } catch (e) {
    storageStatus.local = { available: false, error: e.message };
  }
  
  return storageStatus;
}

// فحص الخدمات الخارجية
async function checkExternalServices() {
  const services = {};
  
  // فحص Catbox
  try {
    const start = Date.now();
    const r = await fetch('https://catbox.moe', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    services.catbox = {
      available: r.ok,
      responseTime: Date.now() - start
    };
  } catch (e) {
    services.catbox = { available: false, error: e.message };
  }
  
  // فحص 0x0.st
  try {
    const start = Date.now();
    const r = await fetch('https://0x0.st', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    services['0x0'] = {
      available: r.ok,
      responseTime: Date.now() - start
    };
  } catch (e) {
    services['0x0'] = { available: false, error: e.message };
  }
  
  return services;
}

// فحص شامل
async function runHealthCheck() {
  const checks = {
    disk: checkDiskSpace(),
    database: checkDatabase(),
    memory: checkMemory(),
    storage: checkStorage(),
    external: await checkExternalServices()
  };
  
  // تحديد الحالة العامة
  let status = 'healthy';
  const issues = [];
  
  if (!checks.disk.healthy) {
    status = 'warning';
    issues.push(`Disk space low: ${checks.disk.freeMB}MB free`);
  }
  
  if (!checks.database.healthy) {
    status = 'critical';
    issues.push('Database connection failed');
  }
  
  if (!checks.memory.healthy) {
    status = 'warning';
    issues.push(`High memory usage: ${checks.memory.usedPercent}%`);
  }
  
  // إرسال إشعارات للمشاكل
  for (const issue of issues) {
    notifySecurity(issue);
  }
  
  healthStatus = {
    status,
    lastCheck: Date.now(),
    checks,
    issues
  };
  
  return healthStatus;
}

// الحصول على حالة الصحة
function getHealthStatus() {
  return healthStatus;
}

// بدء الفحص الدوري
function startHealthMonitoring(intervalMs = 60000) {
  // فحص فوري
  runHealthCheck();
  
  // فحص دوري
  setInterval(runHealthCheck, intervalMs);
  
  console.log('  [health] Monitoring started');
}

module.exports = {
  runHealthCheck,
  getHealthStatus,
  startHealthMonitoring,
  checkDiskSpace,
  checkDatabase,
  checkMemory,
  checkStorage
};
