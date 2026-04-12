const authService = require('../services/authService');

const register = async (req, res, next) => {
  try {
    const { email, password, name, role, hospitalId } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    const result = await authService.register({ email, password, name, role, hospitalId });
    const user = result.user;
    const userObj = user.toObject ? user.toObject() : user;
    delete userObj.password;
    const data = { user: userObj };
    if (result.linkedHospital) {
      data.linkedHospital = result.linkedHospital;
      data.message = 'You are linked to a hospital; you will only see data for this hospital.';
    }
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (err.statusCode === 403) {
      return res.status(403).json({ success: false, message: err.message });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }
    const userAgent = req.get('user-agent') || '';
    const result = await authService.login(email, password, userAgent);
    const refreshToken = result.refreshToken;
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
    res.cookie('refreshToken', refreshToken, cookieOptions);
    res.status(200).json({
      success: true,
      data: {
        user: result.user,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        refreshToken: refreshToken,
      },
    });
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ success: false, message: err.message });
    }
    next(err);
  }
};

const refresh = async (req, res, next) => {
  try {
    const token = req.body.refreshToken || req.cookies?.refreshToken;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Refresh token required' });
    }
    const userAgent = req.get('user-agent') || '';
    const result = await authService.refreshTokens(token, userAgent);
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
    res.cookie('refreshToken', result.refreshToken, cookieOptions);
    res.status(200).json({
      success: true,
      data: {
        user: result.user,
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
        refreshToken: result.refreshToken,
      },
    });
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ success: false, message: err.message });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Refresh token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    const token = req.body.refreshToken || req.cookies?.refreshToken;
    await authService.logout(token);
    res.clearCookie('refreshToken');
    res.status(200).json({ success: true, message: 'Logged out' });
  } catch (err) {
    next(err);
  }
};

const logoutAll = async (req, res, next) => {
  try {
    await authService.logoutAll(req.user._id);
    res.clearCookie('refreshToken');
    res.status(200).json({ success: true, message: 'Logged out from all devices' });
  } catch (err) {
    next(err);
  }
};

const me = async (req, res, next) => {
  try {
    const { getLinkedHospitalForResponse } = require('../utils/hospitalScope');
    const user = req.user.toObject ? req.user.toObject() : { ...req.user };
    let hospital = null;
    if (req.user.hospital) {
      const Hospital = require('../models/hospital.model');
      const doc = await Hospital.findById(req.user.hospital).lean();
      hospital = doc || null; // null if hospital was deleted
    }
    res.status(200).json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { user, hospital },
    });
  } catch (err) {
    next(err);
  }
};

const updateMe = async (req, res, next) => {
  try {
    const { getLinkedHospitalForResponse } = require('../utils/hospitalScope');
    const user = await authService.updateMyProfile(req.user._id, {
      name: req.body.name,
      email: req.body.email,
      phoneNumber: req.body.phoneNumber,
      password: req.body.password,
      currentPassword: req.body.currentPassword,
    });
    res.status(200).json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { user },
    });
  } catch (err) {
    if (err.statusCode === 400 || err.statusCode === 409 || err.statusCode === 404) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    next(err);
  }
};

/**
 * POST /api/auth/me/profile-picture — multipart image (field: logo | file | image). Replaces previous local file.
 */
const uploadProfilePicture = async (req, res, next) => {
  const User = require('../models/User');
  const { getLinkedHospitalForResponse } = require('../utils/hospitalScope');
  const {
    unlinkUserProfilePicIfStored,
    unlinkMulterTempFile,
  } = require('../utils/userProfilePicFile');

  try {
    const newUrl = `/uploads/users/${req.file.filename}`;
    const userBefore = await User.findById(req.user._id).select('profilePicUrl').lean();
    if (!userBefore) {
      await unlinkMulterTempFile(req.file);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { profilePicUrl: newUrl } },
      { new: true, runValidators: true }
    )
      .select('-password')
      .lean();

    if (!user) {
      await unlinkMulterTempFile(req.file);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (userBefore.profilePicUrl && userBefore.profilePicUrl !== newUrl) {
      await unlinkUserProfilePicIfStored(userBefore.profilePicUrl);
    }

    res.status(200).json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: { user },
    });
  } catch (err) {
    await unlinkMulterTempFile(req.file);
    next(err);
  }
};

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  me,
  updateMe,
  uploadProfilePicture,
};
