const mongoose = require("mongoose");

const exotelCallSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true, unique: true, index: true },
    callSid: { type: String, trim: true, index: true }, // alias of Sid for analytics compatibility
    accountSid: { type: String, trim: true, index: true },
    parentCallSid: { type: String, trim: true, default: "" },
    from: { type: String, trim: true, index: true },
    to: { type: String, trim: true },
    phoneNumber: { type: String, trim: true, index: true },
    phoneNumberDigits: { type: String, trim: true, index: true },
    phoneNumberSid: { type: String, trim: true },
    status: { type: String, trim: true, index: true },
    direction: { type: String, trim: true, index: true },
    answeredBy: { type: String, trim: true, default: "" },
    callerName: { type: String, trim: true, default: "" },
    forwardedFrom: { type: String, trim: true, default: "" },
    customField: { type: String, trim: true, default: "" },
    uri: { type: String, trim: true, default: "" },
    recordingUrl: { type: String, trim: true, default: "" },

    dateCreated: { type: Date, index: true },
    dateUpdated: { type: Date },
    startTime: { type: Date, index: true },
    endTime: { type: Date },

    duration: { type: Number, default: 0 },
    creditUsed: { type: Number, default: 0, index: true },
    price: { type: Number, default: 0 },
    syncMonth: { type: String, index: true }, // YYYY-MM

    // Full Exotel call object as received from API.
    raw: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

exotelCallSchema.index({ syncMonth: 1, sid: 1 });
exotelCallSchema.index({ phoneNumber: 1, dateCreated: 1 });
exotelCallSchema.index({ phoneNumberDigits: 1, dateCreated: 1 });

module.exports = mongoose.model("ExotelCall", exotelCallSchema);
