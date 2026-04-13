const mongoose = require("mongoose");

const GOOGLE_PROVIDER = "google_calendar";

const googleOAuthTokenSchema = new mongoose.Schema(
  {
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    /** Logical provider key; uniqueness is `{ hospital, provider }`, never unique on `provider` alone. */
    provider: {
      type: String,
      required: true,
      trim: true,
      default: GOOGLE_PROVIDER,
    },
    accessToken: {
      type: String,
      default: "",
      trim: true,
    },
    refreshToken: {
      type: String,
      default: "",
      trim: true,
    },
    expiryDate: {
      type: Date,
      default: null,
    },
    scope: {
      type: String,
      default: "",
      trim: true,
    },
    tokenType: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

googleOAuthTokenSchema.index({ hospital: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model("GoogleOAuthToken", googleOAuthTokenSchema);
module.exports.GOOGLE_PROVIDER = GOOGLE_PROVIDER;
