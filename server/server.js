const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool, init } = require('./db');
const { signToken, verifyToken, SECRET } = require('./auth');
const { validateUsername, validatePassword, validateAvatarColor, validateMessageText } = require('./validate');

// CORS_ORIGIN can be a comma-separated list of allowed origins for deployments
// where the client is hosted separately from this API. By default (unset) we
// reflect the request's own origin, which is what same-origin deployments
// (client served by this same process, as set up below) need.
const corsOptions = { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true };

const app = express();

// Needed so express-rate-limit sees the real client IP when running behind a
// reverse proxy / load balancer (Render, Railway, etc. all put one in front).
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.socket.io'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  }
}));
app.use(cors(corsOptions));
app.use(express.json({ limit: '100kb' }));

// General API rate limit, plus a stricter one specifically on auth endpoints
// (registration/login) to slow down credential-stuffing and brute-force attempts.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

// Serve the frontend from the sibling /client folder so the whole app is one process/one port.
app.use(express.static(path.join(__dirname, '..', 'client')));

// Wrap async route handlers so a rejected promise reaches Express's error
// handling instead of crashing the process or hanging the request.
function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---------------- Auth ----------------

app.post('/api/auth/register', ah(async (req, res) => {
  const { username, password } = req.body || {};
  const uname = typeof username === 'string' ? username.trim() : '';

  const usernameError = validateUsername(uname);
  if (usernameError) return res.status(400).json({ error: usernameError });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  const existing = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [uname]);
  if (existing.rows.length) return res.status(409).json({ error: 'That username is already taken' });

  const hash = bcrypt.hashSync(password, 12);
  const insert = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
    [uname, hash]
  );
  const user = insert.rows[0];
  res.json({ token: signToken(user), user });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [(username || '').trim()]);
  const row = result.rows[0];
  // Same generic error whether the username doesn't exist or the password is
  // wrong, so a caller can't use this endpoint to enumerate valid usernames.
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signToken(row), user: { id: row.id, username: row.username } });
}));

// ---------------- Profile ----------------

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    avatarColor: row.avatar_color,
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
    aiGames: row.ai_games
  };
}

async function getUserById(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

app.get('/api/me', verifyToken, ah(async (req, res) => {
  const row = await getUserById(req.user.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(row));
}));

app.patch('/api/me', verifyToken, ah(async (req, res) => {
  const { avatarColor } = req.body || {};
  if (avatarColor !== undefined) {
    const colorError = validateAvatarColor(avatarColor);
    if (colorError) return res.status(400).json({ error: colorError });
    await pool.query('UPDATE users SET avatar_color = $1 WHERE id = $2', [avatarColor, req.user.id]);
  }
  const row = await getUserById(req.user.id);
  res.json(publicUser(row));
}));

// ---------------- Game results (vs AI, tracked server-side) ----------------

app.post('/api/game/result', verifyToken, ah(async (req, res) => {
  const { result } = req.body || {}; // 'win' | 'loss'
  if (result !== 'win' && result !== 'loss') return res.status(400).json({ error: "result must be 'win' or 'loss'" });

  const row = await getUserById(req.user.id);
  if (!row) return res.status(404).json({ error: 'User not found' });

  let rating = row.rating, wins = row.wins, losses = row.losses;
  if (result === 'win') { rating += 25; wins += 1; }
  else { rating = Math.max(0, rating - 20); losses += 1; }

  await pool.query(
    'UPDATE users SET rating = $1, wins = $2, losses = $3, ai_games = ai_games + 1 WHERE id = $4',
    [rating, wins, losses, req.user.id]
  );
  res.json({ rating, wins, losses });
}));

// ---------------- Friends (real accounts, request/accept) ----------------

app.get('/api/friends', verifyToken, ah(async (req, res) => {
  const uid = req.user.id;

  const friends = await pool.query(
    `SELECT u.id, u.username, u.avatar_color AS "avatarColor", u.rating
     FROM friend_links f
     JOIN users u ON u.id = (CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END)
     WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'`,
    [uid]
  );

  const incomingRequests = await pool.query(
    `SELECT f.id AS "requestId", u.id AS "userId", u.username
     FROM friend_links f
     JOIN users u ON u.id = f.requester_id
     WHERE f.addressee_id = $1 AND f.status = 'pending'`,
    [uid]
  );

  const outgoingRequests = await pool.query(
    `SELECT f.id AS "requestId", u.id AS "userId", u.username
     FROM friend_links f
     JOIN users u ON u.id = f.addressee_id
     WHERE f.requester_id = $1 AND f.status = 'pending'`,
    [uid]
  );

  res.json({ friends: friends.rows, incomingRequests: incomingRequests.rows, outgoingRequests: outgoingRequests.rows });
}));

app.post('/api/friends/request', verifyToken, ah(async (req, res) => {
  const { username } = req.body || {};
  const uname = typeof username === 'string' ? username.trim() : '';
  if (!uname || uname.length > 24) return res.status(400).json({ error: 'Enter a valid username' });

  const targetResult = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [uname]);
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ error: 'No user with that username' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't add yourself" });

  const already = await pool.query(
    `SELECT 1 FROM friend_links
     WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
    [req.user.id, target.id]
  );
  if (already.rows.length) return res.status(409).json({ error: 'A request or friendship already exists' });

  await pool.query(
    "INSERT INTO friend_links (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')",
    [req.user.id, target.id]
  );
  res.json({ ok: true });
}));

app.post('/api/friends/accept', verifyToken, ah(async (req, res) => {
  const requestId = parseInt(req.body && req.body.requestId, 10);
  if (!Number.isInteger(requestId)) return res.status(400).json({ error: 'Invalid request id' });

  const link = await pool.query('SELECT * FROM friend_links WHERE id = $1 AND addressee_id = $2', [requestId, req.user.id]);
  if (!link.rows.length) return res.status(404).json({ error: 'Request not found' });

  await pool.query("UPDATE friend_links SET status = 'accepted' WHERE id = $1", [requestId]);
  res.json({ ok: true });
}));

app.post('/api/friends/decline', verifyToken, ah(async (req, res) => {
  const requestId = parseInt(req.body && req.body.requestId, 10);
  if (!Number.isInteger(requestId)) return res.status(400).json({ error: 'Invalid request id' });

  await pool.query('DELETE FROM friend_links WHERE id = $1 AND addressee_id = $2', [requestId, req.user.id]);
  res.json({ ok: true });
}));

app.delete('/api/friends/:friendId', verifyToken, ah(async (req, res) => {
  const fid = parseInt(req.params.friendId, 10);
  if (!Number.isInteger(fid)) return res.status(400).json({ error: 'Invalid user id' });

  await pool.query(
    `DELETE FROM friend_links
     WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
    [req.user.id, fid]
  );
  res.json({ ok: true });
}));

// ---------------- Message history (live messages arrive over the socket) ----------------

async function areFriends(uidA, uidB) {
  const result = await pool.query(
    `SELECT 1 FROM friend_links
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
    [uidA, uidB]
  );
  return result.rows.length > 0;
}

app.get('/api/messages/:friendId', verifyToken, ah(async (req, res) => {
  const fid = parseInt(req.params.friendId, 10);
  if (!Number.isInteger(fid)) return res.status(400).json({ error: 'Invalid user id' });
  if (!(await areFriends(req.user.id, fid))) return res.status(403).json({ error: 'You can only view chats with accepted friends' });

  const result = await pool.query(
    `SELECT id, sender_id AS "senderId", recipient_id AS "recipientId", text, created_at AS "createdAt"
     FROM messages
     WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
     ORDER BY id ASC LIMIT 200`,
    [req.user.id, fid]
  );
  res.json(result.rows);
}));

// Basic error handler for anything ah() catches.
app.use((err, req, res, next) => {
  console.error('[dara] Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our end' });
});

// ---------------- Socket.io: authenticated, per-user room, live delivery ----------------

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Missing token'));
  try {
    socket.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

// Simple in-memory per-connection throttle: at most 15 messages per 10 seconds.
// Good enough to blunt a spam burst on a single-instance deployment; a
// multi-instance deployment behind a load balancer would want this tracked
// in something shared (e.g. Redis) instead, same as the Socket.io adapter
// note in the README.
const MSG_WINDOW_MS = 10 * 1000;
const MSG_MAX_PER_WINDOW = 15;

io.on('connection', (socket) => {
  socket.join('user:' + socket.user.id);
  socket.msgTimestamps = [];

  socket.on('private_message', async (payload) => {
    try {
      const toUserId = parseInt(payload && payload.toUserId, 10);
      const rawText = payload && payload.text;

      if (!Number.isInteger(toUserId)) return;
      const textError = validateMessageText(rawText);
      if (textError) { socket.emit('message_error', { error: textError }); return; }
      const text = rawText.trim();

      if (!(await areFriends(socket.user.id, toUserId))) {
        socket.emit('message_error', { error: 'You can only message accepted friends' });
        return;
      }

      const now = Date.now();
      socket.msgTimestamps = socket.msgTimestamps.filter((t) => now - t < MSG_WINDOW_MS);
      if (socket.msgTimestamps.length >= MSG_MAX_PER_WINDOW) {
        socket.emit('message_error', { error: "You're sending messages too fast. Slow down a little." });
        return;
      }
      socket.msgTimestamps.push(now);

      const insert = await pool.query(
        'INSERT INTO messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING id, created_at AS "createdAt"',
        [socket.user.id, toUserId, text]
      );
      const msg = {
        id: insert.rows[0].id,
        senderId: socket.user.id,
        recipientId: toUserId,
        text,
        createdAt: insert.rows[0].createdAt
      };
      io.to('user:' + toUserId).emit('new_message', msg);
      io.to('user:' + socket.user.id).emit('new_message', msg);
    } catch (e) {
      console.error('[dara] private_message error:', e);
      socket.emit('message_error', { error: 'Message could not be sent' });
    }
  });
});

const PORT = process.env.PORT || 3001;

init()
  .then(() => {
    server.listen(PORT, () => console.log('Dara server listening on port ' + PORT));
  })
  .catch((err) => {
    console.error('[dara] FATAL: could not initialize the database:', err);
    process.exit(1);
  });
