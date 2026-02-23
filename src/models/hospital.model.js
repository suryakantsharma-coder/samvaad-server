const mongoose = require("mongoose");

const hospitalSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    phoneCountryCode: {
      type: String,
      default: "+91",
      trim: true,
    },

    phoneNumber: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    contactPerson: {
      type: String,
      required: true,
      trim: true,
    },

    registrationNumber: {
      type: String,
      required: true,
      trim: true,
      // GST / Registration No.
    },

    address: {
      type: String,
      required: true,
      trim: true,
    },

    city: {
      type: String,
      required: true,
      trim: true,
    },

    pincode: {
      type: String,
      required: true,
      trim: true,
    },

    url: {
      type: String,
      required: true,
      trim: true,
    },

    logoUrl: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

hospitalSchema.index({ email: 1 }, { unique: true });
hospitalSchema.index({ registrationNumber: 1 }, { unique: true });

module.exports = mongoose.model("Hospital", hospitalSchema);

