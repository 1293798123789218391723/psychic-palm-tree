const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const EMAIL_QUERY = 'to:larpgod.xyz';
const POLL_INTERVAL_MS = parseInt(process.env.GMAIL_POLL_INTERVAL_MS || '15000', 10);
const MAX_STORED = 50;

let gmail = null;
let seenMessageIds = new Set();
const recentEmails = [];

function loadAuth() {
  try {
    const credsPath = path.join(__dirname, 'gmail_credentials.json');
    const tokenPath = path.join(__dirname, 'gmail_token.json');
    if (!fs.existsSync(credsPath) || !fs.existsSync(tokenPath)) {
      console.warn('Gmail poller: credentials missing; skipping.');
      return null;
    }
    const gmailCreds = require(credsPath);
    const gmailToken = require(tokenPath);
    const oAuth2Client = new google.auth.OAuth2(
      gmailCreds.installed.client_id,
      gmailCreds.installed.client_secret,
      gmailCreds.installed.redirect_uris[0]
    );
    oAuth2Client.setCredentials(gmailToken);
    return google.gmail({ version: 'v1', auth: oAuth2Client });
  } catch (err) {
    console.error('Gmail poller auth error:', err);
    return null;
  }
}

async function primeSeenMessages() {
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: EMAIL_QUERY,
    labelIds: ['INBOX'],
    maxResults: 20,
  });
  const messages = listRes.data.messages || [];
  messages.forEach((m) => seenMessageIds.add(m.id));
}

function decodeBody(body) {
  if (!body || !body.data) return '';
  const str = body.data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(str, 'base64').toString('utf8');
}

function getPlainTextFromPayload(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return decodeBody(payload.body);
  }
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      const text = getPlainTextFromPayload(part);
      if (text) return text;
    }
  }
  return '';
}

function getHeader(headers, name) {
  const h = headers.find((h) => h.name === name);
  return h ? h.value : '';
}

function trimBody(body) {
  const MAX_BODY_CHARS = 1000;
  if (body.length <= MAX_BODY_CHARS) return body;
  return body.slice(0, MAX_BODY_CHARS) + '\n\n[truncated]';
}

async function checkNewEmails() {
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: EMAIL_QUERY,
    labelIds: ['INBOX'],
    maxResults: 20,
  });
  const messages = listRes.data.messages || [];
  const newMessages = messages.filter((m) => !seenMessageIds.has(m.id)).reverse();
  if (!newMessages.length) return;

  for (const msg of newMessages) {
    try {
      const detailRes = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const payload = detailRes.data.payload || {};
      const headers = payload.headers || [];

      const from = getHeader(headers, 'From') || '(unknown)';
      const to = getHeader(headers, 'To') || '(unknown)';
      const subject = getHeader(headers, 'Subject') || '(no subject)';
      const date = getHeader(headers, 'Date') || '(unknown)';

      let bodyText = getPlainTextFromPayload(payload).trim();
      if (!bodyText) bodyText = '(no body)';

      const email = {
        id: msg.id,
        from,
        to,
        subject,
        date,
        body: trimBody(bodyText),
        createdAt: new Date().toISOString(),
      };

      seenMessageIds.add(msg.id);
      recentEmails.unshift(email);
      if (recentEmails.length > MAX_STORED) recentEmails.length = MAX_STORED;
    } catch (err) {
      console.error('Gmail poller message error:', msg.id, err);
    }
  }
}

async function runLoop() {
  while (true) {
    try {
      await checkNewEmails();
    } catch (err) {
      console.error('Gmail poller loop error:', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function start() {
  gmail = loadAuth();
  if (!gmail) return;
  try {
    await primeSeenMessages();
    runLoop();
    console.log('Gmail poller started');
  } catch (err) {
    console.error('Gmail poller start failed:', err);
  }
}

function getRecentEmails() {
  return recentEmails.slice(0, 25);
}

module.exports = { start, getRecentEmails };
