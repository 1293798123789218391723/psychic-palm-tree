const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Fixed host path for production deployments; can be overridden for local use via DB_PATH.
const DEFAULT_DB_PATH = '/home/mesh/data/larpgod.db';
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

// Ensure the database directory exists before connecting.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) {
      return this;
    }

    this.db = await this.#open();
    await this.#applyPragmas();
    await this.#createSchema();
    console.log(`Using SQLite database at: ${DB_PATH}`);
    return this;
  }

  #open() {
    return new Promise((resolve, reject) => {
      const connection = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
        if (err) {
          console.error('Error opening database:', err);
          reject(err);
        } else {
          resolve(connection);
        }
      });
    });
  }

  #applyPragmas() {
    return this.run('PRAGMA foreign_keys = ON');
  }

  async #createSchema() {
    const createStatements = [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS email_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        local_part TEXT NOT NULL,
        full_address TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(local_part)
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_address_id INTEGER NOT NULL,
        from_address TEXT NOT NULL,
        subject TEXT,
        body_text TEXT,
        body_html TEXT,
        headers TEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (email_address_id) REFERENCES email_addresses(id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_email_addresses_user ON email_addresses(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_email_addresses_expires ON email_addresses(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_messages_address ON messages(email_address_id)'
    ];

    for (const statement of createStatements) {
      await this.run(statement);
    }
  }

  // Lightweight promisified helpers
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  // User methods
  async createUser(username, passwordHash) {
    const result = await this.run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );
    return { id: result.lastID, username };
  }

  getUserByUsername(username) {
    return this.get('SELECT * FROM users WHERE username = ?', [username]);
  }

  getUserById(id) {
    return this.get('SELECT * FROM users WHERE id = ?', [id]);
  }

  getAllUsers() {
    return this.all('SELECT id, username, created_at FROM users ORDER BY created_at DESC');
  }

  // Email address methods
  async createEmailAddress(userId, localPart, fullAddress, ttlHours = 5) {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
    const result = await this.run(
      'INSERT INTO email_addresses (user_id, local_part, full_address, expires_at) VALUES (?, ?, ?, ?)',
      [userId, localPart, fullAddress, expiresAt]
    );
    return { id: result.lastID, localPart, fullAddress, expiresAt };
  }

  getEmailAddressesByUserId(userId) {
    return this.all(
      `SELECT * FROM email_addresses
         WHERE user_id = ? AND is_active = 1 AND expires_at > datetime('now')
         ORDER BY created_at DESC`,
      [userId]
    );
  }

  getEmailAddressByLocalPart(localPart) {
    return this.get(
      `SELECT * FROM email_addresses
         WHERE local_part = ? AND is_active = 1 AND expires_at > datetime('now')`,
      [localPart]
    );
  }

  getEmailAddressById(id) {
    return this.get('SELECT * FROM email_addresses WHERE id = ?', [id]);
  }

  deactivateEmailAddress(id) {
    return this.run('UPDATE email_addresses SET is_active = 0 WHERE id = ?', [id]);
  }

  // Message methods
  async createMessage(emailAddressId, fromAddress, subject, bodyText, bodyHtml, headers) {
    const result = await this.run(
      `INSERT INTO messages (email_address_id, from_address, subject, body_text, body_html, headers)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [emailAddressId, fromAddress, subject, bodyText, bodyHtml, JSON.stringify(headers)]
    );
    return { id: result.lastID };
  }

  getMessagesByEmailAddressId(emailAddressId) {
    return this.all(
      'SELECT * FROM messages WHERE email_address_id = ? ORDER BY received_at DESC',
      [emailAddressId]
    );
  }

  getAllMessagesByUserId(userId) {
    return this.all(
      `SELECT m.*, e.local_part, e.full_address
         FROM messages m
         JOIN email_addresses e ON m.email_address_id = e.id
         WHERE e.user_id = ? AND e.is_active = 1
         ORDER BY m.received_at DESC`,
      [userId]
    );
  }

  // Cleanup expired addresses and their messages
  async cleanupExpiredAddresses() {
    // Delete messages linked to expired email addresses first, then the addresses themselves.
    await this.run(
      `DELETE FROM messages
         WHERE email_address_id IN (
           SELECT id FROM email_addresses WHERE expires_at <= datetime('now')
         )`
    );

    const deletion = await this.run(
      `DELETE FROM email_addresses
         WHERE expires_at <= datetime('now')`
    );

    return { deletedAddresses: deletion.changes };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

const databaseInstance = new Database();
// Export the resolved and default database paths for visibility.
databaseInstance.DB_PATH = DB_PATH;
databaseInstance.DEFAULT_DB_PATH = DEFAULT_DB_PATH;

module.exports = databaseInstance;
