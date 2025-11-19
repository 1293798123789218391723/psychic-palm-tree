# LarpGod.xyz Website

Website for larpgod.xyz featuring a temporary/burner email system.

## Features

- **Blank Homepage** at `/` (larpgod.xyz/)
- **Temporary Email System** at `/email` (media.larpgod.xyz)
  - User authentication (register/login)
  - Create temporary email addresses: `???????@larpgod.xyz`
  - 5-hour TTL (configurable) for each email address
  - Receive and view emails in web UI
  - Automatic deletion after expiry

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```env
PORT=80
HOST=localhost
JWT_SECRET=your-secret-key-change-this-in-production
DATABASE_PATH=./larpgod.db
SMTP_HOST=smtp.larpgod.xyz
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
IMAP_HOST=imap.larpgod.xyz
IMAP_PORT=993
IMAP_USER=your-imap-user
IMAP_PASS=your-imap-password
DOMAIN=larpgod.xyz
```

**Required Configuration:**
- `JWT_SECRET`: Secret key for JWT tokens (use a strong random string in production)
- `DOMAIN`: Your domain (larpgod.xyz)
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS`: Required for receiving emails

**Note:** The email receiving functionality requires IMAP access to an email server that can receive mail for `@larpgod.xyz` addresses. You'll need to configure:
1. MX records pointing to your mail server
2. IMAP server access credentials
3. Email server configured to accept mail for `@larpgod.xyz` addresses

### 3. Start the Server

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

The server will start on `localhost:80` by default (or the port/host specified in `.env`).

**Note:** Running on port 80 requires root privileges on Ubuntu/Linux. You have several options:

1. **Run with sudo** (simplest):
   ```bash
   sudo npm start
   ```

2. **Use a reverse proxy** (recommended for production):
   - Install nginx: `sudo apt install nginx`
   - Configure nginx to proxy requests to your app on a non-privileged port (e.g., 3000)
   - Run the app on port 3000 without sudo

3. **Use authbind** (allows non-root to bind to port 80):
   ```bash
   sudo apt install authbind
   sudo touch /etc/authbind/byport/80
   sudo chmod 500 /etc/authbind/byport/80
   sudo chown $USER /etc/authbind/byport/80
   authbind --deep npm start
   ```

4. **Use setcap** (Linux capabilities):
   ```bash
   sudo setcap 'cap_net_bind_service=+ep' $(which node)
   npm start
   ```

Alternatively, you can set `PORT=3000` in your `.env` file to use a non-privileged port.

## API Endpoints

### Authentication
- `POST /api/register` - Register a new user
- `POST /api/login` - Login user

### Email Addresses (Protected)
- `POST /api/email-addresses` - Create a new temporary email address
- `GET /api/email-addresses` - Get all email addresses for logged-in user
- `DELETE /api/email-addresses/:id` - Delete an email address

### Messages (Protected)
- `GET /api/messages` - Get all messages for logged-in user
- `GET /api/email-addresses/:id/messages` - Get messages for a specific email address

## How It Works

1. **User Registration/Login**: Users create an account and log in
2. **Email Address Creation**: Logged-in users can create temporary email addresses
   - Each address has a unique 12-character local part (e.g., `a1b2c3d4e5f6@larpgod.xyz`)
   - Default TTL is 5 hours (configurable)
3. **Email Reception**: The system monitors incoming emails via IMAP
   - When an email arrives for an active temporary address, it's stored in the database
4. **Email Viewing**: Users can view all messages in the web UI
5. **Automatic Cleanup**: A cron job runs hourly to delete expired addresses and their messages

## Tech Stack

- **Backend**: Node.js, Express
- **Database**: SQLite
- **Authentication**: JWT (JSON Web Tokens)
- **Email**: IMAP for receiving, Mailparser for parsing
- **Frontend**: Vanilla JavaScript, HTML, CSS

## Deployment Notes

1. Set up proper DNS MX records for `@larpgod.xyz`
2. Configure your mail server to accept emails for all addresses at `@larpgod.xyz`
3. Use a strong `JWT_SECRET` in production
4. Consider using PostgreSQL instead of SQLite for production
5. Set up proper SSL/TLS certificates
6. Configure CORS appropriately for your domain

## License

ISC
