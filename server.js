const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

// استيراد الوحدات الجديدة
const { initDB, fileDB, albumDB, auditDB, runMaintenance } = require('./utils/db');
const { startHealthMonitoring, getHealthStatus } = require('./utils/health');
const { notifyUpload, notifyDelete, notifyExpiry, notifySystem } = require('./utils/notifications');
const cache = require('./utils/cache');
const { handleRangeRequest, handleStreamRange } = require('./utils/resume');
const { generateShareLinks, generateShareButton } = require('./utils/social');
const storage = require('./storage');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors({ origin: '*', exposedHeaders: ['X-Powered-By'] }));
app.use(express.json());

// ===== هيدرات أمان عامة =====
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN'
  });
  next();
});

// ===== حد معدل بسيط =====
const RL = new Map();
const RL_MAX = parseInt(process.env.RATE_MAX || '60', 10);
const RL_WIN = 10 * 60 * 1000;
function rateLimit(req, res, next) {
  try {
    const fwd = req.get('x-forwarded-for') || '';
    const ip = ((req.ip || fwd.split(',')[0] || 'unknown') + '').slice(0, 64);
    const now = Date.now();
    let rec = RL.get(ip);
    if (!rec || now - rec.t > RL_WIN) rec = { n: 0, t: now };
    rec.n++;
    RL.set(ip, rec);
    if (RL.size > 5000) {
      for (const [k, v] of RL) { if (now - v.t > RL_WIN) RL.delete(k); if (RL.size < 4000) break; }
    }
    if (rec.n > RL_MAX) return res.status(429).json({ error: 'Too many requests — try again in a few minutes' });
    next();
  } catch { next(); }
}

// ===== تحقق من الهوست =====
function safeHost(h) {
  h = String(h || '').split(',')[0].trim().toLowerCase();
  if (!h || h.length > 253 || !/^[a-z0-9.-]+(?::\d+)?$/.test(h)) return '';
  return h;
}

// ===== تحقق من توكن الأدمن =====
function isAdminReq(req) {
  const tok = process.env.ADMIN_TOKEN;
  if (!tok) return false;
  const got = String(req.get('x-admin-token') || req.query.admin || '');
  try {
    const a = Buffer.from(got), b = Buffer.from(tok);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

const RESERVED_SLUGS = new Set(['api', 'health', 'v', 'e', 'd', 'i', 'a', 'admin', 'config', 'docs', 'stats', 'llms.txt']);

// ===== المتغيرات =====
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '200', 10);
const BRAND = 'MINYAWE-LINK | ELMINYAWE';

// ===== تهيئة قاعدة البيانات =====
initDB();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ===== بدء مراقبة الصحة =====
startHealthMonitoring(60000);

// ===== بدء الصيانة الدورية =====
setInterval(runMaintenance, 5 * 60 * 1000);
runMaintenance();

// ===== دوال مساعدة =====
function clientIp(req) {
  try {
    const fwd = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
    return ((fwd || req.ip || 'unknown') + '').slice(0, 64);
  } catch { return 'unknown'; }
}

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}

function verifyPw(pw, stored) {
  try {
    const [salt, h] = String(stored || '').split(':');
    if (!salt || !h) return false;
    const a = Buffer.from(crypto.scryptSync(String(pw || ''), salt, 32).toString('hex'));
    const b = Buffer.from(h);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function needPw(meta, req) {
  if (!meta || !meta.pw) return false;
  return !verifyPw(req.query.pw, meta.pw);
}

function dispDriver(d) {
  d = String(d || '').toLowerCase();
  if (d.includes('local') || d.includes('vault')) return 'MINYAWE-VAULT';
  return 'MINYAWE-CLOUD';
}

const EXT_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.html': 'text/html' };

function mimeOf(original, fallback) {
  if (fallback && fallback !== 'application/octet-stream') return fallback;
  return EXT_MIME[path.extname(original || '').toLowerCase()] || fallback || 'application/octet-stream';
}

function kindOf(meta) {
  const mt = mimeOf(meta.original, meta.mimetype);
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  const e = path.extname(meta.original || '').toLowerCase();
  if (mt.startsWith('text/') || mt === 'application/json' || ['.md', '.json', '.js', '.py', '.css', '.html', '.csv', '.log', '.xml', '.yml', '.yaml', '.sh', '.txt'].includes(e)) return 'text';
  return 'file';
}

function fixName(n) {
  try {
    const f = Buffer.from(String(n), 'latin1').toString('utf8');
    if (f !== String(n) && !f.includes('�')) return f;
  } catch {}
  return String(n);
}

const SLUG_RE = /^[a-z0-9-_]{3,30}$/i;

function slugTaken(s) {
  const l = String(s).toLowerCase();
  return !!fileDB.getBySlug(l);
}

function findFile(key) {
  return fileDB.findByKey(key);
}

function fileLinks(req, id, meta) {
  const b = baseUrl(req), key = meta.slug || id;
  const ext = path.extname(meta.original || '').replace(/^\./, '').toLowerCase() || 'bin';
  return {
    short: `${b}/i/${key}`,
    view: `${b}/v/${key}`,
    stream: `${b}/e/${key}.${ext}`,
    download: `${b}/d/${key}.${ext}`
  };
}

function parseKey(s) {
  const m = String(s).match(/^(.+)\.([A-Za-z0-9]{1,8})$/);
  if (m) {
    const base = m[1], bl = base.toLowerCase();
    const exists = fileDB.getById(base) || fileDB.getBySlug(bl);
    if (exists) return { key: base, ext: m[2].toLowerCase() };
  }
  return { key: String(s), ext: null };
}

function realExt(meta) {
  return (path.extname(meta.original || '').replace(/^\./, '').toLowerCase()) || 'bin';
}

function parseExpiry(v) {
  const now = Date.now();
  const MONTH = 30 * 24 * 3600 * 1000;
  if (v === '1h') return now + 3600 * 1000;
  if (v === '7d') return now + 7 * 24 * 3600 * 1000;
  if (v === '30d' || v === 'never') return now + MONTH;
  return now + 24 * 3600 * 1000;
}

const BLOCKED = ['.exe', '.scr', '.com', '.bat', '.ps1', '.vbs', '.jar', '.msi', '.dll'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 10, fields: 8, parts: 20, fieldNameSize: 100, fieldSize: 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED.includes(ext)) return cb(new Error('File type blocked by MINYAWE'));
    cb(null, true);
  }
});

function baseUrl(req) {
  const envBase = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(envBase)) return envBase;
  let proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') proto = req.protocol === 'https' ? 'https' : 'http';
  const host = safeHost(req.get('host'));
  if (!host) return `${proto}://localhost:${PORT}`;
  return `${proto}://${host}`;
}

function isActiveContent(ct) {
  return /text\/html|image\/svg|application\/xhtml|text\/xml|application\/xml/i.test(String(ct || ''));
}

function localFilePath(meta) {
  if (!meta || meta.driver !== 'local') return null;
  try {
    const p = path.join(UPLOAD_DIR, String(meta.stored || ''));
    if (!p.startsWith(UPLOAD_DIR + path.sep) && p !== UPLOAD_DIR) return null;
    if (!fs.existsSync(p)) return null;
    return p;
  } catch { return null; }
}

async function loadMeta(key, req) {
  const found = findFile(key);
  if (!found) return { err: 404 };
  const meta = found;
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver === 'local') {
      const local = storage.getDriver('local');
      if (local) local.deleteFile(meta.stored);
    }
    auditDB.log('expired', req, { id: meta.id, key: meta.slug || meta.id, name: meta.original, driver: meta.driver || '?', lazy: true });
    fileDB.delete(meta.id);
    notifyExpiry(meta.id, meta.original);
    return { err: 410 };
  }
  return { meta };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function proxyFile(meta, req, res, disposition) {
  const targets = [meta.directUrl, meta.mirrorUrl].filter(Boolean);
  let lastStatus = 502;
  for (const target of targets) {
    try {
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const r = await fetch(target, { headers });
      if (r.status === 416) {
        const cr416 = r.headers.get('content-range');
        res.status(416);
        if (cr416) res.set('Content-Range', cr416);
        res.set({ 'Accept-Ranges': 'bytes', 'X-Powered-By': BRAND });
        try { r.body.cancel(); } catch {}
        return res.send('Range Not Satisfiable | MINYAWE-LINK');
      }
      if (!r.ok && r.status !== 206) { lastStatus = r.status; continue; }
      res.status(r.status);
      const upstreamCT = r.headers.get('content-type') || '';
      const effCT = (!upstreamCT || upstreamCT.includes('octet-stream')) ? mimeOf(meta.original, meta.mimetype) : upstreamCT;
      const hdrs = {
        'Content-Type': effCT,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.original)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Powered-By': BRAND
      };
      if (disposition === 'inline' && isActiveContent(effCT)) hdrs['Content-Security-Policy'] = 'sandbox';
      res.set(hdrs);
      const cl = r.headers.get('content-length'); if (cl) res.set('Content-Length', cl);
      const cr = r.headers.get('content-range'); if (cr) res.set('Content-Range', cr);
      return Readable.fromWeb(r.body).pipe(res);
    } catch (e) { lastStatus = 502; continue; }
  }
  return res.status(lastStatus === 404 ? 404 : 502).send('upstream error | MINYAWE-LINK');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== ROUTES =====
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  const health = getHealthStatus();
  res.json({
    status: 'MINYAWE-LINK OK',
    version: '7.0',
    health: health.status,
    uptime: process.uptime()
  });
});

app.get('/api/config', (req, res) => {
  let disk = null;
  try {
    const st = fs.statfsSync(DATA_DIR);
    disk = { freeMB: Math.floor(st.bavail * st.bsize / 1048576), totalMB: Math.floor(st.blocks * st.bsize / 1048576) };
  } catch {}
  res.json({
    brand: BRAND,
    maxMB: MAX_MB,
    maxExpiryDays: 30,
    storage: dispDriver('catbox'),
    chain: storage.getActiveDrivers().map(dispDriver),
    disk,
    direct: true,
    features: { 
      multiUpload: true, 
      password: true, 
      adminFiles: true, 
      audit: true, 
      backup: true, 
      themes: ['dark', 'light'],
      notifications: true,
      healthMonitoring: true,
      cache: true,
      resumeDownload: true,
      socialSharing: true,
      multiCloud: true
    },
    docs: `${baseUrl(req)}/api/docs`,
    agents: `${baseUrl(req)}/llms.txt`
  });
});

app.get('/api/docs', (req, res) => {
  const b = baseUrl(req);
  res.json({
    name: 'MINYAWE-LINK',
    by: 'ELMINYAWE',
    version: '7.0',
    base: b,
    auth: 'none',
    limits: { maxMB: MAX_MB, maxExpiryDays: 30, expiryValues: ['1h', '24h', '7d', '30d'], blockedExtensions: BLOCKED },
    storage: { 
      chain: storage.getActiveDrivers().map(dispDriver), 
      note: 'Multi-cloud storage: catbox -> 0x0.st -> file.io -> local. All free, no account needed.' 
    },
    features: {
      database: 'SQLite with WAL mode',
      notifications: 'Real-time system notifications',
      healthMonitoring: 'Automatic health checks every 60s',
      cache: 'In-memory + database caching',
      resumeDownload: 'Range request support for downloads',
      socialSharing: 'Share to WhatsApp, Telegram, X, Facebook, LinkedIn, Reddit, Email, SMS',
      multiCloud: 'Automatic fallback between storage providers'
    },
    endpoints: [
      { method: 'POST', path: '/api/upload', fields: { file: 'binary (multipart field "file")', expiry: '1h|24h|7d|30d (default 24h)', alias: 'optional slug a-z0-9-_ (3-30)', password: 'optional (min 3 chars)' }, returns: ['id', 'slug', 'url', 'short', 'view', 'stream', 'download', 'views', 'expiryAt', 'locked', 'deleteToken'] },
      { method: 'POST', path: '/api/album', fields: { files: 'up to 10 binaries (multipart field "files")', expiry: 'same as upload' }, returns: ['id', 'url', 'count', 'files[]'] },
      { method: 'GET', path: '/a/:id', desc: 'album page' },
      { method: 'GET', path: '/api/stats', desc: 'dashboard stats' },
      { method: 'GET', path: '/v/:id', desc: 'preview page with player' },
      { method: 'GET', path: '/e/:id.:ext', desc: 'direct stream with Range support' },
      { method: 'GET', path: '/d/:id.:ext', desc: 'direct download with resume support' },
      { method: 'GET', path: '/i/:id', desc: 'short link' },
      { method: 'DELETE', path: '/api/:id?token=', desc: 'delete file' },
      { method: 'GET', path: '/api/notifications', desc: 'get notifications' },
      { method: 'GET', path: '/api/health', desc: 'health status' },
      { method: 'GET', path: '/api/cache/stats', desc: 'cache statistics' }
    ],
    examples: {
      curl: `curl -F "file=@song.mp3" -F "expiry=30d" -F "password=s3cret" "${b}/api/upload"`,
      sharex: { RequestURL: `${b}/api/upload`, FileFormName: 'file', URL: '$json:url$' }
    }
  });
});

app.get('/llms.txt', (req, res) => {
  const b = baseUrl(req);
  res.type('text/plain').send(
`# MINYAWE-LINK by ELMINYAWE
Direct file hosting: upload image/audio/video/any file, get permanent direct links.
No auth. Max ${MAX_MB}MB per file. Expiry: 1h|24h|7d|30d (default 24h, max 30 days).
Storage chain (all free, no account): ${storage.getActiveDrivers().map(dispDriver).join(' -> ')}.

## Features
- SQLite database with WAL mode
- Multi-cloud storage with automatic fallback
- Real-time notifications
- Health monitoring
- In-memory + database caching
- Resume download support
- Social sharing (WhatsApp, Telegram, X, Facebook, LinkedIn, Reddit, Email, SMS)

## Upload
POST ${b}/api/upload (multipart: file=<binary>, expiry=30d, alias=my-song [optional], password=s3cret [optional])
=> JSON: { id, slug, url, short, view, stream, download, views, expiryAt, locked, deleteToken }

## Album
POST ${b}/api/album (multipart: files=<binaries>, expiry=7d)
=> JSON: { id, url: ${b}/a/:id, count, files[] }

## Admin (header x-admin-token or ?admin=TOKEN)
- GET ${b}/api/admin/ping — verify token
- POST ${b}/api/:id/password {password} — set/change/remove password
- GET ${b}/api/admin/files?q= — full list + search
- GET ${b}/api/admin/audit?q=&limit= — operation log
- GET ${b}/api/admin/backup — ZIP download

## Stats & Monitoring
GET ${b}/api/stats => { files, totalViews, totalBytes, byKind, top[5] }
GET ${b}/api/health => { status, uptime, health }
GET ${b}/api/notifications => { notifications[] }
GET ${b}/api/cache/stats => { memory, db }

## Links (replace :id)
- Preview page: ${b}/v/:id
- Direct stream (Range support): ${b}/e/:id.:ext
- Force download (resume support): ${b}/d/:id.:ext
- Short redirect: ${b}/i/:id

## Manage
- DELETE ${b}/api/:id?token=DELETE_TOKEN
- Limits: ${b}/api/config | Full spec: ${b}/api/docs | Health: ${b}/health`
  );
});

// ===== نواة الرفع المشتركة =====
async function persistUpload({ buffer, original, mimetype, size, expiryAt, alias, password }, req) {
  original = fixName(original);
  original = String(original).replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0, 180);
  
  let slug = null;
  if (alias !== undefined && alias !== null && String(alias).trim() !== '') {
    const a = String(alias).trim();
    if (!SLUG_RE.test(a)) {
      const err = new Error('bad alias (3-30 chars: a-z 0-9 - _)');
      err.code = 400; throw err;
    }
    if (RESERVED_SLUGS.has(a.toLowerCase())) {
      const err = new Error('alias reserved');
      err.code = 400; throw err;
    }
    if (slugTaken(a)) {
      const err = new Error('alias taken');
      err.code = 409; throw err;
    }
    slug = a.toLowerCase();
  }
  
  let id = crypto.randomBytes(4).toString('hex');
  while (fileDB.getById(id)) id = crypto.randomBytes(4).toString('hex');
  
  const buf = buffer;
  const mtype = mimeOf(original, mimetype);
  
  // استخدام نظام التخزين المتعدد
  const result = await storage.uploadWithFallback(buf, original, id);
  
  const meta = {
    id,
    slug,
    original,
    mimetype: mtype,
    size,
    expiryAt,
    deleteToken: crypto.randomBytes(8).toString('hex'),
    createdAt: Date.now(),
    views: 0,
    driver: result.driver,
    stored: result.stored,
    directUrl: result.directUrl,
    mirrorUrl: result.mirrorUrl || null,
    compressed: result.compressed || 0
  };
  
  if (password !== undefined && password !== null && String(password) !== '') {
    const pw = String(password).slice(0, 128);
    if (pw.length < 3) { const err = new Error('password too short (min 3 chars)'); err.code = 400; throw err; }
    meta.pw = hashPw(pw);
  }
  
  fileDB.insert(meta);
  notifyUpload(id, original);
  auditDB.log('upload', req, { id, key: slug || id, name: original, size, driver: result.driver });
  
  return { id, meta };
}

function apiErr(res, e) {
  let code = (e && Number.isInteger(e.code)) ? e.code : 500;
  let msg = (e && e.message) || 'error';
  if (e && e.code === 'LIMIT_FILE_SIZE') { code = 413; msg = `File too large (max ${MAX_MB}MB)`; }
  else if (code >= 500) { try { console.error('  [err]', String(msg).slice(0, 300)); } catch {} msg = 'server error — try again'; }
  res.status(code).json({ error: msg });
}

// ===== رفع ملف =====
app.post('/api/upload', rateLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const expiryAt = parseExpiry(req.body.expiry || req.query.expiry || '24h');
    const { id, meta } = await persistUpload({
      buffer: req.file.buffer, original: req.file.originalname,
      mimetype: req.file.mimetype, size: req.file.size,
      expiryAt, alias: req.body.alias || req.query.alias,
      password: req.body.password || req.query.password
    }, req);
    
    res.json({
      id, slug: meta.slug || null,
      url: meta.directUrl,
      ...fileLinks(req, id, meta),
      mirror: meta.mirrorUrl,
      expiryAt, deleteToken: meta.deleteToken, views: 0,
      locked: !!meta.pw,
      powered_by: BRAND
    });
  } catch (e) { apiErr(res, e); }
});

// ===== ألبوم =====
app.post('/api/album', rateLimit, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files (max 10)' });
    const expiryAt = parseExpiry(req.body.expiry || req.query.expiry || '24h');
    const out = [];
    for (const f of req.files) {
      const { id, meta } = await persistUpload({
        buffer: f.buffer, original: f.originalname,
        mimetype: f.mimetype, size: f.size, expiryAt
      }, req);
      out.push({ id, name: f.originalname, size: f.size, views: 0, ...fileLinks(req, id, meta) });
    }
    let aid = crypto.randomBytes(4).toString('hex');
    while (albumDB.getById(aid)) aid = crypto.randomBytes(4).toString('hex');
    albumDB.insert({ id: aid, files: out.map(o => o.id), createdAt: Date.now(), expiryAt });
    auditDB.log('album', req, { id: aid, count: out.length });
    res.json({ id: aid, url: `${baseUrl(req)}/a/${aid}`, count: out.length, expiryAt, files: out, powered_by: BRAND });
  } catch (e) { apiErr(res, e); }
});

// ===== فحص وجود ملفات =====
app.get('/api/check', (req, res) => {
  const now = Date.now();
  const ids = String(req.query.ids || '').split(',').map(s => s.trim().slice(0, 64)).filter(Boolean).slice(0, 20);
  const ok = {};
  for (const key of ids) {
    const found = findFile(key);
    ok[key] = !!(found && (!found.expiryAt || found.expiryAt > now));
  }
  res.json({ ok });
});

// ===== إحصائيات =====
app.get('/api/stats', (req, res) => {
  const now = Date.now();
  const isAdmin = isAdminReq(req);
  const lim = isAdmin ? Math.min(Math.max(parseInt(req.query.limit || '5', 10) || 5, 1), 100) : 5;
  
  const files = fileDB.getAll(1000);
  const live = files.filter(m => !m.expiryAt || m.expiryAt > now);
  const byKind = { image: 0, audio: 0, video: 0, text: 0, file: 0 };
  let totalViews = 0, totalBytes = 0;
  
  live.forEach(m => {
    totalViews += m.views || 0;
    totalBytes += m.size || 0;
    try { const k = kindOf(m); if (byKind[k] !== undefined) byKind[k]++; } catch {}
  });
  
  const top = live.map(m => isAdmin
    ? { id: m.id, key: m.slug || m.id, name: m.original, views: m.views || 0, size: m.size, view: `${baseUrl(req)}/v/${m.slug || m.id}` }
    : { views: m.views || 0, size: m.size }
  ).sort((a, b) => b.views - a.views).slice(0, lim);
  
  res.json({ files: live.length, totalViews, totalBytes, byKind, top, admin: !!isAdmin, powered_by: BRAND });
});

// ===== لينك مباشر =====
app.get('/i/:id', async (req, res) => {
  const found = findFile(req.params.id);
  if (!found) return res.status(404).send('Not found | MINYAWE-LINK');
  const meta = found;
  
  if (meta.expiryAt && Date.now() > meta.expiryAt) {
    if (meta.driver === 'local') {
      const local = storage.getDriver('local');
      if (local) local.deleteFile(meta.stored);
    }
    auditDB.log('expired', req, { id: meta.id, key: meta.slug || meta.id, name: meta.original, driver: meta.driver || '?', lazy: true });
    fileDB.delete(meta.id);
    notifyExpiry(meta.id, meta.original);
    return res.status(410).send('Expired | MINYAWE-LINK');
  }
  
  if (needPw(meta, req)) return res.status(403).send('Locked — password required (?pw=) | MINYAWE-LINK');
  
  res.set({
    'X-Powered-By': BRAND,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes'
  });
  
  if (meta.driver !== 'local' && meta.directUrl) {
    return res.redirect(302, meta.directUrl);
  }
  
  const filePath = localFilePath(meta);
  if (!filePath) return res.status(410).send('Gone | MINYAWE-LINK');
  
  const ct = mimeOf(meta.original, meta.mimetype);
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(meta.original)}"`);
  res.type(ct);
  if (isActiveContent(ct)) res.set('Content-Security-Policy', 'sandbox');
  res.sendFile(filePath);
});

// ===== بث مباشر مع دعم Range =====
app.get('/e/:file', async (req, res) => {
  const { key, ext } = parseKey(req.params.file);
  const { meta, err } = await loadMeta(key, req);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  if (needPw(meta, req)) return res.status(403).send('Locked — password required (?pw=) | MINYAWE-LINK');
  
  const rx = realExt(meta);
  const keepPw = req.query.pw ? '?pw=' + encodeURIComponent(req.query.pw) : '';
  if (ext && ext !== rx) return res.redirect(301, `/e/${meta.slug || meta.id}.${rx}${keepPw}`);
  
  fileDB.incrementViews(meta.id);
  
  if (meta.driver !== 'local' && meta.directUrl) return proxyFile(meta, req, res, 'inline');
  
  const filePath = localFilePath(meta);
  if (!filePath) return res.status(410).send('Gone | MINYAWE-LINK');
  
  const ct = mimeOf(meta.original, meta.mimetype);
  
  // استخدام نظام Range للبث
  handleStreamRange(req, res, filePath, meta.original, ct);
});

// ===== تحميل مباشر مع دعم الاستئناف =====
app.get('/d/:file', async (req, res) => {
  const { key, ext } = parseKey(req.params.file);
  const { meta, err } = await loadMeta(key, req);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  if (needPw(meta, req)) return res.status(403).send('Locked — password required (?pw=) | MINYAWE-LINK');
  
  const rx = realExt(meta);
  const keepPw2 = req.query.pw ? '?pw=' + encodeURIComponent(req.query.pw) : '';
  if (ext && ext !== rx) return res.redirect(301, `/d/${meta.slug || meta.id}.${rx}${keepPw2}`);
  
  if (meta.driver !== 'local' && meta.directUrl) return proxyFile(meta, req, res, 'attachment');
  
  const dlPath = localFilePath(meta);
  if (!dlPath) return res.status(410).send('Gone | MINYAWE-LINK');
  
  const ct = mimeOf(meta.original, meta.mimetype);
  
  // استخدام نظام Range للتحميل الاستئنافي
  handleRangeRequest(req, res, dlPath, meta.original, ct);
});

// ===== صفحة العرض =====
app.get('/v/:id', async (req, res) => {
  const { meta, err } = await loadMeta(req.params.id, req);
  if (err === 404) return res.status(404).send('Not found | MINYAWE-LINK');
  if (err === 410) return res.status(410).send('Expired | MINYAWE-LINK');
  
  if (needPw(meta, req)) {
    const wrong = req.query.pw !== undefined ? '<div class="err">باسورد غلط — حاول تاني</div>' : '';
    return res.status(200).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ملف محمي | MINYAWE-LINK</title>
<style>body{margin:0;background:#000;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px 16px 60px}
.wrap{max-width:480px;margin:0 auto}.logo{font-weight:600;color:#fff;text-decoration:none}
.card{background:#000;border:1px solid #292d30;border-radius:16px;padding:32px;margin-top:20px}
h2{font-size:20px;font-weight:500;color:#fff;margin:0 0 8px}.hint{font-family:monospace;font-size:12px;color:#a1a4a5;margin-bottom:20px}
.err{font-size:14px;color:#ff9592;margin-bottom:12px}
input{background:transparent;border:1px solid #292d30;border-radius:6px;color:#fff;font-family:monospace;font-size:14px;padding:12px 16px;width:100%;box-sizing:border-box;outline:none;direction:ltr;text-align:center}
input:focus{border-color:#fff}
button{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;width:100%;margin-top:12px}
button:hover{border-color:#fff}
footer{margin-top:28px;font-family:monospace;font-size:12px;color:#464a4d}footer b{color:#fff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE-LINK</a>
<div class="card"><h2>🔒 ملف محمي</h2><div class="hint">${esc(meta.original)}</div>${wrong}
<form method="GET"><input type="password" name="pw" placeholder="password" autocomplete="off"><button type="submit">فتح الملف</button></form></div>
<footer>Dev <b>ELMINYAWE</b></footer></div></body></html>`);
  }
  
  fileDB.incrementViews(meta.id);
  const L = fileLinks(req, meta.id, meta);
  const pwSuffix = meta.pw && req.query.pw ? '?pw=' + encodeURIComponent(req.query.pw) : '';
  const stream = L.stream + pwSuffix, dl = L.download + pwSuffix, view = L.view;
  const enc = encodeURIComponent(view);
  const name = esc(meta.original), kind = kindOf(meta);
  const size = (meta.size / 1048576).toFixed(2) + ' MB';
  
  // روابط المشاركة الاجتماعية
  const shareLinks = generateShareLinks(meta.id, baseUrl(req), meta.original);
  
  let player;
  if (kind === 'image') player = `<img src="${stream}" alt="${name}">`;
  else if (kind === 'video') player = `<video src="${stream}" controls playsinline></video>`;
  else if (kind === 'audio') player = `<div class="fn">${name}</div><audio src="${stream}" controls></audio>`;
  else if (kind === 'text') {
    let snippet = '';
    try {
      if (meta.driver !== 'local' && meta.directUrl) {
        const tr = await fetch(meta.directUrl, { headers: { Range: 'bytes=0-29999' } });
        if (tr.ok || tr.status === 206) snippet = (await tr.text()).slice(0, 30000);
      } else {
        const lp = localFilePath(meta);
        if (lp) snippet = fs.readFileSync(lp, 'utf8').slice(0, 30000);
      }
    } catch {}
    player = snippet
      ? `<div class="fn">${name}</div><pre class="txt">${esc(snippet)}</pre>`
      : `<div class="file">📁<div class="fn">${name}</div><div class="sz">${size}</div></div>`;
  }
  else player = `<div class="file">📁<div class="fn">${name}</div><div class="sz">${size}</div></div>`;
  
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} | MINYAWE-LINK</title>
<style>body{margin:0;background:#000;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px 16px 60px}
.wrap{max-width:640px;margin:0 auto}.logo{font-weight:600;color:#fff;text-decoration:none}
.logo span{color:#fff}.card{background:#000;border:1px solid #292d30;border-radius:16px;padding:32px;margin-top:20px}
img,video{max-width:100%;border-radius:16px}audio{width:100%;margin-top:12px}.fn{font-family:monospace;font-size:13px;word-break:break-all;margin:8px 0;color:#f0f0f0}
pre.txt{direction:ltr;text-align:left;background:#000;border:1px solid #292d30;border-radius:16px;padding:24px;font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;margin-top:12px;color:#f0f0f0}
.sz{font-family:monospace;font-size:12px;color:#a1a4a5}.meta{font-family:monospace;font-size:12px;color:#a1a4a5;margin-top:10px}
.btns{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin-top:24px}
a.btn{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-size:14px;font-weight:500;text-decoration:none}
a.btn:hover{border-color:#fff}button.btn{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit}
button.btn:hover{border-color:#fff}
.share-section{margin-top:24px;padding-top:24px;border-top:1px solid #292d30}
.share-title{font-size:14px;color:#a1a4a5;margin-bottom:16px}
.share-buttons{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.share-btn{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;border:1px solid #292d30;color:#fff;text-decoration:none;transition:all 0.2s}
.share-btn:hover{border-color:#fff;transform:translateY(-2px)}
.share-btn.whatsapp{background:#25D366;color:#fff}
.share-btn.telegram{background:#0088cc;color:#fff}
.share-btn.twitter{background:#000;color:#fff}
.share-btn.facebook{background:#1877F2;color:#fff}
.share-btn.linkedin{background:#0A66C2;color:#fff}
.share-btn.reddit{background:#FF4500;color:#fff}
.share-btn.email{background:#666;color:#fff}
.share-btn.sms{background:#4CAF50;color:#fff}
#tst{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#000;border:1px solid #292d30;border-radius:6px;padding:12px 16px;font-family:monospace;font-size:13px;color:#f0f0f0;display:none;z-index:99}
footer{margin-top:28px;font-family:monospace;font-size:12px;color:#464a4d}footer b{color:#fff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE<span>-LINK</span></a>
<div class="card">${player}<div class="meta">${size} • المشاهدات: ${meta.views || 0} • ينتهي: ${meta.expiryAt ? new Date(meta.expiryAt).toLocaleString('ar-EG') : 'شهر كحد أقصى'}</div>
<div class="btns"><a class="btn" href="${stream}" target="_blank">تشغيل مباشر</a><a class="btn" href="${dl}">تحميل</a><button class="btn" onclick="cp('${dl}')">نسخ</button></div>
<div class="share-section">
<div class="share-title">مشاركة عبر</div>
<div class="share-buttons">
<a href="${shareLinks.whatsapp}" target="_blank" class="share-btn whatsapp" title="WhatsApp"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>
<a href="${shareLinks.telegram}" target="_blank" class="share-btn telegram" title="Telegram"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg></a>
<a href="${shareLinks.twitter}" target="_blank" class="share-btn twitter" title="X"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
<a href="${shareLinks.facebook}" target="_blank" class="share-btn facebook" title="Facebook"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></a>
<a href="${shareLinks.linkedin}" target="_blank" class="share-btn linkedin" title="LinkedIn"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>
<a href="${shareLinks.reddit}" target="_blank" class="share-btn reddit" title="Reddit"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .464c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 00.029-.463.33.33 0 00-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.232-.095z"/></svg></a>
<a href="${shareLinks.email}" target="_blank" class="share-btn email" title="Email"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg></a>
<a href="${shareLinks.sms}" target="_blank" class="share-btn sms" title="SMS"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM9 11H7V9h2v2zm4 0h-2V9h2v2zm4 0h-2V9h2v2z"/></svg></a>
</div>
</div>
<div id="tst"></div>
<footer>Dev <b>ELMINYAWE</b></footer></div>
<script>function cp(t){function ok(){var e=document.getElementById('tst');e.textContent='تم النسخ ✓';e.style.display='block';setTimeout(function(){e.style.display='none';},5000);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){ok();});}else{var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy');}catch(_){}a.remove();ok();}}</script></body></html>`);
});

// ===== إدارة الأدمن =====
function needAdmin(req, res) {
  if (!isAdminReq(req)) { res.status(403).json({ error: 'Forbidden — admin only' }); return false; }
  return true;
}

app.post('/api/:id/password', async (req, res) => {
  if (!needAdmin(req, res)) return;
  const found = findFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const pw = req.body && req.body.password !== undefined ? String(req.body.password) : null;
  if (pw === null) return res.status(400).json({ error: 'password field required (empty string removes)' });
  if (pw === '') {
    fileDB.update(found.id, { pw: null });
    auditDB.log('pw-remove', req, { id: found.id, key: found.slug || found.id });
    return res.json({ ok: true, locked: false });
  }
  if (pw.length < 3 || pw.length > 128) return res.status(400).json({ error: 'password must be 3-128 chars' });
  fileDB.update(found.id, { pw: hashPw(pw) });
  auditDB.log('pw-set', req, { id: found.id, key: found.slug || found.id });
  res.json({ ok: true, locked: true });
});

app.get('/api/admin/ping', (req, res) => {
  if (!needAdmin(req, res)) return;
  res.json({ ok: true, admin: true });
});

app.get('/api/admin/files', (req, res) => {
  if (!needAdmin(req, res)) return;
  const q = String(req.query.q || '').toLowerCase();
  const b = baseUrl(req);
  let arr = fileDB.getAll(500).map(m => ({
    id: m.id, key: m.slug || m.id, name: m.original, size: m.size || 0,
    views: m.views || 0, kind: kindOf(m), driver: m.driver,
    createdAt: m.createdAt || 0, expiryAt: m.expiryAt || null,
    locked: !!m.pw, view: `${b}/v/${m.slug || m.id}`
  })).sort((x, y) => y.createdAt - x.createdAt);
  if (q) arr = arr.filter(f => (f.name + ' ' + f.key + ' ' + f.id).toLowerCase().includes(q));
  res.json({ files: arr.slice(0, 500), total: arr.length });
});

app.get('/api/admin/audit', (req, res) => {
  if (!needAdmin(req, res)) return;
  const q = String(req.query.q || '').toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 1000);
  let lines = auditDB.getAll(2000);
  lines.reverse();
  if (q) lines = lines.filter(e => JSON.stringify(e).toLowerCase().includes(q));
  res.json({ entries: lines.slice(0, limit), total: lines.length });
});

app.get('/api/admin/backup', (req, res) => {
  if (!needAdmin(req, res)) return;
  let archiver;
  try { archiver = require('archiver'); }
  catch { return res.status(501).json({ error: 'backup module missing — run npm install' }); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="minyawe-backup-${stamp}.zip"` });
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => { try { res.end(); } catch {} });
  zip.pipe(res);
  try {
    const dbPath = path.join(DATA_DIR, 'minyawe.db');
    if (fs.existsSync(dbPath)) zip.file(dbPath, { name: 'minyawe.db' });
    if (fs.existsSync(UPLOAD_DIR)) zip.directory(UPLOAD_DIR, 'uploads');
    zip.file(__filename, { name: 'server.js' });
  } catch {}
  auditDB.log('backup', req, {});
  zip.finalize();
});

// ===== حذف ملف =====
app.delete('/api/:id', async (req, res) => {
  const found = findFile(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const meta = found;
  if (req.query.token !== meta.deleteToken && !isAdminReq(req))
    return res.status(403).json({ error: 'Forbidden' });
  if (meta.driver === 'local') {
    const local = storage.getDriver('local');
    if (local) local.deleteFile(meta.stored);
  }
  fileDB.delete(meta.id);
  auditDB.log('delete', req, { id: meta.id, key: meta.slug || meta.id, name: meta.original, by: req.query.token === meta.deleteToken ? 'owner-token' : 'admin' });
  notifyDelete(meta.id, meta.original);
  res.json({ ok: true, brand: BRAND });
});

// ===== صفحة الألبوم =====
app.get('/a/:id', async (req, res) => {
  const al = albumDB.getById(req.params.id);
  if (!al) return res.status(404).send('Not found | MINYAWE-LINK');
  if (al.expiryAt && Date.now() > al.expiryAt) { albumDB.delete(al.id); return res.status(410).send('Expired | MINYAWE-LINK'); }
  const b = baseUrl(req);
  const rows = al.files.map(fid => {
    const m = fileDB.getById(fid);
    if (!m) return '';
    const key = m.slug || fid;
    const sz = ((m.size || 0) / 1048576).toFixed(2) + ' MB';
    return `<div class="frow"><span class="fn">${esc(m.original)}</span><span class="sz">${sz} • ${m.views || 0} 👁</span><span class="ops"><a class="btn" href="${b}/v/${key}" target="_blank">عرض</a><a class="btn" href="${b}/d/${key}">تحميل</a></span></div>`;
  }).join('');
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>أlbوم (${al.files.length}) | MINYAWE-LINK</title>
<style>body{margin:0;background:#000;color:#f0f0f0;font-family:Inter,system-ui,sans-serif;text-align:center;padding:24px 16px 60px}
.wrap{max-width:640px;margin:0 auto}.logo{font-weight:600;color:#fff;text-decoration:none}
.card{background:#000;border:1px solid #292d30;border-radius:16px;padding:32px;margin-top:20px;text-align:right}
.card h2{font-size:20px;font-weight:500;color:#fff;margin:0 0 4px}.card .cnt{font-family:monospace;font-size:12px;color:#a1a4a5;margin-bottom:12px}
.frow{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid #292d30;font-size:14px}
.frow:last-child{border-bottom:0}.fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:13px;direction:ltr;text-align:right}
.sz{font-family:monospace;font-size:12px;color:#a1a4a5;white-space:nowrap}.ops{display:flex;gap:8px}
a.btn{background:transparent;color:#fff;border:1px solid #292d30;border-radius:6px;padding:8px 16px;font-size:13px;text-decoration:none;white-space:nowrap}
a.btn:hover{border-color:#fff}
footer{margin-top:28px;font-family:monospace;font-size:12px;color:#464a4d}footer b{color:#fff}</style></head>
<body><div class="wrap"><a class="logo" href="/">MINYAWE-LINK</a>
<div class="card"><h2>أlbوم الملفات</h2><div class="cnt">${al.files.length} files • expires ${al.expiryAt ? new Date(al.expiryAt).toLocaleString('ar-EG') : '—'}</div>${rows || '<div class="cnt">لا توجد ملفات متاحة</div>'}</div>
<footer>Dev <b>ELMINYAWE</b></footer></div></body></html>`);
});

// ===== API الإشعارات =====
app.get('/api/notifications', (req, res) => {
  const { getNotifications } = require('./utils/notifications');
  const notifications = getNotifications(100);
  res.json({ notifications, powered_by: BRAND });
});

// ===== API حالة الصحة =====
app.get('/api/health', (req, res) => {
  const health = getHealthStatus();
  res.json({
    status: health.status,
    lastCheck: health.lastCheck,
    checks: health.checks,
    uptime: process.uptime(),
    powered_by: BRAND
  });
});

// ===== API إحصائيات التخزين المؤقت =====
app.get('/api/cache/stats', (req, res) => {
  const stats = cache.stats();
  res.json({ ...stats, powered_by: BRAND });
});

// ===== معالجة الأخطاء =====
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_MB}MB)` });
  if (err && /blocked/i.test(err.message || '')) return res.status(400).json({ error: err.message });
  try { console.error('  [req-err]', String((err && err.message) || err).slice(0, 200)); } catch {}
  res.status(400).json({ error: 'bad request' });
});

// ===== بدء الخادم =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  MINYAWE-LINK V7.0 by ELMINYAWE is READY');
  console.log(`  Port: ${PORT} | Max: ${MAX_MB}MB`);
  console.log(`  Storage: ${storage.getActiveDrivers().join(' -> ')}`);
  console.log('  Features: SQLite DB, Multi-Cloud, Notifications, Health Monitor, Cache, Resume, Social');
  console.log('==========================================');
  notifySystem('MINYAWE-LINK V7.0 started successfully');
});
