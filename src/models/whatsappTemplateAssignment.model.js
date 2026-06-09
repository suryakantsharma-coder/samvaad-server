const mongoose = require("mongoose");

const templateKeysSchema = new mongoose.Schema(
  {
    appointmentConfirmation: { type: String, trim: true, default: "" },
    postOpdPrescription: { type: String, trim: true, default: "" },
    medicineReminder: { type: String, trim: true, default: "" },
    dosageCompletion: { type: String, trim: true, default: "" },
    dosageFollowupNotYet: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const whatsappTemplateAssignmentSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    phone_number_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    templates: {
      type: templateKeysSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

whatsappTemplateAssignmentSchema.index(
  { hospitalId: 1, phone_number_id: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "WhatsAppTemplateAssignment",
  whatsappTemplateAssignmentSchema
);
