const { notificationDB } = require('./db');
const crypto = require('crypto');

// أنواع الإشعارات
const NOTIFICATION_TYPES = {
  UPLOAD: 'upload',
  DELETE: 'delete',
  EXPIRY: 'expiry',
  SECURITY: 'security',
  STORAGE: 'storage',
  SYSTEM: 'system'
};

// مستويات الأهمية
const NOTIFICATION_PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// إنشاء إشعار
function createNotification(type, message, priority = NOTIFICATION_PRIORITY.MEDIUM, target = 'admin') {
  const notification = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    message,
    priority,
    target, // 'admin' أو 'all'
    createdAt: Date.now()
  };
  
  notificationDB.insert(notification);
  return notification;
}

// إشعار رفع ملف (للمسؤول)
function notifyUpload(fileId, filename) {
  return createNotification(
    NOTIFICATION_TYPES.UPLOAD,
    `تم رفع الملف: ${filename}`,
    NOTIFICATION_PRIORITY.LOW,
    'admin'
  );
}

// إشعار حذف ملف (للمسؤول)
function notifyDelete(fileId, filename) {
  return createNotification(
    NOTIFICATION_TYPES.DELETE,
    `تم حذف الملف: ${filename}`,
    NOTIFICATION_PRIORITY.MEDIUM,
    'admin'
  );
}

// إشعار انتهاء صلاحية (للمسؤول + المستخدمين)
function notifyExpiry(fileId, filename) {
  return createNotification(
    NOTIFICATION_TYPES.EXPIRY,
    `انتهت صلاحية الملف: ${filename}`,
    NOTIFICATION_PRIORITY.HIGH,
    'all'
  );
}

// إشعار أمني (للمسؤول)
function notifySecurity(message) {
  return createNotification(
    NOTIFICATION_TYPES.SECURITY,
    message,
    NOTIFICATION_PRIORITY.CRITICAL,
    'admin'
  );
}

// إشعار تخزين (للمسؤول)
function notifyStorage(message) {
  return createNotification(
    NOTIFICATION_TYPES.STORAGE,
    message,
    NOTIFICATION_PRIORITY.HIGH,
    'admin'
  );
}

// إشعار نظام (للمسؤول)
function notifySystem(message) {
  return createNotification(
    NOTIFICATION_TYPES.SYSTEM,
    message,
    NOTIFICATION_PRIORITY.MEDIUM,
    'admin'
  );
}

// إشعار مهم للمستخدمين
function notifyUser(message) {
  return createNotification(
    NOTIFICATION_TYPES.SYSTEM,
    message,
    NOTIFICATION_PRIORITY.HIGH,
    'all'
  );
}

// الحصول على الإشعارات
function getNotifications(limit = 100, target = null) {
  if (target) {
    return notificationDB.getByTarget(target, limit);
  }
  return notificationDB.getAll(limit);
}

// الحصول على الإشعارات غير المقروءة
function getUnreadNotifications(target = null) {
  if (target) {
    return notificationDB.getUnreadByTarget(target);
  }
  return notificationDB.getUnread();
}

// تحديد كمقروء
function markAsRead(id) {
  notificationDB.markRead(id);
}

// تحديد الكل كمقروء
function markAllAsRead() {
  notificationDB.markAllRead();
}

// حذف إشعار
function deleteNotification(id) {
  notificationDB.delete(id);
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
  notifyUser,
  getNotifications,
  getUnreadNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification
};
