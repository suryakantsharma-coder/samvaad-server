const { body, query } = require('express-validator');

/** POST /api/hospital-settings/bootstrap — admin/super_admin only */
const bootstrapHospitalSettings = [
  body('hospitalId')
    .notEmpty()
    .withMessage('hospitalId is required')
    .isMongoId()
    .withMessage('Invalid hospitalId'),
];

function optionalBool(path) {
  return body(path)
    .optional({ values: 'null' })
    .custom((value) => {
      if (value === undefined || value === null || value === '') return true;
      if (typeof value === 'boolean') return true;
      const v = String(value).toLowerCase();
      if (['true', 'false', '1', '0'].includes(v)) return true;
      throw new Error(`${path} must be a boolean`);
    })
    .customSanitizer((value) => {
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value === 'boolean') return value;
      const v = String(value).toLowerCase();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      return value;
    });
}

/** POST /api/hospital-settings — create initial document (hospital_admin or platform admin + body.hospitalId). */
const createHospitalSettings = [
  body('hospitalId').optional().isMongoId().withMessage('Invalid hospitalId'),
  optionalBool('whatsapp.isEnabled'),
  optionalBool('whatsapp.appointment'),
  optionalBool('whatsapp.prescription'),
  optionalBool('whatsapp.medicinesReminder'),
  optionalBool('teleCaller.isEnabled'),
];

/** GET /api/hospital-settings/me — optional ?hospitalId= for platform admins. */
const getHospitalSettingsMeQuery = [
  query('hospitalId').optional().isMongoId().withMessage('Invalid hospitalId'),
];

/** PATCH /api/hospital-settings/me — update toggles (optional ?hospitalId= for platform admins). */
const updateHospitalSettings = [
  query('hospitalId').optional().isMongoId().withMessage('Invalid hospitalId'),
  body('hospitalId').optional().isMongoId().withMessage('Invalid hospitalId'),
  optionalBool('whatsapp.isEnabled'),
  optionalBool('whatsapp.appointment'),
  optionalBool('whatsapp.prescription'),
  optionalBool('whatsapp.medicinesReminder'),
  optionalBool('teleCaller.isEnabled'),
];

module.exports = {
  bootstrapHospitalSettings,
  getHospitalSettingsMeQuery,
  createHospitalSettings,
  updateHospitalSettings,
};
