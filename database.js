const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Default to the fixed host path while still allowing overrides for local development.
const DEFAULT_DB_PATH = '/home/mesh/data/larpgod.db';
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

// Ensure the directory exists before opening the database file.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          console.error('Error opening database:', err);
          reject(err);
        } else {
          console.log('Connected to SQLite database');
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    return new Promise((resolve, reject) => {
      const queries = [
        // Users table
        `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        
        // Temporary email addresses table
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
        
        // Messages table
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
        )`
      ];

      let completed = 0;
      queries.forEach((query) => {
        this.db.run(query, (err) => {
          if (err) {
            console.error('Error creating table:', err);
            reject(err);
          } else {
            completed++;
            if (completed === queries.length) {
              // Create indexes
              this.db.run(`CREATE INDEX IF NOT EXISTS idx_email_addresses_user ON email_addresses(user_id)`, () => {});
              this.db.run(`CREATE INDEX IF NOT EXISTS idx_email_addresses_expires ON email_addresses(expires_at)`, () => {});
              this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_address ON messages(email_address_id)`, () => {});
              resolve();
            }
          }
        });
      });
    });
  }

  // User methods
  async createUser(username, passwordHash) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [username, passwordHash],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, username });
        }
      );
    });
  }

  async getUserByUsername(username) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM users WHERE username = ?',
        [username],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async getUserById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM users WHERE id = ?',
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async getAllUsers() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, username, created_at FROM users ORDER BY created_at DESC',
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  // Email address methods
  async createEmailAddress(userId, localPart, fullAddress, ttlHours = 5) {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO email_addresses (user_id, local_part, full_address, expires_at) VALUES (?, ?, ?, ?)',
        [userId, localPart, fullAddress, expiresAt],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, localPart, fullAddress, expiresAt });
        }
      );
    });
  }

  async getEmailAddressesByUserId(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM email_addresses 
         WHERE user_id = ? AND is_active = 1 AND expires_at > datetime('now')
         ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async getEmailAddressByLocalPart(localPart) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM email_addresses 
         WHERE local_part = ? AND is_active = 1 AND expires_at > datetime('now')`,
        [localPart],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async getEmailAddressById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM email_addresses WHERE id = ?',
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async deactivateEmailAddress(id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE email_addresses SET is_active = 0 WHERE id = ?',
        [id],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
  }

  // Message methods
  async createMessage(emailAddressId, fromAddress, subject, bodyText, bodyHtml, headers) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO messages (email_address_id, from_address, subject, body_text, body_html, headers) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [emailAddressId, fromAddress, subject, bodyText, bodyHtml, JSON.stringify(headers)],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  }

  async getMessagesByEmailAddressId(emailAddressId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM messages WHERE email_address_id = ? ORDER BY received_at DESC',
        [emailAddressId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async getAllMessagesByUserId(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT m.*, e.local_part, e.full_address 
         FROM messages m
         JOIN email_addresses e ON m.email_address_id = e.id
         WHERE e.user_id = ? AND e.is_active = 1
         ORDER BY m.received_at DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  // Cleanup expired addresses and their messages
  async cleanupExpiredAddresses() {
    return new Promise((resolve, reject) => {
      // First, delete messages for expired addresses
      this.db.run(
        `DELETE FROM messages 
         WHERE email_address_id IN (
           SELECT id FROM email_addresses 
           WHERE expires_at <= datetime('now')
         )`,
        (err) => {
          if (err) {
            reject(err);
          } else {
            // Then delete expired addresses
            this.db.run(
              `DELETE FROM email_addresses 
               WHERE expires_at <= datetime('now')`,
              function(err2) {
                if (err2) reject(err2);
                else resolve({ deletedAddresses: this.changes });
              }
            );
          }
        }
      );
    });
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = new Database();
