const mongoose = require("mongoose");
const PaymentHistory = require("../models/paymentHistory.model");
const { getLinkedHospitalForResponse } = require("../utils/hospitalScope");
const { ROLES, isHospitalRole } = require("../constants/roles");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/payments?hospitalId=&page=&limit=
 * Razorpay webhook payment rows scoped to a hospital. Platform admins may query any hospital;
 * doctor / hospital_admin / tele_caller may only query their linked hospital.
 */
const listByHospital = async (req, res, next) => {
  try {
    const requested = String(req.query.hospitalId || "").trim();
    if (!mongoose.isValidObjectId(requested)) {
      return res.status(400).json({ success: false, message: "Invalid hospitalId" });
    }

    const role = req.user.role;
    const isPlatformAdmin = role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;

    if (isHospitalRole(role)) {
      if (!req.user.hospital) {
        return res.status(403).json({
          success: false,
          message: "You must be linked to a hospital to view payments",
        });
      }
      if (String(req.user.hospital) !== requested) {
        return res.status(403).json({
          success: false,
          message: "You can only view payments for your linked hospital",
        });
      }
    } else if (!isPlatformAdmin) {
      return res.status(403).json({ success: false, message: "Insufficient permissions" });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const skip = (page - 1) * limit;

    const filter = { hospital: new mongoose.Types.ObjectId(requested) };

    const [payments, total] = await Promise.all([
      PaymentHistory.find(filter)
        .populate("hospital", "name registrationNumber city")
        .populate("patient", "fullName patientId phoneNumber")
        .populate("doctor", "fullName doctorId designation email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentHistory.countDocuments(filter),
    ]);

    res.json({
      success: true,
      ...getLinkedHospitalForResponse(req),
      data: {
        hospitalId: requested,
        payments,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listByHospital,
};
