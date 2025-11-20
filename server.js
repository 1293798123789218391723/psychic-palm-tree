const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const database = require('./database');
const auth = require('./auth');
const emailReceiver = require('./emailReceiver');
const approvals = require('./approvals');
const notifications = require('./notifications');
const ticTacToe = require('./tictactoe');
const gmailPoller = require('./gmailPoller');

const CHAT_MAX_MESSAGES = 100;
const chatMessages = [];
const onlineMap = new Map();
require('dotenv').config();

// Rate limiting for chat (will be initialized after isOwnerUsername is defined)
let chatMessageLimiter, chatReadLimiter;

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const DOMAIN = process.env.DOMAIN || 'larpgod.xyz';
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'dot').toLowerCase();
const MEDIA_ROOT = path.join(__dirname, 'media');
const MEDIA_SHARED_DIR = path.join(MEDIA_ROOT, 'shared');
let MEDIA_USERS_DIR = process.env.MEDIA_USERS_DIR || '/downloads';
const MEDIA_MAX_FILE_MB = parseInt(process.env.MEDIA_MAX_FILE_MB || '100', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const EMBED_PREFS_FILE = path.join(__dirname, 'db', 'embed-prefs.json');
const ONE_YEAR_SECONDS = 31536000;
const NO_CACHE_HEADER = 'no-cache, no-store, must-revalidate';

try {
  ensureDirSync(MEDIA_USERS_DIR);
} catch (err) {
  console.warn(`Failed to initialize user media directory at ${MEDIA_USERS_DIR}: ${err.message}`);
  MEDIA_USERS_DIR = path.join(MEDIA_ROOT, 'users');
}

ensureDirSync(MEDIA_SHARED_DIR);
ensureDirSync(MEDIA_USERS_DIR);
ensureDirSync(path.dirname(EMBED_PREFS_FILE));

let globalEmbedPrefs = loadEmbedPrefsFromDisk();

const mediaStaticOptions = {
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }
};

app.use('/media/users', express.static(MEDIA_USERS_DIR, mediaStaticOptions));
app.use('/media', express.static(MEDIA_ROOT, mediaStaticOptions));

function applyNoCache(res) {
  res.set('Cache-Control', NO_CACHE_HEADER);
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

const publicStaticOptions = {
  setHeaders: (res, servedPath) => {
    if (servedPath.endsWith('.html')) {
      applyNoCache(res);
      return;
    }

    res.set('Cache-Control', `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
  }
};

// Media embed (Discord-friendly)
app.get('/media/embed/shared/:file', async (req, res) => {
  try {
    const fileName = path.basename(req.params.file);
    const filePath = path.join(MEDIA_SHARED_DIR, fileName);
    await fs.promises.access(filePath, fs.constants.R_OK);
    const fileUrl = `/media/shared/${encodeURIComponent(fileName)}`;
    applyNoCache(res);
    // Set proper content-type for Discord
    res.type('text/html');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(renderEmbedPage(fileUrl, fileName, req.query));
  } catch {
    return res.status(404).send('Not found');
  }
});

app.get('/media/embed/users/:userSlug/:file', async (req, res) => {
  try {
    const userSlug = slugifyMedia(req.params.userSlug);
    const fileName = path.basename(req.params.file);
    const dir = path.join(MEDIA_USERS_DIR, userSlug);
    const filePath = path.join(dir, fileName);
    await fs.promises.access(filePath, fs.constants.R_OK);
    const fileUrl = `/media/users/${encodeURIComponent(userSlug)}/${encodeURIComponent(fileName)}`;
    applyNoCache(res);
    // Set proper content-type for Discord
    res.type('text/html');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(renderEmbedPage(fileUrl, fileName, req.query));
  } catch {
    return res.status(404).send('Not found');
  }
});

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const bucket = req.mediaBucketInfo;
    if (!bucket) {
      return cb(new Error('Bucket not resolved'));
    }
    fs.promises.mkdir(bucket.dir, { recursive: true }).then(() => cb(null, bucket.dir)).catch(cb);
  },
  filename: (req, file, cb) => {
    const unique = generateMediaKey();
    const ext = path.extname(file.originalname) || '';
    const requestedTitle = (req.query.title || '').trim() || (req.body && req.body.title) || '';
    const baseName = requestedTitle || path.basename(file.originalname, ext);
    const safeBase = slugifyMedia(baseName) || 'media';
    cb(null, `${safeBase}-${unique}${ext.toLowerCase()}`);
  }
});

// Note: Multer doesn't support dynamic limits per user, so we set a high limit
// and check the actual file size in middleware (checkFileSizeLimit) for non-owner users
const mediaUpload = multer({
  storage: mediaStorage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024 // 10GB default (effectively unlimited for owner "dot", will check in middleware for others)
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.endsWith('.html')) {
    applyNoCache(res);
  }
  next();
});

app.get('/config.js', (req, res) => {
  applyNoCache(res);
  res.type('application/javascript').send(`window.__LARP_CONFIG__ = ${JSON.stringify({
    ownerUsername: OWNER_USERNAME,
  })};`);
});

app.use(express.static(path.join(__dirname, 'public'), publicStaticOptions));

// Initialize database
database.init().then(async () => {
  console.log('Database initialized');

  await ensureMediaDirsForApprovedUsers();
  
  // Start email receiver
  emailReceiver.start();

  // Start Gmail poller (optional if credentials exist)
  gmailPoller.start();
  
  // Cleanup expired addresses every hour
  cron.schedule('0 * * * *', async () => {
    try {
      const result = await database.cleanupExpiredAddresses();
      console.log(`Cleanup: Deleted ${result.deletedAddresses} expired addresses`);
    } catch (err) {
      console.error('Cleanup error:', err);
    }
  });

  // Start server
  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Blank homepage
app.get('/', (req, res) => {
  applyNoCache(res);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Email management page redirects to dashboard
app.get('/email', (req, res) => {
  res.redirect('/dashboard');
});

app.get('/email.html', (req, res) => {
  res.redirect('/dashboard');
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  applyNoCache(res);
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Auth routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!isValidUsername(username) || !isValidPasswordForRegistration(password)) {
      return res.status(400).json({ error: 'Invalid username or password format' });
    }

    // Check if user exists
    const existingUser = await database.getUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Create user
    const passwordHash = await auth.hashPassword(password);
    const user = await database.createUser(username, passwordHash);

    const token = auth.generateToken(user.id);
    const userPayload = await buildUserPayload(user);

    res.json({
      message: 'User created successfully',
      token,
      user: userPayload
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!isValidUsername(username) || !isValidPasswordForLogin(password)) {
      return res.status(400).json({ error: 'Invalid username or password format' });
    }

    const user = await database.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await auth.comparePassword(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = auth.generateToken(user.id);
    const userPayload = await buildUserPayload(user);

    res.json({
      message: 'Login successful',
      token,
      user: userPayload
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', auth.authenticateToken, attachCurrentUser, (req, res) => {
  res.json({ user: req.currentUser });
});

function isValidUsername(value) {
  return typeof value === 'string' && USERNAME_REGEX.test(value);
}

function isValidPasswordForRegistration(value) {
  return typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH;
}

function isValidPasswordForLogin(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PASSWORD_LENGTH;
}

// Email address routes (protected)
app.post('/api/email-addresses', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const userId = req.currentUser.id;
    const { ttlHours } = req.body;
    const hours = ttlHours || 5;

    // Generate random local part
    const localPart = uuidv4().replace(/-/g, '').substring(0, 12);
    const fullAddress = `${localPart}@${DOMAIN}`;

    const emailAddress = await database.createEmailAddress(userId, localPart, fullAddress, hours);

    res.json({
      message: 'Email address created',
      emailAddress: {
        id: emailAddress.id,
        localPart: emailAddress.localPart,
        fullAddress: emailAddress.fullAddress,
        expiresAt: emailAddress.expiresAt,
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Create email address error:', err);
    if (err.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'Email address already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create email address' });
    }
  }
});

app.get('/api/email-addresses', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const userId = req.currentUser.id;
    const emailAddresses = await database.getEmailAddressesByUserId(userId);

    res.json({
      emailAddresses: emailAddresses.map(addr => ({
        id: addr.id,
        localPart: addr.local_part,
        fullAddress: addr.full_address,
        createdAt: addr.created_at,
        expiresAt: addr.expires_at
      }))
    });
  } catch (err) {
    console.error('Get email addresses error:', err);
    res.status(500).json({ error: 'Failed to fetch email addresses' });
  }
});

app.delete('/api/email-addresses/:id', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const userId = req.currentUser.id;
    const addressId = parseInt(req.params.id, 10);

    // Verify ownership
    const emailAddress = await database.getEmailAddressById(addressId);
    if (!emailAddress || emailAddress.user_id !== userId) {
      return res.status(404).json({ error: 'Email address not found' });
    }

    await database.deactivateEmailAddress(addressId);

    res.json({ message: 'Email address deleted' });
  } catch (err) {
    console.error('Delete email address error:', err);
    res.status(500).json({ error: 'Failed to delete email address' });
  }
});

// Message routes (protected)
app.get('/api/email-addresses/:id/messages', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const userId = req.currentUser.id;
    const addressId = parseInt(req.params.id, 10);

    // Verify ownership
    const emailAddress = await database.getEmailAddressById(addressId);
    if (!emailAddress || emailAddress.user_id !== userId) {
      return res.status(404).json({ error: 'Email address not found' });
    }

    const messages = await database.getMessagesByEmailAddressId(addressId);

    res.json({
      messages: messages.map(msg => ({
        id: msg.id,
        fromAddress: msg.from_address,
        subject: msg.subject,
        bodyText: msg.body_text,
        bodyHtml: msg.body_html,
        receivedAt: msg.received_at,
        headers: msg.headers ? JSON.parse(msg.headers) : {}
      }))
    });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/messages', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const userId = req.currentUser.id;
    const messages = await database.getAllMessagesByUserId(userId);

    res.json({
      messages: messages.map(msg => ({
        id: msg.id,
        emailAddress: msg.full_address,
        localPart: msg.local_part,
        fromAddress: msg.from_address,
        subject: msg.subject,
        bodyText: msg.body_text,
        bodyHtml: msg.body_html,
        receivedAt: msg.received_at,
        headers: msg.headers ? JSON.parse(msg.headers) : {}
      }))
    });
  } catch (err) {
    console.error('Get all messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/external-mails', auth.authenticateToken, attachCurrentUser, requireApprovedUser, (req, res) => {
  try {
    const emails = gmailPoller.getRecentEmails();
    res.json({ emails });
  } catch (err) {
    console.error('External mail error:', err);
    res.status(500).json({ error: 'Failed to load external mail' });
  }
});

// Chat endpoints will be defined after rate limiters are initialized

app.get('/api/media/buckets', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const buckets = await getMediaBucketsForUser(req.currentUser);
    res.json({ buckets: buckets.map(sanitizeBucketInfo) });
  } catch (err) {
    console.error('List media buckets error:', err);
    res.status(500).json({ error: 'Failed to load media buckets' });
  }
});

app.get('/api/media/buckets/:bucketId/assets', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const bucketInfo = await resolveBucketInfo(req.params.bucketId, req.currentUser);
    const assets = await listBucketAssets(req, bucketInfo);
    res.json({ assets, bucket: sanitizeBucketInfo(bucketInfo) });
  } catch (err) {
    console.error('List media assets error:', err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Failed to load assets' });
  }
});

// Middleware to check file size limit (except for owner)
function checkFileSizeLimit(req, res, next) {
  if (!req.file) {
    return next();
  }
  
  // Remove file size limit for user "dot"
  if (req.currentUser && isOwnerUsername(req.currentUser.username)) {
    return next(); // No limit check for owner
  }
  
  const fileSizeMB = req.file.size / (1024 * 1024);
  if (fileSizeMB > MEDIA_MAX_FILE_MB) {
    // Clean up the uploaded file
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ 
      error: `File size exceeds limit of ${MEDIA_MAX_FILE_MB}MB. Your file is ${fileSizeMB.toFixed(2)}MB.` 
    });
  }
  
  next();
}

app.post('/api/media/upload', auth.authenticateToken, attachCurrentUser, requireApprovedUser, resolveMediaBucket, mediaUpload.single('file'), checkFileSizeLimit, async (req, res) => {
  try {
    if (!req.file || !req.mediaBucketInfo) {
      return res.status(400).json({ error: 'File upload failed' });
    }

    const stats = await fs.promises.stat(req.file.path);
    const bucket = req.mediaBucketInfo;
    const fileName = path.basename(req.file.path);

    res.json({
      message: 'File uploaded',
      bucket: sanitizeBucketInfo(bucket),
      asset: {
        name: fileName,
        size: stats.size,
        createdAt: stats.birthtime,
        url: absoluteResourceUrl(req, `${bucket.urlPrefix}/${encodeURIComponent(fileName)}`),
        embedUrl: absoluteResourceUrl(req, bucket.type === 'shared'
          ? `/media/embed/shared/${encodeURIComponent(fileName)}`
          : `/media/embed/users/${encodeURIComponent(bucket.ownerSlug || '')}/${encodeURIComponent(fileName)}`),
        bucketId: bucket.id
      }
    });
  } catch (err) {
    console.error('Upload media error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.delete('/api/media/:bucketId/assets/:fileName', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const bucketInfo = await resolveBucketInfo(req.params.bucketId, req.currentUser);
    if (bucketInfo.type === 'private' && bucketInfo.ownerSlug !== slugifyMedia(req.currentUser.username)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const targetPath = path.join(bucketInfo.dir, path.basename(req.params.fileName));
    await fs.promises.unlink(targetPath);
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Delete media error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// File hosting features - Get file info
app.get('/api/media/:bucketId/assets/:fileName/info', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const bucketInfo = await resolveBucketInfo(req.params.bucketId, req.currentUser);
    if (bucketInfo.type === 'private' && bucketInfo.ownerSlug !== slugifyMedia(req.currentUser.username)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const fileName = path.basename(req.params.fileName);
    const filePath = path.join(bucketInfo.dir, fileName);
    
    const stats = await fs.promises.stat(filePath);
    const ext = path.extname(fileName);
    const mimeType = getMimeType(fileName);
    
    res.json({
      name: fileName,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      mimeType: mimeType,
      extension: ext,
      createdAt: stats.birthtime,
      updatedAt: stats.mtime,
      url: absoluteResourceUrl(req, `${bucketInfo.urlPrefix}/${encodeURIComponent(fileName)}`),
      embedUrl: absoluteResourceUrl(req, bucketInfo.type === 'shared'
        ? `/media/embed/shared/${encodeURIComponent(fileName)}`
        : `/media/embed/users/${encodeURIComponent(bucketInfo.ownerSlug || '')}/${encodeURIComponent(fileName)}`),
      bucketId: bucketInfo.id,
      bucketType: bucketInfo.type
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Get file info error:', err);
    res.status(500).json({ error: 'Failed to get file info' });
  }
});

// File hosting features - Direct download endpoint
app.get('/api/media/:bucketId/assets/:fileName/download', auth.authenticateToken, attachCurrentUser, requireApprovedUser, async (req, res) => {
  try {
    const bucketInfo = await resolveBucketInfo(req.params.bucketId, req.currentUser);
    if (bucketInfo.type === 'private' && bucketInfo.ownerSlug !== slugifyMedia(req.currentUser.username)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const fileName = path.basename(req.params.fileName);
    const filePath = path.join(bucketInfo.dir, fileName);
    
    await fs.promises.access(filePath, fs.constants.R_OK);
    
    const mimeType = getMimeType(fileName);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    
    return res.sendFile(path.resolve(filePath));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Download file error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

app.get('/api/tictactoe/status', auth.authenticateToken, attachCurrentUser, requireApprovedUser, (req, res) => {
  res.json(buildGameResponse(req.currentUser));
});

app.post('/api/tictactoe/queue', auth.authenticateToken, attachCurrentUser, requireApprovedUser, (req, res) => {
  const player = { id: req.currentUser.id, username: req.currentUser.username };
  const result = ticTacToe.queueUser(player);

  if (result.status === 'matched' && result.game) {
    notifyMatchStart(result.game);
  }

  res.json(buildGameResponse(req.currentUser));
});

app.post('/api/tictactoe/move', auth.authenticateToken, attachCurrentUser, requireApprovedUser, (req, res) => {
  const cell = parseInt(req.body?.cell, 10);
  const result = ticTacToe.makeMove(req.currentUser.id, cell);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  if (result.game?.status === 'finished') {
    notifyGameFinish(result.game);
  }

  res.json(buildGameResponse(req.currentUser));
});

app.post('/api/tictactoe/leave', auth.authenticateToken, attachCurrentUser, requireApprovedUser, (req, res) => {
  const outcome = ticTacToe.leave(req.currentUser.id);
  if (outcome?.game && outcome.game.status === 'finished') {
    notifyGameFinish(outcome.game);
  }
  res.json(buildGameResponse(req.currentUser));
});

app.get('/api/notifications', auth.authenticateToken, attachCurrentUser, (req, res) => {
  const list = notifications.listNotifications(req.currentUser.id);
  res.json({ notifications: list });
});

app.post('/api/notifications/:id/read', auth.authenticateToken, attachCurrentUser, (req, res) => {
  const updated = notifications.markRead(req.currentUser.id, req.params.id);
  res.json({ notification: updated });
});

app.post('/api/notifications/read-all', auth.authenticateToken, attachCurrentUser, (req, res) => {
  notifications.markAllRead(req.currentUser.id);
  res.json({ ok: true });
});

app.get('/api/admin/approvals', auth.authenticateToken, attachCurrentUser, requireOwner, async (req, res) => {
  try {
    const approvedUsers = await approvals.listUsers();
    const allUsers = await database.getAllUsers();
    const approvedSet = new Set(approvedUsers.map(u => u.toLowerCase()));
    const ownerLower = OWNER_USERNAME.toLowerCase();
    
    const usersWithStatus = allUsers.map(user => {
      const usernameLower = user.username.toLowerCase();
      const isApproved = usernameLower === ownerLower || approvedSet.has(usernameLower);
      return {
        id: user.id,
        username: user.username,
        isApproved,
        createdAt: user.created_at
      };
    });
    
    res.json({ 
      approvedUsers,
      allUsers: usersWithStatus,
      unapprovedUsers: usersWithStatus.filter(u => !u.isApproved)
    });
  } catch (err) {
    console.error('List approvals error:', err);
    res.status(500).json({ error: 'Failed to list approvals' });
  }
});

app.post('/api/admin/approvals', auth.authenticateToken, attachCurrentUser, requireOwner, async (req, res) => {
  try {
    const username = (req.body?.username || '').trim();

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    await approvals.addUser(username);
    await ensureMediaDirForExistingApprovedUser(username);
    res.json({ message: 'User approved', username: username.toLowerCase() });
  } catch (err) {
    console.error('Approve user error:', err);
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

app.delete('/api/admin/approvals/:username', auth.authenticateToken, attachCurrentUser, requireOwner, async (req, res) => {
  try {
    const username = req.params.username;

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    await approvals.removeUser(username);
    res.json({ message: 'User removed', username: username.toLowerCase() });
  } catch (err) {
    console.error('Remove approval error:', err);
    res.status(500).json({ error: 'Failed to remove approval' });
  }
});

app.get('/api/embed-prefs', auth.authenticateToken, attachCurrentUser, requireApprovedUser, (req, res) => {
  res.json({
    prefs: globalEmbedPrefs,
    editable: isOwnerUsername(req.currentUser.username)
  });
});

app.post('/api/embed-prefs', auth.authenticateToken, attachCurrentUser, requireOwner, (req, res) => {
  try {
    const prefs = sanitizeEmbedPrefs(req.body || {});
    globalEmbedPrefs = prefs;
    saveEmbedPrefsToDisk(prefs);
    res.json({ prefs });
  } catch (err) {
    console.error('Embed prefs save error:', err);
    res.status(500).json({ error: 'Failed to save embed defaults' });
  }
});

async function buildUserPayload(user) {
  if (!user) return null;
  const approved = isOwnerUsername(user.username) || (await approvals.isUserApproved(user.username));
  return {
    id: user.id,
    username: user.username,
    isApproved: approved,
  };
}

function isOwnerUsername(username) {
  return typeof username === 'string' && username.toLowerCase() === OWNER_USERNAME;
}

// Initialize rate limiters after isOwnerUsername is defined
chatMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 messages per minute per user
  message: 'Too many messages sent. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID for rate limiting with IPv6-safe fallback
    return req.currentUser?.id?.toString() || rateLimit.ipKeyGenerator(req);
  },
  skip: (req) => {
    // Skip rate limiting for owner
    return isOwnerUsername(req.currentUser?.username);
  }
});

chatReadLimiter = rateLimit({
  windowMs: 5 * 1000, // 5 seconds
  max: 20, // 20 reads per 5 seconds
  message: 'Too many requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.currentUser?.id?.toString() || rateLimit.ipKeyGenerator(req);
  }
});

// Chat endpoints - available to all logged-in users (not just approved)
// Defined here after rate limiters are initialized
app.get('/api/chat/messages', auth.authenticateToken, attachCurrentUser, chatReadLimiter, (req, res) => {
  res.json({ messages: chatMessages });
});

app.post('/api/chat/message', auth.authenticateToken, attachCurrentUser, chatMessageLimiter, (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Message required' });
  if (text.length > 200) return res.status(400).json({ error: 'Message too long' });

  const message = {
    id: uuidv4(),
    userId: req.currentUser.id,
    username: req.currentUser.username,
    text,
    createdAt: new Date().toISOString()
  };
  chatMessages.push(message);
  if (chatMessages.length > CHAT_MAX_MESSAGES) {
    chatMessages.splice(0, chatMessages.length - CHAT_MAX_MESSAGES);
  }
  res.json({ message });
});

app.post('/api/chat/heartbeat', auth.authenticateToken, attachCurrentUser, (req, res) => {
  onlineMap.set(req.currentUser.id, Date.now());
  res.json({ ok: true });
});

app.get('/api/chat/online', auth.authenticateToken, attachCurrentUser, (req, res) => {
  const now = Date.now();
  const cutoff = now - 30000;
  for (const [id, ts] of onlineMap.entries()) {
    if (ts < cutoff) onlineMap.delete(id);
  }
  res.json({ online: onlineMap.size });
});

async function attachCurrentUser(req, res, next) {
  try {
    if (req.currentUser) {
      return next();
    }
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await database.getUserById(req.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.currentUser = await buildUserPayload(user);
    next();
  } catch (err) {
    console.error('Attach user error:', err);
    res.status(500).json({ error: 'Failed to load account' });
  }
}

function requireApprovedUser(req, res, next) {
  if (!req.currentUser || !req.currentUser.isApproved) {
    return res.status(403).json({ error: 'Account pending approval' });
  }
  next();
}

function requireOwner(req, res, next) {
  if (!req.currentUser || !isOwnerUsername(req.currentUser.username)) {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

function buildGameResponse(user) {
  const state = ticTacToe.getState(user.id);
  return {
    queue: state.queue,
    game: state.game ? serializeGameForUser(state.game, user.id) : null
  };
}

function serializeGameForUser(game, userId) {
  const isX = game.players.X.id === userId;
  const yourSymbol = isX ? 'X' : 'O';
  const opponent = isX ? game.players.O : game.players.X;

  let statusMessage = '';
  if (game.status === 'active') {
    statusMessage = game.next === yourSymbol ? 'Your move!' : `${opponent.username}'s move`;
  } else if (game.status === 'finished') {
    if (game.draw) {
      statusMessage = 'Game ended in a draw.';
    } else if (game.winner === yourSymbol) {
      statusMessage = game.forfeit ? `${opponent.username} forfeited. You win!` : 'You win!';
    } else {
      statusMessage = game.forfeit ? 'You forfeited the match.' : `${opponent.username} wins.`;
    }
  }

  return {
    id: game.id,
    board: game.board,
    status: game.status,
    yourSymbol,
    turn: game.status === 'active' ? game.next : null,
    opponent: { username: opponent.username },
    winnerSymbol: game.winner,
    draw: game.draw || false,
    forfeit: game.forfeit || false,
    message: statusMessage
  };
}

function notifyMatchStart(game) {
  const msgX = `Matched with ${game.players.O.username}. You are X.`;
  const msgO = `Matched with ${game.players.X.username}. You are O.`;
  notifications.addNotification(game.players.X.id, { type: 'game', message: msgX });
  notifications.addNotification(game.players.O.id, { type: 'game', message: msgO });
}

function notifyGameFinish(game) {
  if (game.draw) {
    notifications.addNotification(game.players.X.id, { type: 'game', message: 'Tic Tac Toe match ended in a draw.' });
    notifications.addNotification(game.players.O.id, { type: 'game', message: 'Tic Tac Toe match ended in a draw.' });
    return;
  }

  const winnerSymbol = game.winner;
  if (!winnerSymbol) return;

  const winner = winnerSymbol === 'X' ? game.players.X : game.players.O;
  const loser = winnerSymbol === 'X' ? game.players.O : game.players.X;

  const winMsg = game.forfeit ? 'Opponent forfeited. Victory is yours!' : 'You won the Tic Tac Toe match!';
  const loseMsg = game.forfeit ? 'You forfeited the Tic Tac Toe match.' : `${winner.username} won the match.`;

  notifications.addNotification(winner.id, { type: 'game', message: winMsg });
  notifications.addNotification(loser.id, { type: 'game', message: loseMsg });
}

async function getMediaBucketsForUser(user) {
  const shared = {
    id: 'shared',
    name: 'Shared Media',
    type: 'shared',
    dir: MEDIA_SHARED_DIR,
    urlPrefix: '/media/shared'
  };

  const { dir: userDir, slug: userSlug } = await ensureUserMediaDirForUsername(user.username);

  const personal = {
    id: `user-${userSlug}`,
    name: `${user.username}'s Media`,
    type: 'private',
    dir: userDir,
    urlPrefix: `/media/users/${encodeURIComponent(userSlug)}`
  };

  return [shared, personal];
}

async function resolveBucketInfo(bucketId, user) {
  const normalized = (bucketId || '').toLowerCase();
  if (!normalized || normalized === 'shared') {
    return {
      id: 'shared',
      name: 'Shared Media',
      type: 'shared',
      dir: MEDIA_SHARED_DIR,
      urlPrefix: '/media/shared'
    };
  }

  const userSlug = slugifyMedia(user.username);
  if (normalized === 'private' || normalized === userSlug || normalized === `user-${userSlug}`) {
    const { dir } = await ensureUserMediaDirForUsername(user.username);
    return {
      id: `user-${userSlug}`,
      name: `${user.username}'s Media`,
      type: 'private',
      dir,
      urlPrefix: `/media/users/${encodeURIComponent(userSlug)}`,
      ownerSlug: userSlug
    };
  }

  const err = new Error('Bucket not found');
  err.statusCode = 404;
  throw err;
}

async function listBucketAssets(req, bucketInfo) {
  await fs.promises.mkdir(bucketInfo.dir, { recursive: true });
  const entries = await fs.promises.readdir(bucketInfo.dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const assets = [];

  for (const file of files) {
    const filePath = path.join(bucketInfo.dir, file.name);
    const stats = await fs.promises.stat(filePath);
    assets.push({
      name: file.name,
      size: stats.size,
      createdAt: stats.birthtime,
      updatedAt: stats.mtime,
      url: absoluteResourceUrl(req, `${bucketInfo.urlPrefix}/${encodeURIComponent(file.name)}`),
      embedUrl: absoluteResourceUrl(req, bucketInfo.type === 'shared'
        ? `/media/embed/shared/${encodeURIComponent(file.name)}`
        : `/media/embed/users/${encodeURIComponent(bucketInfo.ownerSlug || '')}/${encodeURIComponent(file.name)}`),
      bucketId: bucketInfo.id,
      bucketType: bucketInfo.type
    });
  }

  return assets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function resolveMediaBucket(req, res, next) {
  try {
    const bucketId = (req.query.bucketId || '').toLowerCase();
    if (!bucketId) {
      return res.status(400).json({ error: 'bucketId required' });
    }
    req.mediaBucketInfo = await resolveBucketInfo(bucketId, req.currentUser);
    next();
  } catch (err) {
    console.error('Resolve media bucket error:', err);
    const status = err.statusCode || 400;
    res.status(status).json({ error: err.message || 'Invalid bucket' });
  }
}

function generateMediaKey() {
  // Choose pattern: either "67" or "41"
  const pattern = Math.random() < 0.5 ? '67' : '41';
  
  // Choose length: 4, 5, or 6 digits
  const length = 4 + Math.floor(Math.random() * 3); // 4, 5, or 6
  
  // Generate random digits for remaining positions
  const remaining = length - 2;
  let randomDigits = '';
  for (let i = 0; i < remaining; i++) {
    randomDigits += Math.floor(Math.random() * 10).toString();
  }
  
  // Insert pattern at random position
  const positions = [];
  for (let i = 0; i <= randomDigits.length; i++) {
    positions.push(i);
  }
  const insertPos = positions[Math.floor(Math.random() * positions.length)];
  
  return randomDigits.slice(0, insertPos) + pattern + randomDigits.slice(insertPos);
}

function slugifyMedia(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'media';
}

async function ensureUserMediaDirForUsername(username) {
  if (!username) {
    return null;
  }
  const slug = slugifyMedia(username);
  const dir = path.join(MEDIA_USERS_DIR, slug);
  await fs.promises.mkdir(dir, { recursive: true });
  return { dir, slug };
}

async function ensureMediaDirForExistingApprovedUser(username) {
  try {
    const user = await database.getUserByUsername(username);
    if (user) {
      await ensureUserMediaDirForUsername(user.username);
    }
  } catch (err) {
    console.error(`Failed to ensure media directory for ${username}:`, err);
  }
}

async function ensureMediaDirsForApprovedUsers() {
  try {
    const [users, approvedUsers] = await Promise.all([
      database.getAllUsers(),
      approvals.listUsers()
    ]);
    const ownerLower = OWNER_USERNAME.toLowerCase();
    const approvedSet = new Set(approvedUsers.map((name) => name.toLowerCase()));

    for (const user of users) {
      const normalized = (user.username || '').toLowerCase();
      if (normalized === ownerLower || approvedSet.has(normalized)) {
        await ensureUserMediaDirForUsername(user.username);
      }
    }

    if (!approvedSet.has(ownerLower)) {
      await ensureUserMediaDirForUsername(OWNER_USERNAME);
    }
  } catch (err) {
    console.error('Failed to ensure media directories for approved users:', err);
  }
}

function sanitizeBucketInfo(bucket) {
  return {
    id: bucket.id,
    name: bucket.name,
    type: bucket.type,
    ownerSlug: bucket.ownerSlug,
    urlPrefix: bucket.urlPrefix
  };
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function absoluteResourceUrl(req, relativePath) {
  const rel = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  if (PUBLIC_URL) {
    return `${PUBLIC_URL}${rel}`;
  }
  if (req && req.protocol && req.get) {
    return `${req.protocol}://${req.get('host')}${rel}`;
  }
  return rel;
}

function sanitizeEmbedPrefs(input = {}) {
  const title = (input.title || '').toString().slice(0, 120);
  const desc = (input.desc || '').toString().slice(0, 500);
  const color = isValidHexColor(input.color) ? input.color : '#151521';
  return { title, desc, color };
}

function isValidHexColor(val = '') {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val);
}

function loadEmbedPrefsFromDisk() {
  try {
    const raw = fs.readFileSync(EMBED_PREFS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return sanitizeEmbedPrefs(parsed);
  } catch {
    return { title: '', desc: '', color: '#151521' };
  }
}

function saveEmbedPrefsToDisk(prefs) {
  try {
    fs.writeFileSync(EMBED_PREFS_FILE, JSON.stringify(sanitizeEmbedPrefs(prefs), null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist embed prefs:', err);
  }
}

function getMimeType(fileName) {
  const ext = (path.extname(fileName || '') || '').toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function renderEmbedPage(fileUrl, fileName, query = {}) {
  const defaults = globalEmbedPrefs || { title: '', desc: '', color: '#151521' };
  const merged = sanitizeEmbedPrefs({
    title: query.title || defaults.title || fileName,
    desc: query.desc || defaults.desc || 'Embedded media',
    color: query.color || defaults.color
  });
  const title = merged.title || fileName || 'Media';
  const description = merged.desc || 'Embedded media';
  const color = merged.color || '#151521';
  const absoluteUrl = fileUrl.startsWith('http') ? fileUrl : `${PUBLIC_URL || ''}${fileUrl}`;
  const ext = (path.extname(fileName || '') || '').toLowerCase();
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(ext);
  const isVideo = /\.(mp4|webm|ogg|mov|m4v)$/i.test(ext);
  const mimeType = getMimeType(fileName);

  const commonMeta = `
    <meta charset="UTF-8">
    <title>${title}</title>
    <meta name="theme-color" content="${color}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
  `;

  // For images, ensure we ONLY have image meta tags and NO video tags
  const imageMeta = isImage ? `
    <meta property="og:type" content="image">
    <meta property="og:image" content="${absoluteUrl}">
    <meta property="og:image:secure_url" content="${absoluteUrl}">
    <meta property="og:image:type" content="${mimeType}">
    <meta property="og:image:alt" content="${title}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${absoluteUrl}">
  ` : '';

  const videoMeta = isVideo ? `
    <meta property="og:type" content="video.other">
    <meta property="og:video" content="${absoluteUrl}">
    <meta property="og:video:url" content="${absoluteUrl}">
    <meta property="og:video:secure_url" content="${absoluteUrl}">
    <meta property="og:video:type" content="${mimeType}">
    <meta property="og:video:width" content="720">
    <meta property="og:video:height" content="1280">
    <meta name="twitter:card" content="player">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:player" content="${absoluteUrl}">
    <meta name="twitter:player:width" content="720">
    <meta name="twitter:player:height" content="1280">
  ` : '';

  const fallbackMeta = !isImage && !isVideo ? `
    <meta property="og:type" content="website">
    <meta property="og:url" content="${absoluteUrl}">
    <meta property="og:image" content="${absoluteUrl}">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
  ` : '';

  const mediaElement = isImage
    ? `<img src="${absoluteUrl}" alt="${title}" style="max-width:90vw;max-height:90vh;border-radius:12px;object-fit:contain;"/>`
    : isVideo
      ? `<video src="${absoluteUrl}" controls autoplay loop playsinline style="max-width:90vw;max-height:90vh;border-radius:12px;"></video>`
      : `<a href="${absoluteUrl}">${absoluteUrl}</a>`;

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    ${commonMeta}
    ${imageMeta}
    ${videoMeta}
    ${fallbackMeta}
    <style>body{margin:0;background:#050517;display:flex;align-items:center;justify-content:center;height:100vh;color:#fff;font-family:Arial,sans-serif;}a{color:#7ab9ff;word-break:break-all;}</style>
  </head>
  <body>
    ${mediaElement}
  </body>
  </html>`;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
