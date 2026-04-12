const mongoose = require('mongoose');
const Patient = require('../models/patient.model');
const Hospital = require('../models/hospital.model');
const Appointment = require('../models/appointment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const { getLinkedHospitalForResponse } = require('../utils/hospitalScope');
const { verifyRazorpayPaymentSignature } = require('../utils/razorpayVerify');
const { fetchRazorpayPayment } = require('../services/razorpayPaymentFetch');
const env = require('../config/env');
const { ROLES } = require('../constants/roles');

/**
 * GET /api/tele-caller/patients/:patientId
 * Public — no JWT or roles. Returns patient + linked hospital by Mongo id (no hospital scoping).
 */
const getPatientWithHospital = async (req, res, next) => {
  try {
    const filter = { _id: req.params.patientId };

    const patient = await Patient.findOne(filter).lean();
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    let hospital = null;
    if (patient.hospital) {
      hospital = await Hospital.findById(patient.hospital).lean();
    }

    const lastAppointment = await Appointment.findOne({ patient: patient._id })
      .sort({ appointmentDateTime: -1, createdAt: -1 })
      .populate('doctor', 'fullName doctorId designation email')
      .lean();

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        patient,
        hospital,
        lastAppointment,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/tele-caller/transactions
 * Store Razorpay payment with links and audit fields; verify signature when secret is configured.
 */
const createPaymentTransaction = async (req, res, next) => {
  try {
    const {
      patientId,
      appointmentId,
      hospitalId,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      consentAcknowledged,
      termsVersion,
      internalNotes,
    } = req.body;

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const hospital = await Hospital.findById(hospitalId).lean();
    if (!hospital) {
      return res.status(404).json({ success: false, message: 'Hospital not found' });
    }

    if (patient.hospital && String(patient.hospital) !== String(hospitalId)) {
      return res.status(400).json({
        success: false,
        message: 'Patient is not linked to the given hospital',
      });
    }

    const appointment = await Appointment.findById(appointmentId).lean();
    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    if (String(appointment.patient) !== String(patientId)) {
      return res.status(400).json({ success: false, message: 'Appointment does not belong to this patient' });
    }

    const apH = appointment.hospital ? String(appointment.hospital) : null;
    const patH = patient.hospital ? String(patient.hospital) : null;
    const expectedHospital = apH || patH;
    if (expectedHospital && expectedHospital !== String(hospitalId)) {
      return res.status(400).json({
        success: false,
        message: 'Hospital id does not match the patient or appointment records',
      });
    }

    // Hospital-scoped users: enforce their hospital
    const role = req.user.role;
    if ([ROLES.TELE_CALLER, ROLES.HOSPITAL_ADMIN].includes(role) && req.user.hospital) {
      if (String(req.user.hospital) !== String(hospitalId)) {
        return res.status(403).json({ success: false, message: 'You can only record transactions for your hospital' });
      }
    }

    const secret = env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(503).json({
        success: false,
        message: 'Payment recording requires RAZORPAY_KEY_SECRET to be set for server-side signature verification',
      });
    }

    const signatureVerified = verifyRazorpayPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      secret
    );
    if (!signatureVerified) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Razorpay signature',
      });
    }

    const existing = await PaymentTransaction.findOne({ razorpayPaymentId: razorpay_payment_id }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'This Razorpay payment id is already recorded',
        data: { transactionId: existing._id },
      });
    }

    const remote = await fetchRazorpayPayment(razorpay_payment_id);

    const clientIp =
      req.ip ||
      (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) ||
      '';

    const doc = await PaymentTransaction.create({
      patient: new mongoose.Types.ObjectId(patientId),
      hospital: new mongoose.Types.ObjectId(hospitalId),
      appointment: new mongoose.Types.ObjectId(appointmentId),
      recordedVia: 'tele_caller_api',
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      razorpaySignature: razorpay_signature,
      signatureVerified,
      amount: remote?.amount,
      currency: remote?.currency || 'INR',
      razorpayStatus: remote?.status,
      paymentMethod: remote?.method,
      razorpayCreatedAt: remote?.createdAt,
      patientNameSnapshot: patient.fullName,
      patientPhoneSnapshot: patient.phoneNumber,
      hospitalNameSnapshot: hospital.name,
      appointmentIdDisplaySnapshot: appointment.appointmentId || String(appointmentId),
      recordedBy: req.user._id,
      recordedAt: new Date(),
      clientIp: clientIp || undefined,
      userAgent: req.headers['user-agent'] || undefined,
      consentAcknowledged: Boolean(consentAcknowledged),
      termsVersion: termsVersion || undefined,
      internalNotes: internalNotes || undefined,
    });

    const populated = await PaymentTransaction.findById(doc._id)
      .populate('patient', 'fullName patientId phoneNumber')
      .populate('hospital', 'name registrationNumber city')
      .populate('appointment', 'appointmentId appointmentDateTime status')
      .populate('recordedBy', 'name email role')
      .lean();

    res.status(201).json({
      success: true,
      data: { transaction: populated },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Duplicate Razorpay payment id',
      });
    }
    next(err);
  }
};

module.exports = {
  getPatientWithHospital,
  createPaymentTransaction,
};
