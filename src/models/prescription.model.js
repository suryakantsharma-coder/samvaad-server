const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    dosage: { type: mongoose.Schema.Types.Mixed, required: false }, // string or { value, unit }
    frequency: { type: String, required: false, trim: true },
    duration: { type: mongoose.Schema.Types.Mixed, required: false }, // string or { value, unit }
    intake: { type: String, trim: true, default: '' },
    time: {
      type: {
        breakfast: { type: Boolean, default: false },
        lunch: { type: Boolean, default: false },
        dinner: { type: Boolean, default: false },
      },
      default: undefined,
    },
    notes: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const followUpSchema = new mongoose.Schema(
  { value: { type: Number }, unit: { type: String, trim: true } },
  { _id: false }
);

const prescriptionSchema = new mongoose.Schema(
  {
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: false,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },
    patientName: {
      type: String,
      trim: true,
      default: '',
    },
    appointment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      required: false,
      index: true,
    },
    appointmentDate: {
      type: Date,
      required: false,
    },
    followUp: {
      type: followUpSchema,
      required: false,
    },
    medicines: {
      type: [medicineSchema],
      required: true,
      default: [],
      validate: {
        validator(v) {
          return Array.isArray(v) && v.length > 0;
        },
        message: 'At least one medicine is required',
      },
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['Draft', 'Completed', 'Cancelled'],
      default: 'Draft',
    },
  },
  { timestamps: true }
);

prescriptionSchema.index({ status: 1 });
prescriptionSchema.index({ patient: 1, createdAt: -1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);
