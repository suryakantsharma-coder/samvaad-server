const HospitalSettings = require('../models/hospitalSettings.model');

const DEFAULTS = {
  whatsapp: {
    isEnabled: true,
    appointment: true,
    prescription: true,
    medicinesReminder: true,
  },
  teleCaller: {
    isEnabled: true,
  },
};

function mergeResolved(doc) {
  const w = doc?.whatsapp || {};
  const t = doc?.teleCaller || {};
  return {
    whatsapp: {
      isEnabled: w.isEnabled !== undefined ? Boolean(w.isEnabled) : DEFAULTS.whatsapp.isEnabled,
      appointment: w.appointment !== undefined ? Boolean(w.appointment) : DEFAULTS.whatsapp.appointment,
      prescription: w.prescription !== undefined ? Boolean(w.prescription) : DEFAULTS.whatsapp.prescription,
      medicinesReminder:
        w.medicinesReminder !== undefined
          ? Boolean(w.medicinesReminder)
          : DEFAULTS.whatsapp.medicinesReminder,
    },
    teleCaller: {
      isEnabled: t.isEnabled !== undefined ? Boolean(t.isEnabled) : DEFAULTS.teleCaller.isEnabled,
    },
  };
}

/**
 * Effective messaging toggles for a hospital. If no row exists, all features behave as enabled (legacy).
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} hospitalId
 * @returns {Promise<{ whatsapp: object, teleCaller: object, hasPersistedDocument: boolean }>}
 */
async function getResolvedHospitalMessagingSettings(hospitalId) {
  if (!hospitalId) {
    return { ...mergeResolved(null), hasPersistedDocument: false };
  }
  const doc = await HospitalSettings.findOne({ hospitalId }).lean();
  if (!doc) {
    return { ...mergeResolved(null), hasPersistedDocument: false };
  }
  return { ...mergeResolved(doc), hasPersistedDocument: true };
}

/**
 * @param {'whatsapp_disabled'|'whatsapp_appointment'|'whatsapp_prescription'|'whatsapp_medicines_reminder'|'telecaller_disabled'} code
 */
function logMessagingPermissionDenied(hospitalId, code, extra = {}) {
  console.warn('[Hospital settings] Messaging blocked by hospital settings', {
    hospitalId: hospitalId != null ? String(hospitalId) : null,
    code,
    ...extra,
  });
}

/** Default row when a new hospital is created: all messaging features off until enabled in Hospital Settings. */
const NEW_HOSPITAL_SETTINGS_ALL_FALSE = {
  whatsapp: {
    isEnabled: false,
    appointment: false,
    prescription: false,
    medicinesReminder: false,
  },
  teleCaller: {
    isEnabled: false,
  },
};

/**
 * Insert `HospitalSettings` for a newly created hospital (all toggles false).
 * @param {import('mongoose').Types.ObjectId|string} hospitalId
 */
async function createDefaultHospitalSettingsForNewHospital(hospitalId) {
  return HospitalSettings.create({
    hospitalId,
    ...NEW_HOSPITAL_SETTINGS_ALL_FALSE,
  });
}

module.exports = {
  DEFAULTS,
  NEW_HOSPITAL_SETTINGS_ALL_FALSE,
  getResolvedHospitalMessagingSettings,
  logMessagingPermissionDenied,
  createDefaultHospitalSettingsForNewHospital,
};
