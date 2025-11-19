const Imap = require('imap');
const { simpleParser } = require('mailparser');
const database = require('./database');
require('dotenv').config();

const IMAP_HOST = process.env.IMAP_HOST || 'imap.larpgod.xyz';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;
const DOMAIN = process.env.DOMAIN || 'larpgod.xyz';

class EmailReceiver {
  constructor() {
    this.imap = null;
    this.isConnected = false;
  }

  connect() {
    if (!IMAP_USER || !IMAP_PASS) {
      console.warn('IMAP credentials not configured. Email receiving disabled.');
      return;
    }

    this.imap = new Imap({
      user: IMAP_USER,
      password: IMAP_PASS,
      host: IMAP_HOST,
      port: IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    this.imap.once('ready', () => {
      console.log('IMAP connection ready');
      this.isConnected = true;
      this.openInbox();
    });

    this.imap.once('error', (err) => {
      console.error('IMAP error:', err);
      this.isConnected = false;
    });

    this.imap.once('end', () => {
      console.log('IMAP connection ended');
      this.isConnected = false;
      // Reconnect after 5 seconds
      setTimeout(() => this.connect(), 5000);
    });

    this.imap.connect();
  }

  openInbox() {
    this.imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        console.error('Error opening inbox:', err);
        return;
      }

      console.log('Opened inbox. Total messages:', box.messages.total);
      
      // Check for new messages
      this.checkForNewMessages();

      // Set up listener for new messages
      this.imap.on('mail', () => {
        console.log('New mail detected');
        this.checkForNewMessages();
      });
    });
  }

  checkForNewMessages() {
    if (!this.isConnected) return;

    this.imap.search(['UNSEEN'], (err, results) => {
      if (err) {
        console.error('Error searching for messages:', err);
        return;
      }

      if (!results || results.length === 0) {
        return;
      }

      const fetch = this.imap.fetch(results, { bodies: '', struct: true });

      fetch.on('message', (msg, seqno) => {
        let emailData = {};

        msg.on('body', (stream, info) => {
          let buffer = '';
          stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
          });
          stream.once('end', () => {
            simpleParser(buffer).then((parsed) => {
              emailData = parsed;
            }).catch((err) => {
              console.error('Error parsing email:', err);
            });
          });
        });

        msg.once('attributes', (attrs) => {
          emailData.headers = attrs.struct;
        });

        msg.once('end', async () => {
          try {
            await this.processMessage(emailData);
          } catch (err) {
            console.error('Error processing message:', err);
          }
        });
      });

      fetch.once('error', (err) => {
        console.error('Fetch error:', err);
      });
    });
  }

  async processMessage(emailData) {
    if (!emailData.to || !emailData.from) {
      return;
    }

    // Extract the local part from the recipient address
    const toAddress = Array.isArray(emailData.to) 
      ? emailData.to[0].address 
      : emailData.to.address || emailData.to.text;

    if (!toAddress || !toAddress.includes('@')) {
      return;
    }

    const [localPart, domain] = toAddress.split('@');
    
    if (domain !== DOMAIN) {
      return;
    }

    // Check if this email address exists in our database
    const emailAddress = await database.getEmailAddressByLocalPart(localPart);
    
    if (!emailAddress) {
      console.log(`No active email address found for: ${localPart}`);
      return;
    }

    const fromAddress = Array.isArray(emailData.from)
      ? emailData.from[0].address
      : emailData.from.address || emailData.from.text;

    // Save message to database
    await database.createMessage(
      emailAddress.id,
      fromAddress || 'unknown@unknown.com',
      emailData.subject || '(No Subject)',
      emailData.text || '',
      emailData.html || '',
      emailData.headers || {}
    );

    console.log(`Message saved for ${emailAddress.full_address} from ${fromAddress}`);
  }

  start() {
    if (IMAP_USER && IMAP_PASS) {
      this.connect();
    } else {
      console.log('Email receiving not configured. To enable, set IMAP_USER and IMAP_PASS in .env');
    }
  }

  stop() {
    if (this.imap) {
      this.imap.end();
    }
  }
}

module.exports = new EmailReceiver();
