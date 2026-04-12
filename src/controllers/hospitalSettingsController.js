const mongoose = require('mongoose');
const Hospital = require('../models/hospital.model');
const HospitalSettings = require('../models/hospitalSettings.model');
const { ROLES } = require('../constants/roles');
const { normalizeRole } = require('../middleware/hospitalSettingsAccess');
const {
  getResolvedHospitalMessagingSettings,
  createDefaultHospitalSettingsForNewHospital,
} = require('../utils/hospitalMessagingSettings');
const { getLinkedHospitalForResponse } = require('../utils/hospitalScope');

/**
 * `hospital_admin` → linked hospital only.
 * `admin` / `super_admin` → `hospitalId` from query (GET/PATCH) or body (POST create / PATCH).
 */
function resolveHospitalIdForSettings(req, { preferBodyHospitalId = false } = {}) {
  const r = normalizeRole(req.user.role);
  if (r === ROLES.HOSPITAL_ADMIN) {
    const id = req.user.hospital;
    if (!id) {
      return {
        error: {
          status: 403,
          message:
            'You must be linked to a hospital to manage hospital settings. Please contact your administrator.',
        },
      };
    }
    return { hospitalId: id };
  }
  if (r === ROLES.ADMIN || r === ROLES.SUPER_ADMIN) {
    const raw = preferBodyHospitalId
      ? req.body?.hospitalId ?? req.query?.hospitalId
      : req.query?.hospitalId ?? req.body?.hospitalId;
    if (!raw || !mongoose.isValidObjectId(String(raw))) {
      return {
        error: {
          status: 400,
          message:
            'hospitalId is required: for platform admins use query ?hospitalId= on GET/PATCH, or body.hospitalId on POST',
        },
      };
    }
    return { hospitalId: raw };
  }
  return { error: { status: 403, message: 'Insufficient permissions' } };
}

function pickNestedBody(body) {
  const out = {};
  if (body.whatsapp && typeof body.whatsapp === 'object') {
    out.whatsapp = { ...body.whatsapp };
  }
  if (body.teleCaller && typeof body.teleCaller === 'object') {
    out.teleCaller = { ...body.teleCaller };
  }
  return out;
}

/**
 * POST /api/hospital-settings/bootstrap
 * Platform admin: create default (all-false) settings for an existing hospital that has none.
 */
const bootstrap = async (req, res, next) => {
  try {
    const hospitalId = req.body.hospitalId;
    const r = normalizeRole(req.user.role);
    if (r === ROLES.HOSPITAL_ADMIN && String(hospitalId) !== String(req.user.hospital)) {
      return res.status(403).json({
        success: false,
        message: 'You can only bootstrap settings for your own hospital',
      });
    }
    const hospital = await Hospital.findById(hospitalId).select('_id').lean();
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }
    const existing = await HospitalSettings.findOne({ hospitalId }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Hospital settings already exist for this hospital',
      });
    }
    await createDefaultHospitalSettingsForNewHospital(hospitalId);
    const resolved = await getResolvedHospitalMessagingSettings(hospitalId);
    res.status(201).json({
      success: true,
      data: {
        settings: {
          hospitalId,
          whatsapp: resolved.whatsapp,
          teleCaller: resolved.teleCaller,
        },
        hasPersistedDocument: true,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/hospital-settings/me
 * hospital_admin: own hospital. admin/super_admin: `?hospitalId=`.
 */
const getMe = async (req, res, next) => {
  try {
    const { hospitalId, error } = resolveHospitalIdForSettings(req);
    if (error) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    const resolved = await getResolvedHospitalMessagingSettings(hospitalId);
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        settings: {
          hospitalId,
          whatsapp: resolved.whatsapp,
          teleCaller: resolved.teleCaller,
        },
        hasPersistedDocument: resolved.hasPersistedDocument,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/hospital-settings — create (one per hospital).
 * hospital_admin: own hospital. admin/super_admin: `body.hospitalId`.
 */
const create = async (req, res, next) => {
  try {
    const { hospitalId, error } = resolveHospitalIdForSettings(req, { preferBodyHospitalId: true });
    if (error) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    const hospital = await Hospital.findById(hospitalId).select('_id').lean();
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }
    const existing = await HospitalSettings.findOne({ hospitalId }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Hospital settings already exist; use PATCH /api/hospital-settings/me to update',
      });
    }

    const payload = pickNestedBody(req.body);
    const created = await HospitalSettings.create({
      hospitalId,
      whatsapp: payload.whatsapp || {},
      teleCaller: payload.teleCaller || {},
    });

    const resolved = await getResolvedHospitalMessagingSettings(hospitalId);
    res.status(201).json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        settings: {
          hospitalId,
          whatsapp: resolved.whatsapp,
          teleCaller: resolved.teleCaller,
        },
        hasPersistedDocument: true,
        raw: created.toObject(),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/hospital-settings/me — update existing document.
 * hospital_admin: own hospital. admin/super_admin: `?hospitalId=` or `body.hospitalId`.
 */
const updateMe = async (req, res, next) => {
  try {
    const { hospitalId, error } = resolveHospitalIdForSettings(req);
    if (error) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    const payload = pickNestedBody(req.body);
    if (!payload.whatsapp && !payload.teleCaller) {
      return res.status(400).json({
        success: false,
        message: 'Provide whatsapp and/or teleCaller object with fields to update',
      });
    }

    const update = {};
    if (payload.whatsapp) {
      for (const key of Object.keys(payload.whatsapp)) {
        if (payload.whatsapp[key] !== undefined) {
          update[`whatsapp.${key}`] = payload.whatsapp[key];
        }
      }
    }
    if (payload.teleCaller) {
      for (const key of Object.keys(payload.teleCaller)) {
        if (payload.teleCaller[key] !== undefined) {
          update[`teleCaller.${key}`] = payload.teleCaller[key];
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    const updated = await HospitalSettings.findOneAndUpdate(
      { hospitalId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Hospital settings not found; create them first with POST /api/hospital-settings',
      });
    }

    const resolved = await getResolvedHospitalMessagingSettings(hospitalId);
    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        settings: {
          hospitalId,
          whatsapp: resolved.whatsapp,
          teleCaller: resolved.teleCaller,
        },
        hasPersistedDocument: true,
        raw: updated,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  bootstrap,
  getMe,
  create,
  updateMe,
};
