const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const auth = db.getAuth();
  if (email.toLowerCase() !== auth.email.toLowerCase()) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const ok = bcrypt.compareSync(password, auth.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  const token = signToken({ email: auth.email });
  res.json({ token, email: auth.email });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newEmail, newPassword, confirmPassword } = req.body || {};
  const auth = db.getAuth();

  if (newEmail && newEmail.toLowerCase() !== auth.email.toLowerCase()) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, auth.passwordHash)) {
      return res.status(400).json({ error: 'Enter your current password to change the login email.' });
    }
    auth.email = newEmail;
  }

  if (newPassword || confirmPassword || currentPassword) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, auth.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New passwords do not match.' });
    }
    auth.passwordHash = bcrypt.hashSync(newPassword, 10);
  }

  db.setAuth(auth);
  const token = signToken({ email: auth.email });
  res.json({ ok: true, email: auth.email, token });
});

module.exports = router;
