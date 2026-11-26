// MINYAWE-LINK V8.0 — طبقة البيانات
// الإنتاج: PostgreSQL (Vercel Postgres / Neon) عبر postgres.js
// التطوير المحلي (بدون DATABASE_URL): مخزن JSON في ./data

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DEV_DB_PATH = path.join(DATA_DIR, 'dev-db.json');

const PG_URL_CANDIDATE = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
// نقبل سكيمات postgres فقط — بيئات فيها DATABASE_URL بأنواع أخرى (sqlite/file) تتتجاهل
const PG_URL = /^postgres(ql)?:\/\//i.test(PG_URL_CANDIDATE) ? PG_URL_CANDIDATE : '';

let sql = null;
let pgReady = false;
let pgInitPromise = null;

let devData = null;
let devSaveTimer = null;

function isRemote() { return !!PG_URL; }

// ===== Postgres backend =====
async function initPG() {
  const postgres = require('postgres');
  sql = postgres(PG_URL, { ssl: 'require', max: 5, idle_timeout: 20, connect_timeout: 10 });
  await sql`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      original TEXT NOT NULL,
      mimetype TEXT,
      size BIGINT DEFAULT 0,
      expiry_at BIGINT,
      delete_token TEXT,
      created_at BIGINT DEFAULT 0,
      views INTEGER DEFAULT 0,
      pw TEXT,
      driver TEXT,
      stored TEXT,
      direct_url TEXT,
      mirror_url TEXT,
      compressed INTEGER DEFAULT 0
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_files_slug ON files(slug)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expiry_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at)`;
  await sql`
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      files TEXT NOT NULL,
      created_at BIGINT DEFAULT 0,
      expiry_at BIGINT
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      target TEXT DEFAULT 'admin',
      read INTEGER DEFAULT 0,
      created_at BIGINT DEFAULT 0
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)`;
  await sql`
    CREATE TABLE IF NOT EXISTS analytics (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      file_id TEXT,
      ip TEXT,
      user_agent TEXT,
      timestamp BIGINT DEFAULT 0
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS audit (
      id BIGSERIAL PRIMARY KEY,
      t BIGINT DEFAULT 0,
      ip TEXT,
      act TEXT NOT NULL,
      detail TEXT
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`;
  pgReady = true;
}

function getPG() {
  if (!pgReady) {
    if (!pgInitPromise) pgInitPromise = initPG().catch(e => { pgInitPromise = null; throw e; });
    return pgInitPromise.then(() => sql);
  }
  return Promise.resolve(sql);
}

function rowToFile(r) {
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    original: r.original,
    mimetype: r.mimetype,
    size: Number(r.size || 0),
    expiryAt: r.expiry_at === null || r.expiry_at === undefined ? null : Number(r.expiry_at),
    deleteToken: r.delete_token,
    createdAt: Number(r.created_at || 0),
    views: Number(r.views || 0),
    pw: r.pw,
    driver: r.driver,
    stored: r.stored,
    directUrl: r.direct_url,
    mirrorUrl: r.mirror_url,
    compressed: Number(r.compressed || 0)
  };
}

// ===== JSON dev backend =====
function devLoad() {
  if (devData) return devData;
  try {
    devData = JSON.parse(fs.readFileSync(DEV_DB_PATH, 'utf8'));
  } catch {
    devData = { files: [], albums: [], notifications: [], analytics: [], audit: [], cache: {}, auditSeq: 0 };
  }
  for (const k of ['files', 'albums', 'notifications', 'analytics', 'audit']) if (!Array.isArray(devData[k])) devData[k] = [];
  if (!devData.cache || typeof devData.cache !== 'object') devData.cache = {};
  if (!Number.isInteger(devData.auditSeq)) devData.auditSeq = 0;
  return devData;
}

function devSave() {
  if (devSaveTimer) return;
  devSaveTimer = setTimeout(() => {
    devSaveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DEV_DB_PATH, JSON.stringify(devData));
    } catch (e) { /* dev only */ }
  }, 120);
}

// ===== الواجهة الموحدة =====
const fileDB = {
  async insert(f) {
    if (isRemote()) {
      const s = await getPG();
      await s`
        INSERT INTO files (id, slug, original, mimetype, size, expiry_at, delete_token, created_at, views, pw, driver, stored, direct_url, mirror_url, compressed)
        VALUES (${f.id}, ${f.slug}, ${f.original}, ${f.mimetype}, ${f.size || 0}, ${f.expiryAt ?? null}, ${f.deleteToken}, ${f.createdAt || Date.now()}, ${f.views || 0}, ${f.pw ?? null}, ${f.driver}, ${f.stored ?? null}, ${f.directUrl ?? null}, ${f.mirrorUrl ?? null}, ${f.compressed || 0})`;
      return;
    }
    const d = devLoad();
    if (d.files.some(x => x.id === f.id)) throw new Error('duplicate id');
    d.files.push({ ...f });
    devSave();
  },

  async getById(id) {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM files WHERE id = ${id} LIMIT 1`;
      return rowToFile(rows[0]);
    }
    return devLoad().files.find(x => x.id === id) || null;
  },

  async getBySlug(slug) {
    const l = String(slug || '').toLowerCase();
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM files WHERE slug = ${l} LIMIT 1`;
      return rowToFile(rows[0]);
    }
    return devLoad().files.find(x => (x.slug || '').toLowerCase() === l) || null;
  },

  async findByKey(key) {
    return (await this.getById(key)) || (await this.getBySlug(key));
  },

  async getAll(limit = 500, offset = 0) {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM files ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return rows.map(rowToFile);
    }
    return devLoad().files.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(offset, offset + limit);
  },

  async search(query, limit = 500) {
    const q = `%${String(query || '').toLowerCase()}%`;
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM files WHERE LOWER(original) LIKE ${q} OR LOWER(COALESCE(slug,'')) LIKE ${q} OR LOWER(id) LIKE ${q} ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map(rowToFile);
    }
    return devLoad().files.filter(f =>
      (f.original || '').toLowerCase().includes(q.slice(1, -1)) ||
      (f.slug || '').toLowerCase().includes(q.slice(1, -1)) ||
      (f.id || '').toLowerCase().includes(q.slice(1, -1))
    ).slice(0, limit);
  },

  async update(id, updates) {
    const map = { pw: 'pw', views: 'views', driver: 'driver', stored: 'stored', directUrl: 'direct_url', mirrorUrl: 'mirror_url', slug: 'slug' };
    const keys = Object.keys(updates).filter(k => map[k] && updates[k] !== undefined);
    if (!keys.length) return;
    if (isRemote()) {
      await getPG();
      const setFrag = sql.join(keys.map(k => sql`${sql.ident(map[k])} = ${updates[k]}`), sql`, `);
      await sql`UPDATE files SET ${setFrag} WHERE id = ${id}`;
      return;
    }
    const d = devLoad();
    const f = d.files.find(x => x.id === id);
    if (f) { for (const k of keys) f[k] = updates[k]; devSave(); }
  },

  async delete(id) {
    if (isRemote()) {
      const s = await getPG();
      await s`DELETE FROM files WHERE id = ${id}`;
      return;
    }
    const d = devLoad();
    const i = d.files.findIndex(x => x.id === id);
    if (i >= 0) { d.files.splice(i, 1); devSave(); }
  },

  async incrementViews(id) {
    if (isRemote()) {
      const s = await getPG();
      await s`UPDATE files SET views = views + 1 WHERE id = ${id}`;
      return;
    }
    const f = devLoad().files.find(x => x.id === id);
    if (f) { f.views = (f.views || 0) + 1; devSave(); }
  },

  async getExpired() {
    const now = Date.now();
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM files WHERE expiry_at IS NOT NULL AND expiry_at < ${now} LIMIT 500`;
      return rows.map(rowToFile);
    }
    return devLoad().files.filter(f => f.expiryAt && f.expiryAt < now);
  },

  async count() {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT COUNT(*)::int AS c FROM files`;
      return rows[0].c;
    }
    return devLoad().files.length;
  },

  async getTotalViews() {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT COALESCE(SUM(views),0)::int AS t FROM files`;
      return rows[0].t;
    }
    return devLoad().files.reduce((a, f) => a + (f.views || 0), 0);
  },

  async getTotalBytes() {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT COALESCE(SUM(size),0)::bigint AS t FROM files`;
      return Number(rows[0].t || 0);
    }
    return devLoad().files.reduce((a, f) => a + (f.size || 0), 0);
  },

  async getTop(limit = 5) {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM files ORDER BY views DESC LIMIT ${limit}`;
      return rows.map(rowToFile);
    }
    return devLoad().files.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, limit);
  }
};

const albumDB = {
  async insert(album) {
    if (isRemote()) {
      const s = await getPG();
      await s`INSERT INTO albums (id, files, created_at, expiry_at) VALUES (${album.id}, ${JSON.stringify(album.files)}, ${album.createdAt || Date.now()}, ${album.expiryAt ?? null})`;
      return;
    }
    devLoad().albums.push({ id: album.id, files: album.files, createdAt: album.createdAt || Date.now(), expiryAt: album.expiryAt ?? null });
    devSave();
  },

  async getById(id) {
    let row = null;
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM albums WHERE id = ${id} LIMIT 1`;
      row = rows[0];
      if (row) return { id: row.id, files: JSON.parse(row.files), createdAt: Number(row.created_at), expiryAt: row.expiry_at === null ? null : Number(row.expiry_at) };
      return null;
    }
    row = devLoad().albums.find(x => x.id === id) || null;
    return row;
  },

  async delete(id) {
    if (isRemote()) {
      const s = await getPG();
      await s`DELETE FROM albums WHERE id = ${id}`;
      return;
    }
    const d = devLoad();
    const i = d.albums.findIndex(x => x.id === id);
    if (i >= 0) { d.albums.splice(i, 1); devSave(); }
  },

  async getExpired() {
    const now = Date.now();
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM albums WHERE expiry_at IS NOT NULL AND expiry_at < ${now} LIMIT 500`;
      return rows.map(r => ({ id: r.id, files: JSON.parse(r.files), createdAt: Number(r.created_at), expiryAt: Number(r.expiry_at) }));
    }
    return devLoad().albums.filter(a => a.expiryAt && a.expiryAt < now);
  }
};

const notificationDB = {
  async insert(n) {
    if (isRemote()) {
      const s = await getPG();
      await s`INSERT INTO notifications (id, type, message, priority, target, read, created_at) VALUES (${n.id}, ${n.type}, ${n.message}, ${n.priority || 'medium'}, ${n.target || 'admin'}, 0, ${Date.now()})`;
      return;
    }
    devLoad().notifications.push({ id: n.id, type: n.type, message: n.message, priority: n.priority || 'medium', target: n.target || 'admin', read: 0, createdAt: Date.now() });
    devSave();
  },

  async getAll(limit = 100) {
    if (isRemote()) {
      const s = await getPG();
      return await s`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return devLoad().notifications.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },

  async getUnread(limit = 100) {
    if (isRemote()) {
      const s = await getPG();
      return await s`SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT ${limit}`;
    }
    return devLoad().notifications.filter(n => !n.read).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  },

  async markAllRead() {
    if (isRemote()) {
      const s = await getPG();
      await s`UPDATE notifications SET read = 1 WHERE read = 0`;
      return;
    }
    devLoad().notifications.forEach(n => { n.read = 1; });
    devSave();
  },

  async cleanup() {
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`DELETE FROM notifications WHERE created_at < ${week} RETURNING id`;
      return rows.length;
    }
    const d = devLoad();
    const before = d.notifications.length;
    d.notifications = d.notifications.filter(n => n.createdAt >= week);
    devSave();
    return before - d.notifications.length;
  }
};

const analyticsDB = {
  async track(event, fileId, ip, userAgent) {
    const id = crypto.randomBytes(8).toString('hex');
    if (isRemote()) {
      const s = await getPG();
      await s`INSERT INTO analytics (id, event, file_id, ip, user_agent, timestamp) VALUES (${id}, ${event}, ${fileId ?? null}, ${(ip || '').slice(0, 64)}, ${(userAgent || '').slice(0, 200)}, ${Date.now()})`;
      return;
    }
    devLoad().analytics.push({ id, event, fileId, ip, userAgent, timestamp: Date.now() });
    devSave();
  },

  async getStats(hours = 24) {
    const since = Date.now() - hours * 3600 * 1000;
    if (isRemote()) {
      const s = await getPG();
      return await s`SELECT event, COUNT(*)::int AS count FROM analytics WHERE timestamp > ${since} GROUP BY event`;
    }
    const map = {};
    devLoad().analytics.filter(a => a.timestamp > since).forEach(a => { map[a.event] = (map[a.event] || 0) + 1; });
    return Object.entries(map).map(([event, count]) => ({ event, count }));
  },

  async cleanup() {
    const month = Date.now() - 30 * 24 * 3600 * 1000;
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`DELETE FROM analytics WHERE timestamp < ${month} RETURNING id`;
      return rows.length;
    }
    const d = devLoad();
    const before = d.analytics.length;
    d.analytics = d.analytics.filter(a => a.timestamp >= month);
    devSave();
    return before - d.analytics.length;
  }
};

const auditDB = {
  async log(act, ip, detail) {
    if (isRemote()) {
      const s = await getPG();
      await s`INSERT INTO audit (t, ip, act, detail) VALUES (${Date.now()}, ${(ip || 'unknown').slice(0, 64)}, ${act}, ${JSON.stringify(detail || {})})`;
      return;
    }
    const d = devLoad();
    d.auditSeq = (d.auditSeq || 0) + 1;
    d.audit.push({ id: d.auditSeq, t: Date.now(), ip: (ip || 'unknown').slice(0, 64), act, detail: JSON.stringify(detail || {}) });
    if (d.audit.length > 5000) d.audit = d.audit.slice(-4000);
    devSave();
  },

  async getAll(limit = 200, offset = 0) {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM audit ORDER BY t DESC LIMIT ${limit} OFFSET ${offset}`;
      return rows.map(r => ({ id: r.id, t: Number(r.t), ip: r.ip, act: r.act, detail: parseDetail(r.detail) }));
    }
    return devLoad().audit.slice().sort((a, b) => b.t - a.t).slice(offset, offset + limit).map(j => ({ ...j, detail: parseDetail(j.detail) }));
  },

  async search(query, limit = 200) {
    const all = await this.getAll(2000);
    const q = String(query || '').toLowerCase();
    if (!q) return all.slice(0, limit);
    return all.filter(e => JSON.stringify(e).toLowerCase().includes(q)).slice(0, limit);
  },

  async cleanup() {
    const month = Date.now() - 30 * 24 * 3600 * 1000;
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`DELETE FROM audit WHERE t < ${month} RETURNING id`;
      return rows.length;
    }
    const d = devLoad();
    const before = d.audit.length;
    d.audit = d.audit.filter(a => a.t >= month);
    devSave();
    return before - d.audit.length;
  }
};

function parseDetail(x) {
  try { return JSON.parse(x || '{}'); } catch { return {}; }
}

const cacheDB = {
  async set(key, value, ttlMs = 3600000) {
    const expiresAt = Date.now() + ttlMs;
    const v = JSON.stringify(value);
    if (isRemote()) {
      const s = await getPG();
      await s`INSERT INTO cache (key, value, expires_at) VALUES (${key}, ${v}, ${expiresAt}) ON CONFLICT (key) DO UPDATE SET value = ${v}, expires_at = ${expiresAt}`;
      return;
    }
    devLoad().cache[key] = { value: v, expiresAt };
    devSave();
  },

  async get(key) {
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`SELECT * FROM cache WHERE key = ${key} LIMIT 1`;
      const row = rows[0];
      if (!row) return null;
      if (Number(row.expires_at) < Date.now()) { await this.delete(key); return null; }
      try { return JSON.parse(row.value); } catch { return null; }
    }
    const item = devLoad().cache[key];
    if (!item) return null;
    if (item.expiresAt < Date.now()) { delete devLoad().cache[key]; devSave(); return null; }
    try { return JSON.parse(item.value); } catch { return null; }
  },

  async delete(key) {
    if (isRemote()) {
      const s = await getPG();
      await s`DELETE FROM cache WHERE key = ${key}`;
      return;
    }
    delete devLoad().cache[key];
    devSave();
  },

  async cleanup() {
    const now = Date.now();
    if (isRemote()) {
      const s = await getPG();
      const rows = await s`DELETE FROM cache WHERE expires_at < ${now} RETURNING key`;
      return rows.length;
    }
    const d = devLoad();
    let n = 0;
    for (const k of Object.keys(d.cache)) { if (d.cache[k].expiresAt < now) { delete d.cache[k]; n++; } }
    devSave();
    return n;
  }
};

// ===== الصيانة الدورية (تعمل من cron أو عند التشغيل) =====
async function runMaintenance() {
  const out = { expiredFiles: 0, expiredAlbums: 0, cache: 0, notifications: 0, analytics: 0, audit: 0 };
  try {
    const expired = await fileDB.getExpired();
    for (const f of expired) {
      await fileDB.delete(f.id);
      await auditDB.log('expired', 'cron', { id: f.id, key: f.slug || f.id, name: f.original, driver: f.driver || '?' }).catch(() => {});
      out.expiredFiles++;
    }
    const expiredAlbums = await albumDB.getExpired();
    for (const a of expiredAlbums) { await albumDB.delete(a.id); out.expiredAlbums++; }
    out.cache = await cacheDB.cleanup();
    out.notifications = await notificationDB.cleanup();
    out.analytics = await analyticsDB.cleanup();
    out.audit = await auditDB.cleanup();
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  return out;
}

module.exports = {
  isRemote,
  fileDB,
  albumDB,
  notificationDB,
  analyticsDB,
  auditDB,
  cacheDB,
  runMaintenance,
  DEV_DB_PATH
};
