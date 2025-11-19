const fs = require('fs');
const path = require('path');

const APPROVED_USERS_FILE = process.env.APPROVED_USERS_FILE || path.join(__dirname, 'approved-users.txt');
let initialized = false;

async function ensureFile() {
  if (initialized) {
    return;
  }

  try {
    await fs.promises.access(APPROVED_USERS_FILE, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(APPROVED_USERS_FILE, '', { mode: 0o600 });
  }

  try {
    await fs.promises.chmod(APPROVED_USERS_FILE, 0o600);
  } catch {
    // ignore chmod failures on non-POSIX platforms
  }

  initialized = true;
}

function normalizeUsername(username) {
  if (typeof username !== 'string') {
    return '';
  }
  return username.trim().toLowerCase();
}

async function readUsers() {
  await ensureFile();
  const content = await fs.promises.readFile(APPROVED_USERS_FILE, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

async function writeUsers(users) {
  await ensureFile();
  const unique = Array.from(new Set(users.map((user) => user.toLowerCase())));
  await fs.promises.writeFile(APPROVED_USERS_FILE, unique.join('\n') + (unique.length ? '\n' : ''), {
    mode: 0o600,
  });
}

async function isUserApproved(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    return false;
  }
  const users = await readUsers();
  return users.includes(normalized);
}

async function addUser(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    throw new Error('Invalid username');
  }

  const users = await readUsers();
  if (!users.includes(normalized)) {
    users.push(normalized);
    await writeUsers(users);
  }

  return normalized;
}

async function removeUser(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) {
    throw new Error('Invalid username');
  }

  const users = await readUsers();
  const filtered = users.filter((user) => user !== normalized);
  await writeUsers(filtered);
  return normalized;
}

async function listUsers() {
  const users = await readUsers();
  return users.sort();
}

module.exports = {
  isUserApproved,
  addUser,
  removeUser,
  listUsers,
  filePath: APPROVED_USERS_FILE,
};
