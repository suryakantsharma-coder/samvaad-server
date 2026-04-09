const mongoose = require('mongoose');

/**
 * Razorpay payment capture + audit trail for tele-caller / billing flows.
 * Links patient, hospital, and optional appointment for disputes and compliance.
 */
const paymentTransactionSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: true,
      index: true,
    },
    appointment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      required: true,
      index: true,
    },

    razorpayPaymentId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    razorpaySignature: {
      type: String,
      required: true,
      trim: true,
    },

    signatureVerified: {
      type: Boolean,
      default: false,
    },

    /** Amount in smallest currency unit (e.g. paise for INR), from Razorpay when fetched */
    amount: { type: Number },
    currency: { type: String, trim: true, default: 'INR' },
    /** Razorpay payment status e.g. authorized, captured, failed */
    razorpayStatus: { type: String, trim: true },
    paymentMethod: { type: String, trim: true },
    razorpayCreatedAt: { type: Date },

    /** Snapshots at record time (legal / disputes; IDs remain canonical in refs) */
    patientNameSnapshot: { type: String, trim: true },
    patientPhoneSnapshot: { type: String, trim: true },
    hospitalNameSnapshot: { type: String, trim: true },
    appointmentIdDisplaySnapshot: { type: String, trim: true },

    /** Who recorded this row */
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    recordedAt: { type: Date, default: Date.now },
    clientIp: { type: String, trim: true },
    userAgent: { type: String, trim: true },

    /** Consent / terms acknowledgement for regulated payments */
    consentAcknowledged: { type: Boolean, default: false },
    termsVersion: { type: String, trim: true },

    /** Notes for internal dispute handling (no PII in free text if policy forbids) */
    internalNotes: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

paymentTransactionSchema.index({ hospital: 1, createdAt: -1 });
paymentTransactionSchema.index({ patient: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentTransaction', paymentTransactionSchema);
