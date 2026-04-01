const mongoose = require("mongoose");

const whatsappSchema = new mongoose.Schema(
  {
    waba_id: { type: String, trim: true },
    phone_number_id: { type: String, trim: true },
    access_token: { type: String, trim: true },
    api_version: { type: String, trim: true, default: "v21.0" },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
    },
  },
  { timestamps: true }
);

whatsappSchema.index({ hospitalId: 1 });

module.exports = mongoose.model("WhatsApp", whatsappSchema);
