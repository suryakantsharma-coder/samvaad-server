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

    /** Main emergency / casualty contact (digits or E.164-style string). */
    emergencyNumber: {
      type: String,
      required: true,
      trim: true,
    },

    /** Front desk / reception. */
    receptionistNumber: {
      type: String,
      required: true,
      trim: true,
    },

    /** WhatsApp business / hospital line (digits or international format). */
    whatsappNumber: {
      type: String,
      required: true,
      trim: true,
    },

    /** At least one public review link (Google, Practo, etc.). */
    reviewUrls: {
      type: [String],
      required: true,
      validate: {
        validator(v) {
          return (
            Array.isArray(v) &&
            v.length > 0 &&
            v.every((u) => typeof u === "string" && u.trim().length > 0)
          );
        },
        message: "reviewUrls must be a non-empty array of non-empty strings",
      },
    },

    logoUrl: {
      type: String,
      default: "",
      trim: true,
    },

    /** Platform-wide: inactive hospitals can be hidden from listings (super_admin can filter GET list/search). */
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

hospitalSchema.index({ email: 1 }, { unique: true });
hospitalSchema.index({ registrationNumber: 1 }, { unique: true });

module.exports = mongoose.model("Hospital", hospitalSchema);

