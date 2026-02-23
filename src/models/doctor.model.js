const mongoose = require("mongoose");

const doctorSchema = new mongoose.Schema(
  {
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: false,
      index: true,
    },

    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    doctorId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      // Example: MD-2024-156789
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

    designation: {
      type: String,
      required: true,
      trim: true,
      // Example: Cardiologist, Dermatologist etc
    },

    availability: {
      type: String,
      default: "9 AM - 5 PM",
      trim: true,
    },

    status: {
      type: String,
      enum: ["On Duty", "On Break", "Off Duty", "On Leave"],
      default: "On Duty",
    },

    utilization: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      // Example: 55, 85, 95
    },

    profileImage: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Doctor", doctorSchema);
