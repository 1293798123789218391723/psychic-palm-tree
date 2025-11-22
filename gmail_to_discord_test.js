const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const fetch = require('node-fetch');

const EMAIL_QUERY = process.env.DISCORD_MAIL_QUERY || 'to:larpgod.xyz';
const POLL_INTERVAL_MS = parseInt(process.env.DISCORD_MAIL_POLL_INTERVAL_MS || '5000', 10);
const MAX_PRIME_RESULTS = parseInt(process.env.DISCORD_MAIL_PRIME_MAX_RESULTS || '20', 10);

let gmailClient = null;
let webhookUrl = null;
let isRunning = false;
const seenMessageIds = new Set();

function getWebhookFromEnv() {
  const base64Webhook = process.env.DISCORD_MAIL_WEBHOOK_B64;
  if (base64Webhook) {
    try {
      return Buffer.from(base64Webhook, 'base64').toString('utf8').trim();
    } catch (err) {
      console.warn('Discord mail relay: failed to decode base64 webhook, falling back to plain env var.', err.message);
    }
  }

  const plainWebhook = process.env.DISCORD_MAIL_WEBHOOK || process.env.DISCORD_WEBHOOK_URL;
  return plainWebhook ? plainWebhook.trim() : '';
}

function maskWebhook(url) {
  if (!url) return '(not set)';
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.slice(-6);
    return `${parsed.origin}/...${tail}`;
  } catch {
    return '(hidden)';
  }
}

function loadGmailClient() {
  const credsPath = path.join(__dirname, 'gmail_credentials.json');
  const tokenPath = path.join(__dirname, 'gmail_token.json');

  if (!fs.existsSync(credsPath) || !fs.existsSync(tokenPath)) {
    console.warn('Discord mail relay: missing gmail_credentials.json or gmail_token.json; skipping startup.');
    return null;
  }

  try {
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
    console.error('Discord mail relay: failed to initialize Gmail client:', err);
    return null;
  }
}

function getHeader(headers, name) {
  const h = headers.find((header) => header.name === name);
  return h ? h.value : '';
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

async function primeSeenMessages() {
  const listRes = await gmailClient.users.messages.list({
    userId: 'me',
    q: EMAIL_QUERY,
    labelIds: ['INBOX'],
    maxResults: MAX_PRIME_RESULTS,
  });

  const messages = listRes.data.messages || [];
  messages.forEach((m) => seenMessageIds.add(m.id));
  console.log(`Discord mail relay primed with ${messages.length} existing messages (no notifications will be sent for them).`);
}

function trimBody(bodyText) {
  const MAX_BODY_CHARS = 1000;
  if (!bodyText) return '(no body)';
  if (bodyText.length <= MAX_BODY_CHARS) return bodyText.trim();
  return `${bodyText.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
}

async function sendToDiscord(messagePayload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messagePayload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook responded with ${response.status}: ${text}`);
  }
}

async function checkNewEmails() {
  const listRes = await gmailClient.users.messages.list({
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
      const detailRes = await gmailClient.users.messages.get({
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
      const bodyText = trimBody(getPlainTextFromPayload(payload).trim());
      const bodyFieldValue = `\n\n\u0060\u0060\u0060text\n${bodyText}\n\u0060\u0060\u0060`;

      const discordPayload = {
        username: 'LarpGod Mail Bot',
        embeds: [
          {
            title: 'New Email to @larpgod.xyz',
            description: 'A new email was received for the domain `@larpgod.xyz`.',
            fields: [
              { name: 'From', value: from, inline: false },
              { name: 'To', value: to, inline: false },
              { name: 'Subject', value: subject, inline: false },
              { name: 'Date', value: date, inline: false },
              { name: 'Body (first 1000 chars)', value: bodyFieldValue, inline: false },
            ],
          },
        ],
      };

      await sendToDiscord(discordPayload);
      console.log(`Discord mail relay sent message ${msg.id}`);
      seenMessageIds.add(msg.id);
    } catch (err) {
      console.error('Discord mail relay message error:', msg.id, err);
    }
  }
}

async function runLoop() {
  while (isRunning) {
    try {
      await checkNewEmails();
    } catch (err) {
      console.error('Discord mail relay loop error:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function start() {
  if (isRunning) return;

  webhookUrl = getWebhookFromEnv();
  if (!webhookUrl) {
    console.warn('Discord mail relay: webhook not configured; skipping startup.');
    return;
  }

  gmailClient = loadGmailClient();
  if (!gmailClient) return;

  isRunning = true;
  try {
    await primeSeenMessages();
    runLoop();
    console.log(`Discord mail relay started (webhook ${maskWebhook(webhookUrl)})`);
  } catch (err) {
    isRunning = false;
    console.error('Discord mail relay failed to start:', err);
  }
}

module.exports = { start };
