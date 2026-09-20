const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'shekhar-compute-dev-secret-change-me';
const TOKEN_TTL = '12h';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

module.exports = { signToken, requireAuth, JWT_SECRET };
