const { ROLES } = require('../constants/roles');

function normalizeRole(role) {
  if (role == null || role === '') return '';
  return String(role).trim();
}

/**
 * Who may manage hospital messaging settings:
 * - `hospital_admin` with a linked hospital (`req.user.hospital`)
 * - `admin` or `super_admin` (must pass `hospitalId` in controller via query/body)
 *
 * Use after `protect` and `requireHospitalLink` (admins are not hospital-scoped and pass `requireHospitalLink`).
 */
function requireHospitalSettingsManager(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const r = normalizeRole(req.user.role);
  if (r === ROLES.HOSPITAL_ADMIN) {
    if (!req.user.hospital) {
      return res.status(403).json({
        success: false,
        message:
          'You must be linked to a hospital to manage hospital settings. Please contact your administrator.',
      });
    }
    return next();
  }
  if (r === ROLES.ADMIN || r === ROLES.SUPER_ADMIN) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Insufficient permissions to manage hospital settings',
  });
}

/**
 * POST /bootstrap — platform admins (any hospital) or `hospital_admin` (own hospital only).
 * For `hospital_admin`, sets `req.body.hospitalId` to their linked hospital before validators run.
 * Use after `protect` and `requireHospitalLink`.
 */
function requireBootstrapHospitalSettingsAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const r = normalizeRole(req.user.role);
  if (r === ROLES.HOSPITAL_ADMIN) {
    if (!req.user.hospital) {
      return res.status(403).json({
        success: false,
        message:
          'You must be linked to a hospital to bootstrap settings. Please contact your administrator.',
      });
    }
    req.body = req.body && typeof req.body === 'object' ? req.body : {};
    req.body.hospitalId = String(req.user.hospital);
    return next();
  }
  if (r === ROLES.ADMIN || r === ROLES.SUPER_ADMIN) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Insufficient permissions to bootstrap hospital settings',
  });
}

module.exports = {
  normalizeRole,
  requireHospitalSettingsManager,
  requireBootstrapHospitalSettingsAccess,
};
