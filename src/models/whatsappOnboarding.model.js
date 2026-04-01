const mongoose = require("mongoose");

const whatsappOnboardingSchema = new mongoose.Schema(
  {
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      unique: true,
    },
    registrationPhone: { type: Boolean, default: false },
    subscribeApp: { type: Boolean, default: false },
    verifyRegistration: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WhatsAppOnboarding", whatsappOnboardingSchema);
