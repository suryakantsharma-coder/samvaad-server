const mongoose = require('mongoose');

const whatsappSettingsSchema = new mongoose.Schema(
  {
    isEnabled: { type: Boolean, default: true },
    appointment: { type: Boolean, default: true },
    prescription: { type: Boolean, default: true },
    medicinesReminder: { type: Boolean, default: true },
  },
  { _id: false }
);

const teleCallerSettingsSchema = new mongoose.Schema(
  {
    isEnabled: { type: Boolean, default: true },
  },
  { _id: false }
);

/**
 * Per-hospital messaging / feature toggles (WhatsApp + tele-caller flows).
 * One document per hospital (`hospitalId` unique).
 */
const hospitalSettingsSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      unique: true,
      index: true,
    },
    whatsapp: {
      type: whatsappSettingsSchema,
      default: () => ({}),
    },
    teleCaller: {
      type: teleCallerSettingsSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('HospitalSettings', hospitalSettingsSchema);
