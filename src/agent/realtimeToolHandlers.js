/**
 * Shared hospital tool execution for OpenAI Realtime (Exotel and frontend).
 * Returns the output object; caller sends it via conversation.item.create + response.create.
 */
const mongoose = require("mongoose");
const DoctorModel = require("../models/doctor.model");
const PatientModel = require("../models/patient.model");
const {
  parseAppointmentDateTimeAsIST,
} = require("../utils/appointmentDateTimeIST");
const { formatCalendarDateIST } = require("../utils/queryDateRange");
const { findHolidayCoveringYmdIST } = require("../utils/doctorHoliday");
const {
  parseDoctorAvailabilityWindow,
  isTimeWithinDoctorAvailability,
} = require("../../whatsapp-chat-agent/utils/doctorAvailability");
const {
  holidayBlockMessages,
  outsideHoursMessages,
} = require("./doctorAvailabilityVoiceMessages");
const {
  normalizePatientFieldsForStorage,
} = require("../utils/storageEnglishNormalize");
const logTag = "[RealtimeTools]";

const IST = "Asia/Kolkata";

/**
 * Bilingual user-facing copy for the voice agent (Hindi + Gujarati).
 * `message` stays English for logs / model fallback.
 */
function appointmentBilingualError(messageEn, messageHindi, messageGujarati) {
  return {
    ok: false,
    message: messageEn,
    messageHindi,
    messageGujarati,
  };
}

function formatAppointmentDateTimeForVoice(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return { hindi: "", gujarati: "" };
  }
  return {
    hindi: new Intl.DateTimeFormat("hi-IN", {
      timeZone: IST,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
    gujarati: new Intl.DateTimeFormat("gu-IN", {
      timeZone: IST,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
  };
}

function getHourMinuteIST(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) =>
    parseInt(parts.find((x) => x.type === type)?.value || "0", 10);
  return { h: get("hour"), min: get("minute") };
}

function normalizeDigits10(raw) {
  if (raw == null) return "";
  const d = String(raw).replace(/\D/g, "");
  if (d.length >= 10) return d.slice(-10);
  return "";
}

/** set_calling_phone ref first, then auto line / job metadata. */
function effectiveSessionPhone10(options) {
  const ref = options.sessionPhoneRef;
  if (ref && ref.value != null && String(ref.value).trim() !== "") {
    const v = normalizeDigits10(ref.value);
    if (v) return v;
  }
  const c = options.callerPhone;
  if (c == null || String(c).trim() === "") return "";
  if (String(c).trim().toLowerCase() === "unknown") return "";
  return normalizeDigits10(c);
}

async function runHospitalTool(hospitalObjectId, name, args, options = {}) {
  const { callerPhone = null } = options;

  try {
    if (name === "set_calling_phone") {
      const phone10 = normalizeDigits10(args.phoneNumber);
      if (!phone10 || phone10.length !== 10) {
        return {
          ok: false,
          message:
            "Invalid phone number. Ask for a 10-digit Indian mobile and try again.",
        };
      }
      if (options.sessionPhoneRef) {
        options.sessionPhoneRef.value = phone10;
      }
      return {
        ok: true,
        callerPhoneNumber: phone10,
      };
    }

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
      let phoneNumber = normalizeDigits10(raw);
      if (!phoneNumber) {
        phoneNumber = effectiveSessionPhone10(options);
      }
      if (!phoneNumber || phoneNumber.length !== 10) {
        return {
          ok: false,
          message:
            "Invalid or missing phone. Call set_calling_phone with the 10-digit mobile, or pass phoneNumber.",
        };
      }
      const patient = await PatientModel.findOne({
        hospital: hospitalObjectId,
        $or: [
          { phoneNumber },
          { phoneNumber: raw },
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
      const fromArgs =
        argsPhone && argsPhone.toLowerCase() !== "not provided"
          ? normalizeDigits10(argsPhone)
          : "";
      const fromSession = effectiveSessionPhone10(options);
      const phoneNumber = fromArgs || fromSession;
      if (
        !fullName ||
        !Number.isFinite(age) ||
        age < 0 ||
        !phoneNumber ||
        !reason
      ) {
        return {
          ok: false,
          message: phoneNumber
            ? "Missing/invalid patient fields."
            : "No confirmed mobile. Ask the caller for their 10-digit number, call set_calling_phone, then create_patient.",
        };
      }
      const {
        fullName: fullNameDb,
        reason: reasonDb,
        gender: genderDb,
      } = await normalizePatientFieldsForStorage({
        fullName,
        reason,
        gender,
      });
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
        fullName: fullNameDb,
        age,
        gender: genderDb,
        phoneNumber,
        reason: reasonDb,
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
      if (
        !mongoose.isValidObjectId(doctorObjectId) ||
        !mongoose.isValidObjectId(patientObjectId)
      ) {
        return appointmentBilingualError(
          "Invalid doctor or patient id.",
          "माफ़ कीजिए—डॉक्टर या मरीज़ की मान्य जानकारी नहीं मिली। कृपया सही जानकारी के साथ दोबारा प्रयास करें।",
          "માફ કરજો—ડૉક્ટર કે દર્દીની માહિતી માન્ય નથી. કૃપા કરીને યોગ્ય માહિતી સાથે ફરી પ્રયાસ કરો.",
        );
      }
      const dt = parseAppointmentDateTimeAsIST(appointmentDateTimeISO);
      if (Number.isNaN(dt.getTime())) {
        return appointmentBilingualError(
          "Invalid appointmentDateTimeISO.",
          "माफ़ कीजिए—तारीख या समय सही ढंग से सेट नहीं है। कृपया सही अपॉइंटमेंट की तारीख और समय दोबारा बताएं।",
          "માફ કરજો—તારીખ કે સમય યોગ્ય રીતે નથી. કૃપા કરીને એપોઇન્ટમેન્ટની સાચી તારીખ અને સમય ફરી જણાવો.",
        );
      }
      if (!reason) {
        return appointmentBilingualError(
          "Reason is required.",
          "अपॉइंटमेंट बुक करने के लिए पहले यह ज़रूरी है कि किस बीमारी या समस्या के लिए मुलाकात चाहिए—कृपया वह पहले बताएं।",
          "એપોઇન્ટમેન્ટ માટે પહેલા કઈ સમસ્યા માટે મુલાકાત જોઇએ તે જણાવવું ફરજિયાત છે.",
        );
      }

      // ── Validate doctor and patient exist — do NOT write to DB during the call ──
      // The actual appointment is created by the post-call BullMQ worker after the
      // call ends, keeping the voice agent responsive (no DB writes block the caller).
      const startedAt = Date.now();
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
        return appointmentBilingualError(
          "Doctor not found for this hospital.",
          "माफ़ कीजिए—यह डॉक्टर इस अस्पताल के साथ मेल नहीं खाता। कृपया सूची में से सही डॉक्टर चुनें।",
          "માફ કરજો—આ ડૉક્ટર આ હોસ્પિટલ સાથે મેળ ખાતા નથી. યાદીમાંથી સાચા ડૉક્ટર પસંદ કરો.",
        );
      }
      if (!patient) {
        return appointmentBilingualError(
          "Patient not found for this hospital.",
          "माफ़ कीजिए—मरीज़ का रिकॉर्ड नहीं मिला। कृपया सही पहचान वाला मरीज़ पहले ढूंढ लें या नया पंजीकरण करें।",
          "માફ કરજો—દર્દીનો રેકોર્ડ મળ્યો નથી. પહેલા યોગ્ય દર્દી શોધો કે નવી નોંધણી કરો.",
        );
      }

      const appointmentYmdIST = formatCalendarDateIST(dt);
      const holidayBlock = findHolidayCoveringYmdIST(
        doctor.holidays || [],
        appointmentYmdIST,
      );
      if (holidayBlock) {
        const msgs = holidayBlockMessages(
          doctor.fullName,
          holidayBlock.endLabel,
        );
        return {
          ok: false,
          code: "DOCTOR_ON_LEAVE",
          messageHindi: msgs.messageHindi,
          messageGujarati: msgs.messageGujarati,
          message: msgs.messageEnglish,
        };
      }

      const win = parseDoctorAvailabilityWindow(doctor.availability);
      const { h, min } = getHourMinuteIST(dt);
      if (!isTimeWithinDoctorAvailability(h, min, { ranges: win.ranges })) {
        const msgs = outsideHoursMessages(doctor.fullName, win.label);
        return {
          ok: false,
          code: "OUTSIDE_DOCTOR_HOURS",
          messageHindi: msgs.messageHindi,
          messageGujarati: msgs.messageGujarati,
          message: msgs.messageEnglish,
        };
      }

      const doctorName = (doctor && doctor.fullName) || "";
      const { hindi: whenHi, gujarati: whenGu } =
        formatAppointmentDateTimeForVoice(dt);

      console.log(
        logTag,
        "[create_appointment] DETAILS NOTED (appointment will be created after call ends)",
        JSON.stringify({
          doctorObjectId,
          patientObjectId,
          appointmentDateTimeISO,
          doctorName,
          whenHi,
          whenGu,
          durationMs: Date.now() - startedAt,
        }),
      );

      // Return success immediately — the appointment will be created by the
      // post-call worker once the call ends.  The caller hears a confirmation
      // but no sequential DB write blocks the live voice path.
      return {
        ok: true,
        message:
          "Do NOT read messageHindi/messageGujarati aloud — section 9 already thanked and explained WhatsApp; use section 10 hang-up only.",
        messageHindi:
          "जैसे ही आपकी अपॉइंटमेंट बन जाएगी, मैं सुनिश्चित करूँगी कि आपको WhatsApp पर पुष्टि मिल जाए। धन्यवाद।",
        messageGujarati:
          "જેવી જ તમારી એપોઇન્ટમેન્ટ બનશે, હું ખાતરી કરીશ કે તમને WhatsApp પર પુષ્ટિ મળી જાય. આભાર.",
      };
    }

    return { ok: false, message: `Unknown tool: ${name}` };
  } catch (err) {
    console.error(logTag, "Tool execution error:", err.message);
    return { ok: false, message: err.message || "Tool error" };
  }
}

module.exports = { runHospitalTool };
