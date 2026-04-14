const mongoose = require("mongoose");

const payoutListSchema = new mongoose.Schema(
  {
    hospitalName: {
      type: String,
      required: true,
      trim: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: true,
      index: true,
    },
    /** When this snapshot was last written by the hourly job */
    createdDate: {
      type: Date,
      required: true,
    },
    /** Sum of captured PaymentTransaction.amount (same unit as Razorpay, e.g. paise) */
    totalPrice: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["draft", "paid"],
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

payoutListSchema.index({ hospitalId: 1, startDate: 1, endDate: 1 }, { unique: true });

module.exports = mongoose.model("PayoutList", payoutListSchema);
