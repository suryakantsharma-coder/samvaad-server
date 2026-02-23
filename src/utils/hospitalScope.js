const mongoose = require('mongoose');
const { isHospitalRole } = require('../constants/roles');

/**
 * Centralized hospital scoping for RBAC.
 * hospital_admin and doctor can only see data for their linked hospital; admin sees all.
 *
 * - If user is doctor or hospital_admin and req.user.hospital is set and valid:
 *   returns { hospital: ObjectId } (scope to that hospital only). Uses ObjectId for reliable DB match.
 * - Otherwise (admin or no valid hospital): returns {} (no scope; admin sees all).
 *
 * @param {object} req - Express request (must have req.user populated after protect middleware)
 * @returns {object} Filter object to merge into MongoDB queries (e.g. find(filter), findOne(filter))
 */
function getHospitalFilter(req) {
  if (!req.user) return {};
  if (!isHospitalRole(req.user.role)) return {};
  const raw = req.user.hospital;
  if (!raw || !mongoose.isValidObjectId(raw)) return {};
  const hospitalId = raw instanceof mongoose.Types.ObjectId ? raw : new mongoose.Types.ObjectId(String(raw));
  return { hospital: hospitalId };
}

/**
 * Payload to attach to GET responses so the frontend knows which hospital the data is scoped to.
 * Use for all hospital-scoped GET endpoints (doctors, patients, appointments, hospitals, admin/users).
 *
 * @param {object} req - Express request
 * @returns {{ linkedHospitalId: string|null }} linkedHospitalId for frontend (string or null)
 */
function getLinkedHospitalForResponse(req) {
  const scope = getHospitalFilter(req);
  const id = scope.hospital;
  return { linkedHospitalId: id ? String(id) : null };
}

/**
 * Merge hospital scope into an existing filter. Mutates and returns the same filter object.
 * Use for list/get/update/delete queries on hospital-scoped resources.
 *
 * @param {object} req - Express request
 * @param {object} filter - Existing MongoDB filter (e.g. { _id: id } or { status: 'Upcoming' })
 * @returns {object} filter with hospital scope merged in when applicable
 */
function mergeHospitalFilter(req, filter) {
  const scope = getHospitalFilter(req);
  Object.assign(filter, scope);
  return filter;
}

module.exports = {
  getHospitalFilter,
  mergeHospitalFilter,
  getLinkedHospitalForResponse,
};
