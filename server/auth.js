const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  if (process.env.NODE_ENV === 'production') {
    // Refuse to start in production without an explicit, operator-chosen secret.
    // Running with a guessable or shared default in production would let anyone
    // who reads the source code forge valid login tokens for any account.
    console.error('[dara] FATAL: JWT_SECRET is not set. Refusing to start in production without one.');
    console.error('[dara] Set it with:  export JWT_SECRET="$(openssl rand -hex 48)"');
    process.exit(1);
  }
  // In development, generate a random secret for this run instead of using a
  // fixed default. Sessions won't survive a server restart, but no one can
  // forge tokens by reading this file.
  SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[dara] WARNING: JWT_SECRET is not set. Using a random secret generated for this run.');
  console.warn('[dara] Everyone will be logged out on restart. Set JWT_SECRET before deploying.');
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { signToken, verifyToken, SECRET };
