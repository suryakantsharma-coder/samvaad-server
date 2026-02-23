const User = require('../models/User');
const { verifyAccessToken } = require('../utils/jwt');

/**
 * Protect routes: requires valid JWT in Authorization header (Bearer <token>).
 * Attaches req.user (full user doc, no password).
 */
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Access token required' });
    }

    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub).select('-password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Account is disabled' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Access token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ success: false, message: 'Invalid access token' });
    }
    next(err);
  }
};

/**
 * Optional auth: if token present and valid, sets req.user; otherwise continues without user.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return next();

    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub).select('-password');
    if (user && user.isActive) req.user = user;
    next();
  } catch {
    next();
  }
};

module.exports = {
  protect,
  optionalAuth,
};
