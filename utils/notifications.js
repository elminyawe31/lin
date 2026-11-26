// MINYAWE-LINK V8.0 — الإشعارات
const crypto = require('crypto');
const { notificationDB } = require('./db');

const NOTIFICATION_TYPES = {
  UPLOAD: 'upload',
  DELETE: 'delete',
  EXPIRY: 'expiry',
  SECURITY: 'security',
  STORAGE: 'storage',
  SYSTEM: 'system'
};

const NOTIFICATION_PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

async function createNotification(type, message, priority = NOTIFICATION_PRIORITY.MEDIUM, target = 'admin') {
  const notification = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    message,
    priority,
    target,
    createdAt: Date.now()
  };
  try { await notificationDB.insert(notification); } catch {}
  return notification;
}

function notifyUpload(fileId, filename) {
  return createNotification(NOTIFICATION_TYPES.UPLOAD, `تم رفع ملف جديد: ${filename} (${fileId})`);
}

function notifyDelete(fileId, filename) {
  return createNotification(NOTIFICATION_TYPES.DELETE, `تم حذف ملف: ${filename} (${fileId})`);
}

function notifyExpiry(fileId, filename) {
  return createNotification(NOTIFICATION_TYPES.EXPIRY, `انتهت صلاحية ملف: ${filename} (${fileId})`);
}

function notifySecurity(message) {
  return createNotification(NOTIFICATION_TYPES.SECURITY, message, NOTIFICATION_PRIORITY.HIGH);
}

function notifyStorage(message) {
  return createNotification(NOTIFICATION_TYPES.STORAGE, message, NOTIFICATION_PRIORITY.HIGH);
}

function notifySystem(message) {
  return createNotification(NOTIFICATION_TYPES.SYSTEM, message);
}

async function getNotifications(limit = 100) {
  try { return await notificationDB.getAll(limit); } catch { return []; }
}

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_PRIORITY,
  createNotification,
  notifyUpload,
  notifyDelete,
  notifyExpiry,
  notifySecurity,
  notifyStorage,
  notifySystem,
  getNotifications
};
