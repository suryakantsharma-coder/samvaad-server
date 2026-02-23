const mongoose = require('mongoose');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const Hospital = require('../models/hospital.model');
const { ROLES } = require('../constants/roles');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const env = require('../config/env');

const getRefreshTokenExpiry = () => {
  const match = env.JWT_REFRESH_EXPIRY.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  const multipliers = { d: 24 * 60 * 60 * 1000, h: 60 * 60 * 1000, m: 60 * 1000 };
  return new Date(Date.now() + n * (multipliers[unit] || 0));
};

const register = async ({ email, password, name, role = ROLES.USER, hospitalId }) => {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    const err = new Error('Email already registered');
    err.statusCode = 409;
    throw err;
  }

  let normalizedRole = Object.values(ROLES).includes(role) ? role : ROLES.USER;

  // Prevent self-registration as admin or moderator; only existing admins can create these roles
  if ([ROLES.ADMIN, ROLES.MODERATOR].includes(normalizedRole)) {
    const err = new Error('Cannot self-register as admin or moderator');
    err.statusCode = 403;
    throw err;
  }

  let hospital = null;

  if ([ROLES.DOCTOR, ROLES.HOSPITAL_ADMIN].includes(normalizedRole)) {
    if (!hospitalId) {
      const err = new Error('hospitalId is required for this role');
      err.statusCode = 400;
      throw err;
    }
    if (!mongoose.isValidObjectId(hospitalId)) {
      const err = new Error('hospitalId must be a valid Mongo ObjectId');
      err.statusCode = 400;
      throw err;
    }
    hospital = await Hospital.findById(hospitalId).lean();
    if (!hospital) {
      const err = new Error('Hospital not found');
      err.statusCode = 400;
      throw err;
    }
  }

  const user = await User.create({
    email: email.toLowerCase(),
    password,
    name: name || '',
    role: normalizedRole,
    hospital: hospital ? hospital._id : undefined,
  });
  return { user, linkedHospital: hospital || null };
};

const login = async (email, password, userAgent = '') => {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  if (!user) {
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }
  if (!user.isActive) {
    const err = new Error('Account is disabled');
    err.statusCode = 401;
    throw err;
  }
  const valid = await user.comparePassword(password);
  if (!valid) {
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    throw err;
  }

  const payload = { sub: user._id.toString(), role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const expiresAt = getRefreshTokenExpiry();

  await RefreshToken.create({
    token: refreshToken,
    user: user._id,
    expiresAt,
    userAgent,
  });

  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });

  return {
    user: await User.findById(user._id).select('-password'),
    accessToken,
    refreshToken,
    expiresAt,
  };
};

const refreshTokens = async (refreshTokenValue, userAgent = '') => {
  const decoded = verifyRefreshToken(refreshTokenValue);
  const stored = await RefreshToken.findOne({
    token: refreshTokenValue,
    user: decoded.sub,
  });
  if (!stored) {
    const err = new Error('Refresh token invalid or revoked');
    err.statusCode = 401;
    throw err;
  }

  const user = await User.findById(decoded.sub).select('-password');
  if (!user || !user.isActive) {
    await RefreshToken.deleteOne({ token: refreshTokenValue });
    const err = new Error('User not found or disabled');
    err.statusCode = 401;
    throw err;
  }

  const payload = { sub: user._id.toString(), role: user.role };
  const accessToken = signAccessToken(payload);
  const newRefreshToken = signRefreshToken(payload);
  const expiresAt = getRefreshTokenExpiry();

  await RefreshToken.deleteOne({ token: refreshTokenValue });
  await RefreshToken.create({
    token: newRefreshToken,
    user: user._id,
    expiresAt,
    userAgent,
  });

  return {
    user,
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt,
  };
};

const logout = async (refreshTokenValue) => {
  if (refreshTokenValue) {
    await RefreshToken.deleteOne({ token: refreshTokenValue });
  }
};

const logoutAll = async (userId) => {
  await RefreshToken.deleteMany({ user: userId });
};

module.exports = {
  register,
  login,
  refreshTokens,
  logout,
  logoutAll,
};
