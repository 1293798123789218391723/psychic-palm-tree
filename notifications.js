const { v4: uuidv4 } = require('uuid');

const MAX_PER_USER = 50;
const store = new Map();

function addNotification(userId, payload = {}) {
  if (!userId) return null;
  const notification = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    read: false,
    type: payload.type || 'info',
    message: payload.message || '',
    meta: payload.meta || {}
  };

  const current = store.get(userId) || [];
  current.unshift(notification);
  if (current.length > MAX_PER_USER) {
    current.length = MAX_PER_USER;
  }
  store.set(userId, current);
  return notification;
}

function listNotifications(userId) {
  return (store.get(userId) || []).map((n) => ({ ...n }));
}

function markRead(userId, notificationId) {
  const list = store.get(userId) || [];
  const target = list.find((n) => n.id === notificationId);
  if (target) {
    target.read = true;
  }
  return target;
}

function markAllRead(userId) {
  const list = store.get(userId) || [];
  list.forEach((n) => (n.read = true));
}

module.exports = {
  addNotification,
  listNotifications,
  markRead,
  markAllRead
};
