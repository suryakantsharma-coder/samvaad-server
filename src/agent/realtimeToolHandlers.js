/**
 * Shared hospital tool execution for OpenAI Realtime (Exotel and frontend).
 * Returns the output object; caller sends it via conversation.item.create + response.create.
 */
const mongoose = require("mongoose");
const AppointmentModel = require("../models/appointment.model");
const DoctorModel = require("../models/doctor.model");
const PatientModel = require("../models/patient.model");
const {
  parseAppointmentDateTimeAsIST,
  formatInstantAsISTIso,
} = require("../utils/appointmentDateTimeIST");

const logTag = "[RealtimeTools]";

async function runHospitalTool(hospitalObjectId, name, args, options = {}) {
  const { callerPhone = null } = options;

  try {
    if (name === "fetch_patient_by_patientId") {
      const patientId = String(args.patientId || "").trim();
      const patient = await PatientModel.findOne({
        patientId,
        hospital: hospitalObjectId,
      }).lean();
      if (!patient) {
        return { ok: false, message: "Patient not found for this hospital." };
      }
      return {
        ok: true,
        patient: {
          _id: String(patient._id),
          patientId: patient.patientId,
          fullName: patient.fullName,
          age: patient.age,
          gender: patient.gender,
          phoneNumber: patient.phoneNumber,
          reason: patient.reason,
          hospital: String(patient.hospital || ""),
        },
      };
    }

    if (name === "fetch_patient_by_phone") {
      const raw = String(args.phoneNumber || "").trim();
      const digits = raw.replace(/\D/g, "");
      const phoneNumber = digits.length >= 10 ? digits.slice(-10) : digits;
      if (!phoneNumber || phoneNumber.length !== 10) {
        return {
          ok: false,
          message: "Invalid phone number. Provide a 10-digit mobile number.",
        };
      }
      const patient = await PatientModel.findOne({
        hospital: hospitalObjectId,
        $or: [
          { phoneNumber },
          { phoneNumber: raw },
          { phoneNumber: digits },
          { phoneNumber: "0" + phoneNumber },
        ],
      }).lean();
      if (!patient) {
        return {
          ok: false,
          message:
            "No patient registered with this phone number at this hospital.",
        };
      }
      return {
        ok: true,
        patient: {
          _id: String(patient._id),
          patientId: patient.patientId,
          fullName: patient.fullName,
          age: patient.age,
          gender: patient.gender,
          phoneNumber: patient.phoneNumber,
          reason: patient.reason,
          hospital: String(patient.hospital || ""),
        },
      };
    }

    if (name === "create_patient") {
      const fullName = String(args.fullName || "").trim();
      const age = Number(args.age);
      const gender = String(args.gender || "").trim();
      const reason = String(args.reason || "").trim();
      const argsPhone = String(args.phoneNumber || "").trim();
      const fromCall =
        callerPhone && callerPhone !== "unknown" ? callerPhone : "";
      const phoneNumber =
        fromCall ||
        (argsPhone && argsPhone.toLowerCase() !== "not provided" ? argsPhone : "");
      if (
        !fullName ||
        !Number.isFinite(age) ||
        age < 0 ||
        !phoneNumber ||
        !reason
      ) {
        return { ok: false, message: "Missing/invalid patient fields." };
      }
      const year = new Date().getFullYear();
      const prefix = `P-${year}-`;
      const last = await PatientModel.findOne({
        patientId: new RegExp(`^${prefix}`),
      })
        .sort({ patientId: -1 })
        .select("patientId")
        .lean();
      const nextNum = last
        ? parseInt(String(last.patientId).slice(prefix.length), 10) + 1
        : 1;
      const patientId = `${prefix}${String(nextNum).padStart(6, "0")}`;
      const patient = await PatientModel.create({
        hospital: hospitalObjectId,
        patientId,
        fullName,
        age,
        gender,
        phoneNumber,
        reason,
      });
      return {
        ok: true,
        patient: {
          _id: String(patient._id),
          patientId: patient.patientId,
          fullName: patient.fullName,
          age: patient.age,
          gender: patient.gender,
          phoneNumber: patient.phoneNumber,
          reason: patient.reason,
          hospital: String(patient.hospital || ""),
        },
      };
    }

    if (name === "list_doctors") {
      const doctors = await DoctorModel.find({
        hospital: hospitalObjectId,
      })
        .select("_id fullName doctorId designation availability status")
        .lean();
      const doctorsPayload = doctors.map((d) => ({
        _id: String(d._id),
        doctorId: d.doctorId || "",
        fullName: d.fullName,
        designation: d.designation,
        availability: d.availability,
        status: d.status,
      }));
      return {
        ok: true,
        doctors: doctorsPayload,
        message: `List of ${doctors.length} doctor(s). Pick the doctor whose designation matches the patient's illness, then use that doctor's _id as doctorObjectId in create_appointment.`,
      };
    }

    if (name === "search_doctors") {
      const query = String(args.query || "").trim();
      const limit = Math.max(1, Math.min(20, Number(args.limit || 10)));
      if (!query) {
        return {
          ok: false,
          message: "Query is required. To get all doctors use list_doctors.",
        };
      }
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      const doctors = await DoctorModel.find({
        hospital: hospitalObjectId,
        $or: [{ fullName: regex }, { designation: regex }],
      })
        .select("_id fullName doctorId designation availability status")
        .limit(limit)
        .lean();
      const doctorsPayload = doctors.map((d) => ({
        _id: String(d._id),
        doctorId: d.doctorId || "",
        fullName: d.fullName,
        designation: d.designation,
        availability: d.availability,
        status: d.status,
      }));
      return { ok: true, doctors: doctorsPayload };
    }

    if (name === "create_appointment") {
      const doctorObjectId = String(args.doctorObjectId || "").trim();
      const patientObjectId = String(args.patientObjectId || "").trim();
      const reason = String(args.reason || "").trim();
      const appointmentDateTimeISO = String(
        args.appointmentDateTimeISO || args.appointmentDateTime || "",
      ).trim();
      const type = String(args.type || "call").trim() || "call";
      if (
        !mongoose.isValidObjectId(doctorObjectId) ||
        !mongoose.isValidObjectId(patientObjectId)
      ) {
        return { ok: false, message: "Invalid doctor or patient id." };
      }
      const dt = parseAppointmentDateTimeAsIST(appointmentDateTimeISO);
      if (Number.isNaN(dt.getTime())) {
        return { ok: false, message: "Invalid appointmentDateTimeISO." };
      }
      if (!reason) return { ok: false, message: "Reason is required." };

      const [doctor, patient] = await Promise.all([
        DoctorModel.findOne({
          _id: doctorObjectId,
          hospital: hospitalObjectId,
        }).lean(),
        PatientModel.findOne({
          _id: patientObjectId,
          hospital: hospitalObjectId,
        }).lean(),
      ]);
      if (!doctor) {
        return { ok: false, message: "Doctor not found for this hospital." };
      }
      if (!patient) {
        return { ok: false, message: "Patient not found for this hospital." };
      }

      const year = new Date().getFullYear();
      const prefix = `A-${year}-`;
      const last = await AppointmentModel.findOne({
        appointmentId: new RegExp(`^${prefix}`),
      })
        .sort({ appointmentId: -1 })
        .select("appointmentId")
        .lean();
      const nextNum = last
        ? parseInt(String(last.appointmentId).slice(prefix.length), 10) + 1
        : 1;
      const appointmentId = `${prefix}${String(nextNum).padStart(6, "0")}`;
      const appointment = await AppointmentModel.create({
        hospital: hospitalObjectId,
        appointmentId,
        patient: patientObjectId,
        doctor: doctorObjectId,
        reason,
        status: "Upcoming",
        type,
        appointmentDateTime: dt,
      });
      return {
        ok: true,
        appointment: {
          _id: String(appointment._id),
          appointmentId: appointment.appointmentId,
          hospital: String(appointment.hospital || ""),
          patient: String(appointment.patient),
          doctor: String(appointment.doctor),
          reason: appointment.reason,
          status: appointment.status,
          type: appointment.type,
          appointmentDateTime: formatInstantAsISTIso(
            appointment.appointmentDateTime,
          ),
        },
      };
    }

    return { ok: false, message: `Unknown tool: ${name}` };
  } catch (err) {
    console.error(logTag, "Tool execution error:", err.message);
    return { ok: false, message: err.message || "Tool error" };
  }
}

module.exports = { runHospitalTool };
