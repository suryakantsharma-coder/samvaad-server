const { ROLES, hasRoleOrAbove, isHospitalRole } = require('../constants/roles');

/**
 * Require that req.user exists (use after protect middleware) and has one of the allowed roles.
 * @param {...string} allowedRoles - e.g. requireRoles(ROLES.ADMIN) or requireRoles(ROLES.ADMIN, ROLES.MODERATOR)
 */
const requireRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const userRole = req.user.role;
    const allowed = allowedRoles.includes(userRole) || allowedRoles.some((r) => hasRoleOrAbove(userRole, r));
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
  };
};

/** Shorthand: admin or hospital admin only */
const requireAdmin = requireRoles(ROLES.ADMIN, ROLES.HOSPITAL_ADMIN);

/** Shorthand: admin only (no hospital_admin). Super admin is also allowed via hierarchy. */
const requireAdminOnly = requireRoles(ROLES.ADMIN);

/**
 * Exactly `admin` or `super_admin` — for highly sensitive ops (e.g. WhatsApp tokens).
 * Does not use role hierarchy, so other roles never inherit access.
 */
const requireAdminOrSuperAdminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (![ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  next();
};

/**
 * WhatsApp integration creds: platform admins see any hospital; hospital_admin only their linked hospital.
 */
const requireWhatsAppCredsAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const role = req.user.role;
  if (role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN) {
    return next();
  }
  if (role === ROLES.HOSPITAL_ADMIN) {
    const requested = req.params.hospitalId || req.query.hospitalId;
    if (!req.user.hospital) {
      return res.status(403).json({
        success: false,
        message:
          'You must be linked to a hospital to access this resource. Please contact your administrator.',
      });
    }
    if (!requested || String(requested) !== String(req.user.hospital)) {
      return res.status(403).json({
        success: false,
        message: 'You can only view WhatsApp credentials for your own hospital.',
      });
    }
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Insufficient permissions',
  });
};

/**
 * WhatsApp onboarding PUT: platform admins update any hospital; hospital_admin only their linked hospital (`body.hospitalId` must match).
 */
const requireWhatsAppOnboardingWriteAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const role = req.user.role;
  if (role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN) {
    return next();
  }
  if (role === ROLES.HOSPITAL_ADMIN) {
    const requested = req.body?.hospitalId;
    if (!req.user.hospital) {
      return res.status(403).json({
        success: false,
        message:
          'You must be linked to a hospital to access this resource. Please contact your administrator.',
      });
    }
    if (!requested || String(requested) !== String(req.user.hospital)) {
      return res.status(403).json({
        success: false,
        message: 'You can only update WhatsApp onboarding for your own hospital.',
      });
    }
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Insufficient permissions',
  });
};

/** Shorthand: doctor only */
const requireDoctor = requireRoles(ROLES.DOCTOR);

/** Shorthand: doctor, hospital admin, or admin */
const requireStaff = requireRoles(ROLES.DOCTOR, ROLES.HOSPITAL_ADMIN, ROLES.ADMIN);

/** Shorthand: moderator or admin. Not used by any route currently; reserved for future moderator-only routes. */
const requireModerator = requireRoles(ROLES.MODERATOR, ROLES.ADMIN);

/**
 * For hospital roles (doctor, hospital_admin): require that user has a linked hospital.
 * Ensures they never see "overall" data—only data for their hospital. Use on all hospital-scoped routes.
 */
const requireHospitalLink = (req, res, next) => {
  if (isHospitalRole(req.user.role) && !req.user.hospital) {
    return res.status(403).json({
      success: false,
      message: 'You must be linked to a hospital to access this resource. Please contact your administrator.',
    });
  }
  next();
};

module.exports = {
  requireRoles,
  requireAdmin,
  requireAdminOnly,
  requireAdminOrSuperAdminOnly,
  requireWhatsAppCredsAccess,
  requireWhatsAppOnboardingWriteAccess,
  requireDoctor,
  requireStaff,
  requireModerator,
  requireHospitalLink,
  ROLES,
};
