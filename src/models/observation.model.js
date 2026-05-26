const mongoose = require('mongoose');

const observationEntrySchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    time: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { _id: true }
);

const observationSchema = new mongoose.Schema(
  {
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: false,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      unique: true,
      index: true,
    },
    observations: {
      type: [observationEntrySchema],
      default: [],
      required: true,
    },
  },
  { timestamps: true }
);

observationSchema.index({ patientId: 1, createdAt: -1 });

module.exports = mongoose.model('Observation', observationSchema);
