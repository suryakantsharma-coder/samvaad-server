const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema(
  {
    medicineName: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
    unit: {
      type: String,
      required: false,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

medicineSchema.index({ medicineName: 1 });
medicineSchema.index({ createdAt: -1 });
// Case-insensitive index for fast prefix (starts-with) name search.
// The /medicines/search query uses a range [term, term+￿) with this same
// collation, so MongoDB serves it as an indexed range scan (no collection scan).
medicineSchema.index(
  { medicineName: 1 },
  { name: 'medicineName_ci_prefix', collation: { locale: 'en', strength: 2 } },
);

module.exports = mongoose.model('Medicine', medicineSchema);
