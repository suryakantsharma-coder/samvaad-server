const mongoose = require("mongoose");

const googleOAuthTokenSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      default: "google_calendar",
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
  }
);

module.exports = mongoose.model("GoogleOAuthToken", googleOAuthTokenSchema);
