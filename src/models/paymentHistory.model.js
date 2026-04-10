const mongoose = require("mongoose");

/**
 * Razorpay webhook-driven payment audit trail (captured / failed).
 * Optional hospital / patient / doctor link when present on order or payment notes.
 */
const paymentHistorySchema = new mongoose.Schema(
  {
    payment_id: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    order_id: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    /** captured | failed — aligned with payment.captured / payment.failed webhooks */
    status: {
      type: String,
      required: true,
      enum: ["captured", "failed"],
    },
    /** Razorpay payment entity created_at (UTC). */
    createdAt: {
      type: Date,
      required: true,
    },
    /** Wall-clock payment moment (defaults to createdAt when not supplied). */
    paymentDate: {
      type: Date,
      required: false,
      index: true,
    },
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: false,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: false,
      index: true,
    },
    doctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: false,
      index: true,
    },
  },
  {
    timestamps: false,
  },
);

paymentHistorySchema.index({ createdAt: -1 });
paymentHistorySchema.index({ hospital: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentHistory", paymentHistorySchema);
