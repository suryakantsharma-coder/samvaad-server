const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const Hospital = require('../models/hospital.model');
const { ROLES } = require('../constants/roles');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  signPasswordResetToken,
  verifyPasswordResetToken,
} = require('../utils/jwt');
const env = require('../config/env');
const { isMailConfigured, sendPasswordResetMail } = require('./mailService');

const DOCTOR_PROFILE_POPULATE = {
  path: 'doctorProfile',
  select: 'fullName doctorId designation email phoneNumber hospital',
};

/**
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
const getUserForAuthResponse = (userId) =>
  User.findById(userId).select('-password').populate(DOCTOR_PROFILE_POPULATE).lean();

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
  if ([ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.MODERATOR].includes(normalizedRole)) {
    const err = new Error('Cannot self-register as admin or moderator');
    err.statusCode = 403;
    throw err;
  }

  let hospital = null;

  if ([ROLES.DOCTOR, ROLES.HOSPITAL_ADMIN, ROLES.TELE_CALLER].includes(normalizedRole)) {
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
    user: await getUserForAuthResponse(user._id),
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

  const user = await getUserForAuthResponse(decoded.sub);
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

/**
 * Update own profile: name, email, phoneNumber, password only.
 * @param {string} userId
 * @param {{ name?: string, email?: string, phoneNumber?: string, password?: string, currentPassword?: string }} fields
 */
const updateMyProfile = async (userId, fields) => {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }

  const { name, email, phoneNumber, password, currentPassword } = fields;

  const hasPatch =
    name !== undefined ||
    email !== undefined ||
    phoneNumber !== undefined ||
    password !== undefined;

  if (!hasPatch) {
    const err = new Error("Provide at least one of: name, email, phoneNumber, password");
    err.statusCode = 400;
    throw err;
  }

  if (password !== undefined) {
    if (!currentPassword) {
      const err = new Error("currentPassword is required when changing password");
      err.statusCode = 400;
      throw err;
    }
    const withSecret = await User.findById(userId).select("+password");
    const ok = await withSecret.comparePassword(currentPassword);
    if (!ok) {
      const err = new Error("Current password is incorrect");
      err.statusCode = 400;
      throw err;
    }
    user.password = password;
  }

  if (name !== undefined) {
    user.name = name;
  }
  if (email !== undefined) {
    const lower = String(email).toLowerCase().trim();
    const taken = await User.findOne({
      email: lower,
      _id: { $ne: userId },
    })
      .select("_id")
      .lean();
    if (taken) {
      const err = new Error("Email is already in use");
      err.statusCode = 409;
      throw err;
    }
    user.email = lower;
  }
  if (phoneNumber !== undefined) {
    user.phoneNumber = String(phoneNumber).trim();
  }

  await user.save();
  return getUserForAuthResponse(userId);
};

const getPublicApiBase = () =>
  (env.API_PUBLIC_URL || `http://127.0.0.1:${env.PORT}`).replace(/\/$/, '');

/**
 * Sends a 2-minute reset link (or logs it in development when SMTP is unset).
 * Always returns the same shape to avoid email enumeration.
 */
const requestPasswordReset = async (email) => {
  const normalized = String(email || '').toLowerCase().trim();
  if (!normalized) {
    const err = new Error('Email is required');
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findOne({ email: normalized }).select('_id email').lean();
  if (!user) {
    if (env.NODE_ENV !== 'production') {
      console.log(
        '[mail] Password reset (dev): no user with this email — no mail sent. API still returns success.'
      );
    }
    return { ok: true };
  }

  const nnc = crypto.randomBytes(32).toString('hex');
  await User.updateOne({ _id: user._id }, { $set: { passwordResetNonce: nnc } });

  const token = signPasswordResetToken({ sub: user._id.toString(), nnc });
  const resetUrl = `${getPublicApiBase()}/auth/reset-password?token=${encodeURIComponent(token)}`;

  if (!isMailConfigured()) {
    if (env.NODE_ENV === 'production') {
      console.error(
        '[mail] Password reset: not sent — SMTP not configured in production (set SMTP_HOST, MAIL_FROM)'
      );
      const err = new Error('Password reset email is not configured on the server');
      err.statusCode = 503;
      throw err;
    }
    console.warn(
      '[mail] Password reset: email NOT sent — SMTP not configured (dev). Use this link:',
      resetUrl
    );
    return { ok: true };
  }

  await sendPasswordResetMail({ to: user.email, resetUrl });
  return { ok: true };
};

const resetPasswordWithToken = async (token, newPassword) => {
  if (!token || !newPassword) {
    const err = new Error('Token and password are required');
    err.statusCode = 400;
    throw err;
  }
  if (String(newPassword).length < 6) {
    const err = new Error('Password must be at least 6 characters');
    err.statusCode = 400;
    throw err;
  }

  let decoded;
  try {
    decoded = verifyPasswordResetToken(token);
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      const err = new Error('Reset link expired (valid for 2 minutes)');
      err.statusCode = 400;
      throw err;
    }
    const err = new Error('Invalid or expired reset link');
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findById(decoded.sub).select('+password +passwordResetNonce');
  if (!user) {
    const err = new Error('Invalid or expired reset link');
    err.statusCode = 400;
    throw err;
  }
  if (!user.passwordResetNonce || user.passwordResetNonce !== decoded.nnc) {
    const err = new Error('This reset link is no longer valid');
    err.statusCode = 400;
    throw err;
  }

  user.password = newPassword;
  user.passwordResetNonce = '';
  await user.save();
  await RefreshToken.deleteMany({ user: user._id });
};

module.exports = {
  register,
  login,
  refreshTokens,
  logout,
  logoutAll,
  updateMyProfile,
  getUserForAuthResponse,
  requestPasswordReset,
  resetPasswordWithToken,
};
