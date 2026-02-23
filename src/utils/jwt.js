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

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
};
