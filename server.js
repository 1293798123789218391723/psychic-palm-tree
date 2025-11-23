const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const SHORT_CACHE_SECONDS = 300; // 5 minutes for static assets
const MEDIA_ROTATION_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const rotationTokenMap = new Map();
const rotationPayloadMap = new Map();
const EMBED_BOT_KEYWORDS = [
  'discordbot',
  'twitterbot',
  'slackbot',
  'facebookexternalhit',
  'whatsapp',
  'telegrambot',
  'linkedinbot',
  'embedly'
];

function getCurrentRotationInterval() {
  return Math.floor(Date.now() / MEDIA_ROTATION_INTERVAL_MS);
}

function cleanupRotationCache() {
  const current = getCurrentRotationInterval();

  for (const [token, payload] of rotationTokenMap) {
    if (payload.interval !== current) {
      rotationTokenMap.delete(token);
    }
  }

  for (const [key, entry] of rotationPayloadMap) {
    if (entry.interval !== current) {
      rotationPayloadMap.delete(key);
    }
  }
}

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
    // Allow caching but with revalidation for media files
    res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
  }
};

function setFriendlyMediaHeaders(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
}

function shouldServeEmbedPreview(req) {
  // Avoid interfering with range/video streaming requests
  if (req.headers.range) {
    return false;
  }

  const ua = (req.get('user-agent') || '').toLowerCase();
  const accept = (req.get('accept') || '').toLowerCase();
  const isEmbedBot = EMBED_BOT_KEYWORDS.some((keyword) => ua.includes(keyword));
  const preferHtml = accept.includes('text/html');
  const explicitEmbed = ['1', 'true', 'yes'].includes((req.query.embed || '').toString().toLowerCase());

  return Boolean(explicitEmbed || (isEmbedBot && (preferHtml || !accept)));
}

app.get('/:rotationKey([A-Za-z0-9]{5})', async (req, res, next) => {
  try {
    const resolved = await resolveRotatingToken(req.params.rotationKey);
    if (!resolved) {
      return next();
    }

    if (shouldServeEmbedPreview(req)) {
      const embedPath = resolved.bucketType === 'shared'
        ? `shared/${resolved.fileName}`
        : `users/${resolved.ownerSlug}/${resolved.fileName}`;

      const friendlyPath = resolved.bucketType === 'shared'
        ? `/${encodeURIComponent(resolved.fileName)}`
        : `/${encodeURIComponent(resolved.ownerSlug)}/${encodeURIComponent(resolved.fileName)}`;

      return respondWithEmbed(res, embedPath, req.query, friendlyPath);
      return respondWithEmbed(res, embedPath, req.query, `/${req.params.rotationKey}`);
    }

    setFriendlyMediaHeaders(res);
    return res.sendFile(resolved.diskPath);
  } catch (err) {
    console.error('Rotating media error:', err);
    return next();
  }
});

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

    // For JS and CSS files, use short cache with revalidation
    if (servedPath.endsWith('.js') || servedPath.endsWith('.css')) {
      res.set('Cache-Control', `public, max-age=${SHORT_CACHE_SECONDS}, must-revalidate`);
      return;
    }

    // For other static assets, use moderate caching
    res.set('Cache-Control', `public, max-age=${SHORT_CACHE_SECONDS}, must-revalidate`);
  }
};

// Media embed (Discord-friendly)
app.get('/:rotationKey([A-Za-z0-9]{5})/embed', async (req, res, next) => {
  try {
    const payload = await resolveRotatingToken(req.params.rotationKey);
    if (!payload) {
      return next();
    }

    const embedPath = payload.bucketType === 'shared'
      ? `shared/${payload.fileName}`
      : `users/${payload.ownerSlug}/${payload.fileName}`;

    const friendlyPath = payload.bucketType === 'shared'
      ? `/${encodeURIComponent(payload.fileName)}`
      : `/${encodeURIComponent(payload.ownerSlug)}/${encodeURIComponent(payload.fileName)}`;

    return respondWithEmbed(res, embedPath, req.query, friendlyPath);
  } catch (err) {
    console.error('Rotating embed error:', err);
    return next();
  }
});

app.get('/media/embed/shared/:file', async (req, res) => {
  return respondWithEmbed(res, `shared/${req.params.file}`, req.query);
});

app.get('/media/embed/users/:userSlug/:file', async (req, res) => {
  const userSlug = slugifyMedia(req.params.userSlug);
  return respondWithEmbed(res, `users/${userSlug}/${req.params.file}`, req.query);
});

app.get('/media/embed/r/:token', async (req, res) => {
  try {
    const payload = await resolveRotatingToken(req.params.token);
    if (!payload) {
      return res.status(404).send('Not found');
    }

    const embedPath = payload.bucketType === 'shared'
      ? `shared/${payload.fileName}`
      : `users/${payload.ownerSlug}/${payload.fileName}`;

    return respondWithEmbed(res, embedPath, req.query, `/media/r/${req.params.token}`);
  } catch (err) {
    console.error('Rotating embed error:', err);
    return res.status(404).send('Not found');
  }
});

// Catch-all embed so every file path can produce an embed page
app.get('/media/embed/*', async (req, res) => {
  return respondWithEmbed(res, req.params[0], req.query);
});

async function respondWithEmbed(res, relativePath, query, fileUrlOverride) {
  try {
    const sanitizedPath = path.normalize(relativePath || '').replace(/^([.]{2}[\/])+/, '').replace(/^\//, '');
    if (!sanitizedPath) {
      return res.status(404).send('Not found');
    }

    const segments = sanitizedPath.split('/').filter(Boolean);
    if (!segments.length) {
      return res.status(404).send('Not found');
    }

    const [first, ...rest] = segments;
    let baseDir = MEDIA_ROOT;
    let relativeFilePath = sanitizedPath;

    if (first === 'users') {
      baseDir = MEDIA_USERS_DIR;
      relativeFilePath = rest.join('/');
    } else if (first === 'shared') {
      baseDir = MEDIA_SHARED_DIR;
      relativeFilePath = rest.join('/');
    }

    if (!relativeFilePath) {
      return res.status(404).send('Not found');
    }

    const diskPath = path.join(baseDir, relativeFilePath);
    await fs.promises.access(diskPath, fs.constants.R_OK);

    const encodedPath = segments.map(encodeURIComponent).join('/');
    const fileName = path.basename(diskPath);
    const tokenBucket = first === 'users'
      ? { type: 'private', ownerSlug: rest[0] }
      : { type: 'shared', ownerSlug: null };
    const friendlyPath = buildFriendlyMediaPath(tokenBucket, fileName);
    const fileUrl = fileUrlOverride || friendlyPath || `/media/${encodedPath}`;

    applyNoCache(res);
    res.type('text/html');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(renderEmbedPage(fileUrl, fileName, query));
  } catch {
    return res.status(404).send('Not found');
  }
}

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
    cb(null, `${unique}${ext.toLowerCase()}`);
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

// Friendly media URLs
app.get('/:userSlug/:fileName([A-Za-z0-9_-]+\.[A-Za-z0-9]{2,10})', async (req, res, next) => {
  try {
    const userSlug = slugifyMedia(req.params.userSlug);
    const fileName = path.basename(req.params.fileName);
    if (!userSlug || !fileName) return next();

    const filePath = path.join(MEDIA_USERS_DIR, userSlug, fileName);
    await fs.promises.access(filePath, fs.constants.R_OK);

    if (shouldServeEmbedPreview(req)) {
      return respondWithEmbed(
        res,
        `users/${userSlug}/${fileName}`,
        req.query,
        `/${encodeURIComponent(userSlug)}/${encodeURIComponent(fileName)}`
      );
    }

    setFriendlyMediaHeaders(res);
    return res.sendFile(path.resolve(filePath));
  } catch {
    return next();
  }
});

app.get('/:fileName([A-Za-z0-9_-]+\.[A-Za-z0-9]{2,10})', async (req, res, next) => {
  try {
    const fileName = path.basename(req.params.fileName);
    if (!fileName) return next();

    const filePath = path.join(MEDIA_SHARED_DIR, fileName);
    await fs.promises.access(filePath, fs.constants.R_OK);

    if (shouldServeEmbedPreview(req)) {
      return respondWithEmbed(
        res,
        `shared/${fileName}`,
        req.query,
        `/${encodeURIComponent(fileName)}`
      );
    }

    setFriendlyMediaHeaders(res);
    return res.sendFile(path.resolve(filePath));
  } catch {
    return next();
  }
});

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
    const shortPath = buildRotatingMediaPath(bucket, fileName);

    res.json({
      message: 'File uploaded',
      bucket: sanitizeBucketInfo(bucket),
      asset: {
        name: fileName,
        size: stats.size,
        createdAt: stats.birthtime,
        url: buildPublicMediaUrl(req, bucket, fileName),
        embedUrl: buildEmbedUrl(req, bucket, fileName),
        shortUrl: shortPath ? absoluteResourceUrl(req, shortPath) : null,
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
    
    // For private buckets, only owner can delete
    if (bucketInfo.type === 'private' && bucketInfo.ownerSlug !== slugifyMedia(req.currentUser.username)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    
    // For shared buckets, only owner can delete
    if (bucketInfo.type === 'shared' && !isOwnerUsername(req.currentUser.username)) {
      return res.status(403).json({ error: 'Only owner can delete shared media' });
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
      url: buildPublicMediaUrl(req, bucketInfo, fileName),
      embedUrl: buildEmbedUrl(req, bucketInfo, fileName),
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
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    
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
    urlPrefix: '/',
    ownerSlug: null
  };

  const { dir: userDir, slug: userSlug } = await ensureUserMediaDirForUsername(user.username);

  const personal = {
    id: `user-${userSlug}`,
    name: `${user.username}'s Media`,
    type: 'private',
    dir: userDir,
    urlPrefix: `/${encodeURIComponent(userSlug)}`,
    ownerSlug: userSlug
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
      urlPrefix: '/',
      ownerSlug: null
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
      urlPrefix: `/${encodeURIComponent(userSlug)}`,
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
    const shortPath = buildRotatingMediaPath(bucketInfo, file.name);
    const shortUrl = shortPath ? absoluteResourceUrl(req, shortPath) : null;
    assets.push({
      name: file.name,
      size: stats.size,
      createdAt: stats.birthtime,
      updatedAt: stats.mtime,
      url: buildPublicMediaUrl(req, bucketInfo, file.name),
      embedUrl: buildEmbedUrl(req, bucketInfo, file.name),
      shortUrl,
      bucketId: bucketInfo.id,
      bucketType: bucketInfo.type
    });
  }

  return assets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function buildPublicMediaUrl(req, bucketInfo, fileName) {
  const friendlyPath = buildFriendlyMediaPath(bucketInfo, fileName);
  if (!friendlyPath) return null;
  return absoluteResourceUrl(req, friendlyPath);
}

function buildEmbedUrl(req, bucketInfo, fileName) {
  const friendlyPath = buildFriendlyMediaPath(bucketInfo, fileName);
  if (!friendlyPath) return null;
  return absoluteResourceUrl(req, friendlyPath);
}

function buildRotatingMediaPath(bucketInfo, fileName) {
  const token = createRotationToken(bucketInfo, fileName);
  if (!token) return null;
  return `/${token}`;
}

function buildRotatingEmbedPath(bucketInfo, fileName) {
  const token = createRotationToken(bucketInfo, fileName);
  if (!token) return null;
  return `/${token}/embed`;
}

function buildFriendlyMediaPath(bucketInfo = {}, fileName = '') {
  const safeFile = encodeURIComponent(path.basename(fileName || ''));
  if (!safeFile) return null;

  if (bucketInfo.type === 'private') {
    const ownerSlug = slugifyMedia(bucketInfo.ownerSlug || '');
    if (!ownerSlug) return null;
    return `/${ownerSlug}/${safeFile}`;
  }

  return `/${safeFile}`;
}

function createRotationToken(bucketInfo = {}, fileName = '') {
  cleanupRotationCache();

  const normalizedFile = path.basename(fileName || '').trim();
  if (!normalizedFile) return null;

  const bucketType = bucketInfo.type === 'private' ? 'private' : 'shared';
  const ownerSlug = bucketType === 'private' ? slugifyMedia(bucketInfo.ownerSlug || '') : '';
  const interval = getCurrentRotationInterval();

  if (bucketType === 'private' && !ownerSlug) {
    return null;
  }

  const payloadKey = `${bucketType}:${ownerSlug}:${normalizedFile}:${interval}`;
  const existing = rotationPayloadMap.get(payloadKey);
  if (existing) {
    return existing.token;
  }

  let token = '';
  do {
    token = generateMediaKey(5);
  } while (rotationTokenMap.has(token));

  const payload = { bucketType, ownerSlug, fileName: normalizedFile, interval };
  rotationTokenMap.set(token, payload);
  rotationPayloadMap.set(payloadKey, { token, payload, interval });
  return token;
}

async function resolveRotatingToken(token) {
  cleanupRotationCache();

  if (!token || typeof token !== 'string') {
    return null;
  }

  const payload = rotationTokenMap.get(token);
  if (!payload || payload.interval !== getCurrentRotationInterval()) {
    return null;
  }

  const fileName = path.basename(payload.fileName || '');
  if (!fileName) return null;

  let baseDir = MEDIA_SHARED_DIR;
  let ownerSlug = '';
  let bucketType = 'shared';

  if (payload.bucketType === 'private') {
    ownerSlug = slugifyMedia(payload.ownerSlug || '');
    if (!ownerSlug) return null;
    baseDir = path.join(MEDIA_USERS_DIR, ownerSlug);
    bucketType = 'private';
  }

  const diskPath = path.join(baseDir, fileName);
  try {
    await fs.promises.access(diskPath, fs.constants.R_OK);
  } catch {
    return null;
  }

  return { diskPath, fileName, ownerSlug, bucketType };
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

function generateMediaKey(length = 5) {
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const targetLength = Math.max(1, Math.min(5, Math.floor(length) || 5));
  const letters = [];

  let hasUpper = false;
  let hasLower = false;

  for (let i = 0; i < targetLength; i++) {
    const useUpper = Math.random() < 0.6; // Bias toward uppercase for a punchier look
    const source = useUpper ? uppercase : lowercase;
    const char = source[Math.floor(Math.random() * source.length)];

    letters.push(char);

    if (useUpper) {
      hasUpper = true;
    } else {
      hasLower = true;
    }
  }

  // Ensure the key includes at least one lowercase character for better readability
  if (!hasLower && letters.length > 1) {
    const index = Math.floor(Math.random() * letters.length);
    letters[index] = lowercase[Math.floor(Math.random() * lowercase.length)];
    hasLower = true;
  }

  // Ensure at least one uppercase character when possible
  if (!hasUpper && letters.length > 0) {
    const index = 0;
    letters[index] = uppercase[Math.floor(Math.random() * uppercase.length)];
  }

  return letters.join('');
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

function getFriendlyBucketPrefix(bucketInfo = {}) {
  if (bucketInfo.type === 'shared') {
    return '/';
  }

  const slug = bucketInfo.ownerSlug || '';
  if (!slug) return '';

  return `/${encodeURIComponent(slug)}`;
}

function sanitizeBucketInfo(bucket) {
  return {
    id: bucket.id,
    name: bucket.name,
    type: bucket.type,
    ownerSlug: bucket.ownerSlug,
    urlPrefix: getFriendlyBucketPrefix(bucket) || bucket.urlPrefix
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
  const absoluteUrl = normalizeAbsoluteUrl(fileUrl);
  const ext = (path.extname(fileName || '') || '').toLowerCase();
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(ext);
  const isVideo = /\.(mp4|webm|ogg|mov|m4v)$/i.test(ext);
  const mimeType = getMimeType(fileName);
  const siteName = DOMAIN.replace(/^https?:\/\//, '');

  const commonMeta = `
    <meta charset="UTF-8">
    <title>${title}</title>
    <meta name="theme-color" content="${color}">
    <link rel="canonical" href="${absoluteUrl}">
    <meta property="og:url" content="${absoluteUrl}">
    <meta property="og:site_name" content="${siteName}">
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
    <meta property="og:video:width" content="1920">
    <meta property="og:video:height" content="1080">
    <meta property="og:image" content="${absoluteUrl}">
    <meta name="twitter:card" content="player">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:player" content="${absoluteUrl}">
    <meta name="twitter:player:width" content="1920">
    <meta name="twitter:player:height" content="1080">
    <meta name="twitter:player:stream" content="${absoluteUrl}">
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
    ? `<img class="embed-media" src="${absoluteUrl}" alt="${title}" />`
    : isVideo
      ? `<div class="embed-video-frame">
          <video class="embed-media" src="${absoluteUrl}" controls autoplay loop playsinline poster="" preload="metadata"></video>
         </div>`
      : `<a class="embed-link" href="${absoluteUrl}">${absoluteUrl}</a>`;

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    ${commonMeta}
    ${imageMeta}
    ${videoMeta}
    ${fallbackMeta}
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at top left, #0e1028, #050517 55%);
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        color: #f8fbff;
        font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        padding: 24px;
      }
      a { color: #8ecbff; word-break: break-all; }
      .embed-shell {
        width: min(720px, 100%);
        background: linear-gradient(145deg, rgba(18,21,43,0.9), rgba(10,12,27,0.92));
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 18px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.03) inset;
        overflow: hidden;
      }
      .embed-header {
        padding: 14px 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: rgba(255,255,255,0.02);
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .embed-title { font-weight: 700; letter-spacing: 0.01em; font-size: 16px; margin: 0; color: #fff; }
      .embed-url { font-size: 12px; color: rgba(255,255,255,0.7); margin-top: 2px; text-decoration: none; }
      .embed-body { padding: 16px; }
      .embed-media { width: 100%; max-height: 70vh; border-radius: 12px; display: block; background:#0b0d22; }
      .embed-video-frame { position: relative; }
      .embed-video-frame::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.55);
        pointer-events: none;
      }
      .embed-description { margin-top: 12px; color: rgba(255,255,255,0.82); font-size: 14px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <article class="embed-shell">
      <header class="embed-header">
        <div>
          <p class="embed-title">${title}</p>
          <a class="embed-url" href="${absoluteUrl}" target="_blank" rel="noopener">${absoluteUrl}</a>
        </div>
      </header>
      <div class="embed-body">
        ${mediaElement}
        <p class="embed-description">${description}</p>
      </div>
    </article>
    <script>
      (() => {
        const loader = document.getElementById('loader');
        const media = document.getElementById('embedMedia');

        function hideLoader() {
          if (loader) loader.classList.add('hidden');
        }

        if (media) {
          const doneEvents = ['canplay', 'loadeddata', 'loadedmetadata', 'load'];
          doneEvents.forEach((evt) => media.addEventListener(evt, hideLoader, { once: true }));
          media.addEventListener('error', () => {
            if (loader) loader.querySelector('p').textContent = 'Preview not available';
          });
        } else {
          hideLoader();
        }

        const stopEvent = (event) => {
          event.preventDefault();
          event.stopPropagation();
        };

        document.addEventListener('contextmenu', stopEvent);
        ['copy', 'cut', 'paste'].forEach((evt) => document.addEventListener(evt, stopEvent));

        document.addEventListener('keydown', (event) => {
          const key = event.key ? event.key.toLowerCase() : '';
          const ctrlOrMeta = event.ctrlKey || event.metaKey;

          const blockedShortcut =
            event.key === 'F12' ||
            (ctrlOrMeta && event.shiftKey && ['i', 'j', 'c'].includes(key)) ||
            (ctrlOrMeta && ['u', 's', 'p', 'c', 'a'].includes(key));

          if (blockedShortcut) {
            stopEvent(event);
          }
        });
      })();
    </script>
  </body>
  </html>`;
}

function normalizeAbsoluteUrl(url = '') {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const base = PUBLIC_URL || (DOMAIN.startsWith('http') ? DOMAIN : `https://${DOMAIN}`);
  return trimmed.startsWith('http') ? trimmed : `${base}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
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
