const mongoose = require('mongoose');
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

/**
 * Same access as `requireAdmin` for doctor CRUD, plus `doctor` role for PATCH when * `req.user.doctorProfile` matches `req.params.id` (self-service profile update).
 */
/**
 * `POST /api/admin/users/:id/link-doctor`: admins as usual, or `doctor` only when `:id` is their own user id.
 */
const requireAdminOrSelfDoctorLink = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const gate = [ROLES.ADMIN, ROLES.HOSPITAL_ADMIN];
  const isAdminLevel =
    gate.includes(req.user.role) || gate.some((r) => hasRoleOrAbove(req.user.role, r));
  if (isAdminLevel) {
    return next();
  }
  if (req.user.role === ROLES.DOCTOR) {
    const targetId = req.params.id;
    if (targetId && String(targetId) === String(req.user._id)) {
      return next();
    }
  }
  return res.status(403).json({ success: false, message: 'Insufficient permissions' });
};

const requireAdminOrOwnDoctorProfile = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const gate = [ROLES.ADMIN, ROLES.HOSPITAL_ADMIN];
  const isAdminLevel =
    gate.includes(req.user.role) || gate.some((r) => hasRoleOrAbove(req.user.role, r));
  if (isAdminLevel) {
    return next();
  }
  if (req.user.role === ROLES.DOCTOR) {
    const pid = req.user.doctorProfile;
    const targetId = req.params.id;
    if (pid && targetId && String(pid) === String(targetId)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      message:
        'You can only update your linked doctor profile. Ask a hospital administrator to link your account.',
    });
  }
  return res.status(403).json({ success: false, message: 'Insufficient permissions' });
};

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

/** Patient list / reads: includes tele_caller (hospital-scoped like doctor). */
const requireStaffOrTeleCaller = requireRoles(
  ROLES.DOCTOR,
  ROLES.TELE_CALLER,
  ROLES.HOSPITAL_ADMIN,
  ROLES.ADMIN,
);

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

/**
 * Per-hospital Google Calendar OAuth: platform admins any hospital; hospital-linked roles only their hospital.
 */
const requireGoogleCalendarHospitalAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const hospitalId = req.params.hospitalId;
  if (!hospitalId || !mongoose.isValidObjectId(String(hospitalId))) {
    return res.status(400).json({ success: false, message: 'Invalid hospitalId' });
  }
  const role = req.user.role;
  if (role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN) {
    return next();
  }
  if (isHospitalRole(role)) {
    if (!req.user.hospital) {
      return res.status(403).json({
        success: false,
        message: 'You must be linked to a hospital to access this resource.',
      });
    }
    if (String(req.user.hospital) !== String(hospitalId)) {
      return res.status(403).json({
        success: false,
        message: 'You can only manage Google Calendar for your linked hospital.',
      });
    }
    return next();
  }
  return res.status(403).json({ success: false, message: 'Insufficient permissions' });
};

/**
 * Only the listed roles match (no hierarchy inheritance). Use when doctor/user must not gain access.
 */
const requireExactRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    next();
  };
};

module.exports = {
  requireRoles,
  requireExactRoles,
  requireAdmin,
  requireAdminOrSelfDoctorLink,
  requireAdminOrOwnDoctorProfile,
  requireAdminOnly,
  requireAdminOrSuperAdminOnly,
  requireWhatsAppCredsAccess,
  requireWhatsAppOnboardingWriteAccess,
  requireDoctor,
  requireStaff,
  requireStaffOrTeleCaller,
  requireModerator,
  requireHospitalLink,
  requireGoogleCalendarHospitalAccess,
  ROLES,
};
