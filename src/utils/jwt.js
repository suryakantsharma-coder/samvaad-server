const jwt = require('jsonwebtoken');
const env = require('../config/env');

const signAccessToken = (payload) => {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
    issuer: 'samvaad',
  });
};

const signRefreshToken = (payload) => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRY,
    issuer: 'samvaad',
  });
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'samvaad' });
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { issuer: 'samvaad' });
};

const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};

const passwordResetSecret = () =>
  env.JWT_PASSWORD_RESET_SECRET || env.JWT_ACCESS_SECRET;

/** @param {{ sub: string, nnc: string }} payload */
const signPasswordResetToken = (payload) => {
  return jwt.sign(
    { ...payload, typ: 'pwd_reset' },
    passwordResetSecret(),
    { expiresIn: '2m', issuer: 'samvaad' }
  );
};

const verifyPasswordResetToken = (token) => {
  const decoded = jwt.verify(token, passwordResetSecret(), { issuer: 'samvaad' });
  if (decoded.typ !== 'pwd_reset') {
    const err = new Error('Invalid reset token');
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return decoded;
};

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
  signPasswordResetToken,
  verifyPasswordResetToken,
};
