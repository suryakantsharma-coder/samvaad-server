const ROLES = Object.freeze({
  USER: 'user',
  DOCTOR: 'doctor',
  MODERATOR: 'moderator',
  HOSPITAL_ADMIN: 'hospital_admin',
  ADMIN: 'admin',
});

/** Roles that are linked to a single hospital at sign-up and must only see that hospital's data. */
const HOSPITAL_ROLES = Object.freeze([ROLES.DOCTOR, ROLES.HOSPITAL_ADMIN]);

const ROLE_HIERARCHY = [ROLES.USER, ROLES.DOCTOR, ROLES.MODERATOR, ROLES.HOSPITAL_ADMIN, ROLES.ADMIN];

const hasRoleOrAbove = (userRole, requiredRole) => {
  const userLevel = ROLE_HIERARCHY.indexOf(userRole);
  const requiredLevel = ROLE_HIERARCHY.indexOf(requiredRole);
  return userLevel !== -1 && userLevel >= requiredLevel;
};

const isHospitalRole = (role) => HOSPITAL_ROLES.includes(role);

module.exports = {
  ROLES,
  HOSPITAL_ROLES,
  ROLE_HIERARCHY,
  hasRoleOrAbove,
  isHospitalRole,
};
