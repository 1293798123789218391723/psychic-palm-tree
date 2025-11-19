const { google } = require("googleapis");
const fetch = require("node-fetch");
const gmailCreds = require("./gmail_credentials.json");
const gmailToken = require("./gmail_token.json");

// 1) Your Discord webhook
const DISCORD_WEBHOOK =
  "https://discord.com/api/webhooks/1274000497430364320/vAWOOfswTBxYEbO1Dv4FTJzgLEC_pNRr-t-d269mfovTf5ynWrMRVvTLs2KpddYOvJKx";

// 2) Set up Gmail OAuth client using saved token
const oAuth2Client = new google.auth.OAuth2(
  gmailCreds.installed.client_id,
  gmailCreds.installed.client_secret,
  gmailCreds.installed.redirect_uris[0]
);
oAuth2Client.setCredentials(gmailToken);

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// Small helper: sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getHeader(headers, name) {
  const h = headers.find((h) => h.name === name);
  return h ? h.value : "";
}

// Decode Gmail base64url body
function decodeBody(body) {
  if (!body || !body.data) return "";
  const str = body.data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(str, "base64").toString("utf8");
}

// Recursively find the first text/plain part
function getPlainTextFromPayload(payload) {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body && payload.body.data) {
    return decodeBody(payload.body);
  }

  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      const text = getPlainTextFromPayload(part);
      if (text) return text;
    }
  }

  return "";
}

// Track message IDs we've already sent to Discord
const seenMessageIds = new Set();

// Prime the watcher so it *does not* send old emails on startup
async function primeSeenMessages() {
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "to:larpgod.xyz",
    labelIds: ["INBOX"],
    maxResults: 20,
  });

  const messages = listRes.data.messages || [];
  for (const m of messages) {
    seenMessageIds.add(m.id);
  }

  console.log(`Primed with ${messages.length} existing messages (no notifications sent for them).`);
}

// Check for new emails and send them to Discord
async function checkNewEmails() {
  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "to:larpgod.xyz",
    labelIds: ["INBOX"],
    maxResults: 20,
  });

  const messages = listRes.data.messages || [];
  if (!messages.length) return;

  // Only messages we haven't seen before
  const newMessages = messages.filter((m) => !seenMessageIds.has(m.id));

  if (!newMessages.length) return;

  // Process oldest first so Discord shows them in chronological order
  newMessages.reverse();

  for (const msg of newMessages) {
    try {
      const detailRes = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      const payload = detailRes.data.payload || {};
      const headers = payload.headers || [];

      const from = getHeader(headers, "From") || "(unknown)";
      const to = getHeader(headers, "To") || "(unknown)";
      const subject = getHeader(headers, "Subject") || "(no subject)";
      const date = getHeader(headers, "Date") || "(unknown)";

      // Get plain text content
      let bodyText = getPlainTextFromPayload(payload).trim();
      if (!bodyText) {
        bodyText = "(no body)";
      }

      // Trim for Discord safety (embed field limit + code block)
      let trimmedBody = bodyText;
      const MAX_BODY_CHARS = 1000;
      if (trimmedBody.length > MAX_BODY_CHARS) {
        trimmedBody = trimmedBody.slice(0, MAX_BODY_CHARS) + "\n\n[truncated]";
      }

      const bodyFieldValue = "```text\n" + trimmedBody + "\n```";

      const discordPayload = {
        username: "LarpGod Mail Bot",
        embeds: [
          {
            title: "New Email to @larpgod.xyz",
            description: `A new email was received for the domain \`@larpgod.xyz\`.`,
            fields: [
              { name: "From", value: from, inline: false },
              { name: "To", value: to, inline: false },
              { name: "Subject", value: subject, inline: false },
              { name: "Date", value: date, inline: false },
              { name: "Body (first 1000 chars)", value: bodyFieldValue, inline: false },
            ],
          },
        ],
      };

      const res = await fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload),
      });

      if (!res.ok) {
        console.error("Failed to send to Discord:", res.status, await res.text());
      } else {
        console.log("Sent to Discord:", msg.id);
        seenMessageIds.add(msg.id);
      }
    } catch (err) {
      console.error("Error processing message", msg.id, err);
    }
  }
}

// Main loop: runs "forever"
async function run() {
  console.log("Starting Gmail -> Discord watcher...");

  await primeSeenMessages();

  while (true) {
    try {
      await checkNewEmails();
    } catch (err) {
      console.error("Error in checkNewEmails:", err);
    }

    // Poll interval (e.g. 5 seconds)
    await sleep(5000);
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
});


