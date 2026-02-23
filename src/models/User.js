const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES } = require('../constants/roles');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
      select: false,
    },
    name: {
      type: String,
      trim: true,
      default: '',
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.USER,
    },
    hospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      required: false,
      index: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

userSchema.index({ role: 1 });

userSchema.pre('save', async function (next) {
  if (this.isModified('role') || this.isModified('hospital')) {
    if ([ROLES.DOCTOR, ROLES.HOSPITAL_ADMIN].includes(this.role)) {
      if (!this.hospital) {
        return next(new Error('Hospital is required for doctor and hospital_admin roles'));
      }
    }
    if ([ROLES.ADMIN, ROLES.MODERATOR].includes(this.role)) {
      this.hospital = undefined;
    }
  }
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
