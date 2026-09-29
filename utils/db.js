const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'minyawe.db');

let db;

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  // جدول الملفات
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      original TEXT NOT NULL,
      mimetype TEXT,
      size INTEGER DEFAULT 0,
      expiryAt INTEGER,
      deleteToken TEXT,
      createdAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      views INTEGER DEFAULT 0,
      pw TEXT,
      driver TEXT,
      stored TEXT,
      directUrl TEXT,
      mirrorUrl TEXT,
      compressed INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_files_slug ON files(slug);
    CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expiryAt);
    CREATE INDEX IF NOT EXISTS idx_files_created ON files(createdAt);
  `);

  // جدول الألبومات
  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      files TEXT NOT NULL,
      createdAt INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      expiryAt INTEGER
    );
  `);

  // جدول الإشعارات
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      target TEXT DEFAULT 'admin',
      read INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_target ON notifications(target);
  `);

  // جدول التحليلات
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      fileId TEXT,
      ip TEXT,
      userAgent TEXT,
      timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics(event);
    CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);
  `);

  // جدول سجل التدقيق
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      ip TEXT,
      act TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_t ON audit(t);
  `);

  // جدول التخزين المؤقت
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expiresAt);
  `);

  return db;
}

function getDB() {
  if (!db) initDB();
  return db;
}

// دوال الملفات
const fileDB = {
  insert(file) {
    const stmt = getDB().prepare(`
      INSERT INTO files (id, slug, original, mimetype, size, expiryAt, deleteToken, 
                         createdAt, views, pw, driver, stored, directUrl, mirrorUrl, compressed)
      VALUES (@id, @slug, @original, @mimetype, @size, @expiryAt, @deleteToken,
              @createdAt, @views, @pw, @driver, @stored, @directUrl, @mirrorUrl, @compressed)
    `);
    stmt.run(file);
  },

  getById(id) {
    return getDB().prepare('SELECT * FROM files WHERE id = ?').get(id);
  },

  getBySlug(slug) {
    return getDB().prepare('SELECT * FROM files WHERE slug = ?').get(slug.toLowerCase());
  },

  findByKey(key) {
    return this.getById(key) || this.getBySlug(key);
  },

  getAll(limit = 500, offset = 0) {
    return getDB().prepare('SELECT * FROM files ORDER BY createdAt DESC LIMIT ? OFFSET ?').all(limit, offset);
  },

  search(query, limit = 500) {
    const q = `%${query.toLowerCase()}%`;
    return getDB().prepare(`
      SELECT * FROM files 
      WHERE LOWER(original) LIKE ? OR LOWER(slug) LIKE ? OR LOWER(id) LIKE ?
      ORDER BY createdAt DESC LIMIT ?
    `).all(q, q, q, limit);
  },

  update(id, updates) {
    const keys = Object.keys(updates);
    if (keys.length === 0) return;
    const setClause = keys.map(k => `${k} = @${k}`).join(', ');
    const stmt = getDB().prepare(`UPDATE files SET ${setClause} WHERE id = @id`);
    stmt.run({ ...updates, id });
  },

  delete(id) {
    return getDB().prepare('DELETE FROM files WHERE id = ?').run(id);
  },

  incrementViews(id) {
    getDB().prepare('UPDATE files SET views = views + 1 WHERE id = ?').run(id);
  },

  getExpired() {
    const now = Date.now();
    return getDB().prepare('SELECT * FROM files WHERE expiryAt IS NOT NULL AND expiryAt < ?').all(now);
  },

  count() {
    return getDB().prepare('SELECT COUNT(*) as count FROM files').get().count;
  },

  getTotalViews() {
    return getDB().prepare('SELECT COALESCE(SUM(views), 0) as total FROM files').get().total;
  },

  getTotalBytes() {
    return getDB().prepare('SELECT COALESCE(SUM(size), 0) as total FROM files').get().total;
  },

  getTop(limit = 5) {
    return getDB().prepare('SELECT * FROM files ORDER BY views DESC LIMIT ?').all(limit);
  }
};

// دوال الألبومات
const albumDB = {
  insert(album) {
    getDB().prepare('INSERT INTO albums (id, files, createdAt, expiryAt) VALUES (?, ?, ?, ?)')
      .run(album.id, JSON.stringify(album.files), album.createdAt, album.expiryAt);
  },

  getById(id) {
    const row = getDB().prepare('SELECT * FROM albums WHERE id = ?').get(id);
    if (row) row.files = JSON.parse(row.files);
    return row;
  },

  delete(id) {
    return getDB().prepare('DELETE FROM albums WHERE id = ?').run(id);
  },

  getExpired() {
    const now = Date.now();
    return getDB().prepare('SELECT * FROM albums WHERE expiryAt IS NOT NULL AND expiryAt < ?').all(now);
  }
};

// دوال الإشعارات
const notificationDB = {
  insert(notification) {
    getDB().prepare('INSERT INTO notifications (id, type, message, priority, target, read, createdAt) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(notification.id, notification.type, notification.message, notification.priority || 'medium', notification.target || 'admin', Date.now());
  },

  getAll(limit = 100) {
    return getDB().prepare('SELECT * FROM notifications ORDER BY createdAt DESC LIMIT ?').all(limit);
  },

  getByTarget(target, limit = 100) {
    return getDB().prepare('SELECT * FROM notifications WHERE target = ? OR target = ? ORDER BY createdAt DESC LIMIT ?')
      .all(target, 'all', limit);
  },

  getUnread() {
    return getDB().prepare('SELECT * FROM notifications WHERE read = 0 ORDER BY createdAt DESC').all();
  },

  getUnreadByTarget(target) {
    return getDB().prepare('SELECT * FROM notifications WHERE read = 0 AND (target = ? OR target = ?) ORDER BY createdAt DESC')
      .all(target, 'all');
  },

  markRead(id) {
    getDB().prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  },

  markAllRead() {
    getDB().prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  },

  delete(id) {
    return getDB().prepare('DELETE FROM notifications WHERE id = ?').run(id);
  },

  cleanup() {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    getDB().prepare('DELETE FROM notifications WHERE createdAt < ?').run(weekAgo);
  }
};

// دوال التحليلات
const analyticsDB = {
  track(event, fileId, req) {
    getDB().prepare('INSERT INTO analytics (id, event, fileId, ip, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(crypto.randomBytes(8).toString('hex'), event, fileId, req.ip, req.get('user-agent'), Date.now());
  },

  getStats(hours = 24) {
    const since = Date.now() - hours * 3600 * 1000;
    return getDB().prepare(`
      SELECT event, COUNT(*) as count FROM analytics 
      WHERE timestamp > ? 
      GROUP BY event
    `).all(since);
  },

  cleanup() {
    const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
    getDB().prepare('DELETE FROM analytics WHERE timestamp < ?').run(monthAgo);
  }
};

// دوال سجل التدقيق
const auditDB = {
  log(act, req, detail) {
    getDB().prepare('INSERT INTO audit (t, ip, act, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), req.ip || 'unknown', act, JSON.stringify(detail || {}));
  },

  getAll(limit = 200, offset = 0) {
    return getDB().prepare('SELECT * FROM audit ORDER BY t DESC LIMIT ? OFFSET ?').all(limit, offset);
  },

  search(query, limit = 200) {
    const q = `%${query.toLowerCase()}%`;
    return getDB().prepare('SELECT * FROM audit WHERE LOWER(act) LIKE ? OR LOWER(detail) LIKE ? ORDER BY t DESC LIMIT ?')
      .all(q, q, limit);
  },

  cleanup() {
    const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
    getDB().prepare('DELETE FROM audit WHERE t < ?').run(monthAgo);
  }
};

// دوال التخزين المؤقت
const cacheDB = {
  set(key, value, ttlMs = 3600000) {
    const expiresAt = Date.now() + ttlMs;
    getDB().prepare('INSERT OR REPLACE INTO cache (key, value, expiresAt) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(value), expiresAt);
  },

  get(key) {
    const row = getDB().prepare('SELECT * FROM cache WHERE key = ?').get(key);
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      this.delete(key);
      return null;
    }
    return JSON.parse(row.value);
  },

  delete(key) {
    getDB().prepare('DELETE FROM cache WHERE key = ?').run(key);
  },

  cleanup() {
    const now = Date.now();
    getDB().prepare('DELETE FROM cache WHERE expiresAt < ?').run(now);
  }
};

// دوال الصيانة
function runMaintenance() {
  // تنظيف الملفات المنتهية
  const expiredFiles = fileDB.getExpired();
  for (const file of expiredFiles) {
    fileDB.delete(file.id);
    auditDB.log('expired', { ip: 'cron' }, { id: file.id, name: file.original, driver: file.driver });
  }

  // تنظيف الألبومات المنتهية
  const expiredAlbums = albumDB.getExpired();
  for (const album of expiredAlbums) {
    albumDB.delete(album.id);
  }

  // تنظيف التخزين المؤقت
  cacheDB.cleanup();

  // تنظيف الإشعارات القديمة
  notificationDB.cleanup();

  // تنظيف التحليلات القديمة
  analyticsDB.cleanup();

  // تنظيف سجل التدقيق القديم
  auditDB.cleanup();

  // ضغط قاعدة البيانات
  getDB().exec('VACUUM');
}

module.exports = {
  initDB,
  getDB,
  fileDB,
  albumDB,
  notificationDB,
  analyticsDB,
  auditDB,
  cacheDB,
  runMaintenance
};
