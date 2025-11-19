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
const PORT = process.env.PORT || 80;
const HOST = process.env.HOST || 'localhost';
const DOMAIN = process.env.DOMAIN || 'larpgod.xyz';
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'dot').toLowerCase();
const MEDIA_ROOT = path.join(__dirname, 'media');
const MEDIA_SHARED_DIR = path.join(MEDIA_ROOT, 'shared');
const MEDIA_USERS_DIR = path.join(MEDIA_ROOT, 'users');
const MEDIA_MAX_FILE_MB = parseInt(process.env.MEDIA_MAX_FILE_MB || '100', 10);
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const EMBED_PREFS_FILE = path.join(__dirname, 'db', 'embed-prefs.json');

ensureDirSync(MEDIA_SHARED_DIR);
ensureDirSync(MEDIA_USERS_DIR);
ensureDirSync(path.dirname(EMBED_PREFS_FILE));

let globalEmbedPrefs = loadEmbedPrefsFromDisk();

app.use('/media', express.static(MEDIA_ROOT, {
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// Media embed (Discord-friendly)
app.get('/media/embed/shared/:file', async (req, res) => {
  try {
    const fileName = path.basename(req.params.file);
    const filePath = path.join(MEDIA_SHARED_DIR, fileName);
    await fs.promises.access(filePath, fs.constants.R_OK);
    const fileUrl = `/media/shared/${encodeURIComponent(fileName)}`;
    return res.type('text/html').send(renderEmbedPage(fileUrl, fileName, req.query));
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
    return res.type('text/html').send(renderEmbedPage(fileUrl, fileName, req.query));
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

const mediaUpload = multer({
  storage: mediaStorage,
  limits: {
    fileSize: MEDIA_MAX_FILE_MB * 1024 * 1024
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(`window.__LARP_CONFIG__ = ${JSON.stringify({
    ownerUsername: OWNER_USERNAME,
  })};`);
});
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
database.init().then(() => {
  console.log('Database initialized');
  
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
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Auth routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!isValidUsername(username) || !isValidPassword(password)) {
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

    if (!isValidUsername(username) || !isValidPassword(password)) {
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

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
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

app.post('/api/media/upload', auth.authenticateToken, attachCurrentUser, requireApprovedUser, resolveMediaBucket, mediaUpload.single('file'), async (req, res) => {
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
    const { username } = req.body;

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }

    await approvals.addUser(username);
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
    // Use user ID for rate limiting
    return req.currentUser?.id?.toString() || req.ip;
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
    return req.currentUser?.id?.toString() || req.ip;
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

  const userSlug = slugifyMedia(user.username);
  const userDir = path.join(MEDIA_USERS_DIR, userSlug);
  await fs.promises.mkdir(userDir, { recursive: true });

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
    const dir = path.join(MEDIA_USERS_DIR, userSlug);
    await fs.promises.mkdir(dir, { recursive: true });
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
  const stamp = Date.now().toString();
  const random = Math.random().toString().slice(2, 8);
  return `67${stamp}${random}67`;
}

function slugifyMedia(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'media';
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
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <meta name="theme-color" content="${color}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:type" content="video.other">
    <meta property="og:video" content="${absoluteUrl}">
    <meta property="og:video:url" content="${absoluteUrl}">
    <meta property="og:video:secure_url" content="${absoluteUrl}">
    <meta property="og:video:type" content="video/mp4">
    <meta property="og:video:width" content="720">
    <meta property="og:video:height" content="1280">
    <meta name="twitter:card" content="player">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:player" content="${absoluteUrl}">
    <meta name="twitter:player:width" content="720">
    <meta name="twitter:player:height" content="1280">
    <style>body{margin:0;background:#050517;display:flex;align-items:center;justify-content:center;height:100vh;color:#fff;font-family:Arial,sans-serif;}a{color:#7ab9ff;}video{max-width:90vw;max-height:90vh;border-radius:12px;}</style>
  </head>
  <body>
    <video src="${absoluteUrl}" controls autoplay loop playsinline></video>
    <script>
      document.addEventListener('click', ()=>{const audio=new Audio('https://cdn.pixabay.com/audio/2025/09/02/audio_4e70a465f7.mp3');audio.play().catch(()=>{});},{once:true});
    </script>
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
