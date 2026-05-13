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
  normalizeAppointmentDateTimeISOForBooking,
} = require("../utils/appointmentDateTimeIST");
const {
  formatCalendarDateIST,
  istCalendarYear,
} = require("../utils/queryDateRange");
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

function buildBookingSuccessVoiceMessages(
  appointmentId,
  doctorName,
  whenHi,
  whenGu,
  opts = {},
) {
  if (opts.updated) {
    return {
      messageHindi: `ठीक है—मैंने आपकी अपॉइंटमेंट नंबर ${appointmentId} अपडेट कर दी है। डॉ. ${doctorName}, ${whenHi}। थोड़ी देर में WhatsApp पर अपडेट की जानकारी मिल जाएगी। कृपया समय पर पहुँचिए। अगर बाद में फिर से समय बदलवाना हो तो WhatsApp पर संपर्क करें।`,
      messageGujarati: `બરાબર—મેં તમારી મુલાકાત નંબર ${appointmentId} અપડેટ કરી દીધી છે. ડૉ. ${doctorName}, ${whenGu}. થોડી વારમાં WhatsApp પર નવી વિગત મળી જશે. સમયસર પહોંચી જજો. અગર સમય બદલાવવો હોય તો WhatsApp પર સંપર્ક કરજો.`,
    };
  }
  return {
    messageHindi: `मैंने आपकी अपॉइंटमेंट बुक कर ली है। अपॉइंटमेंट नंबर: ${appointmentId}। डॉ. ${doctorName}, ${whenHi}। थोड़ी देर में WhatsApp पर पुष्टि आ जाएगी। कृपया समय पर पहुँचिए। अगर बाद में अपॉइंटमेंट का समय बदलवाना हो तो WhatsApp पर संपर्क करें।`,
    messageGujarati: `મેં તમારી મુલાકાત બુક કરી દીધી છે. રેફરન્સ નંબર ${appointmentId}. ડૉ. ${doctorName}, ${whenGu}. થોડી વારમાં WhatsApp પર વિગત મળી જશે. સમયસર પહોંચી જજો. અગર મુલાકાતનો સમય બદલાવવો હોય તો WhatsApp પર સંપર્ક કરજો.`,
  };
}

function isDuplicateKeyError(err) {
  return Boolean(
    err &&
      (err.code === 11000 ||
        err.code === "11000" ||
        String(err.message || "").includes("E11000")),
  );
}

async function findAppointmentInSlotWindow(
  hospitalObjectId,
  patientObjectId,
  doctorObjectId,
  dt,
  dtWindowMs,
) {
  return AppointmentModel.findOne({
    hospital: hospitalObjectId,
    patient: patientObjectId,
    doctor: doctorObjectId,
    appointmentDateTime: {
      $gte: new Date(dt.getTime() - dtWindowMs),
      $lte: new Date(dt.getTime() + dtWindowMs),
    },
  }).lean();
}

function buildCreateAppointmentSuccessResult({
  appointmentDoc,
  doctorName,
  whenHi,
  whenGu,
  messageEn,
  appointmentUpdated = false,
}) {
  const voice = buildBookingSuccessVoiceMessages(
    appointmentDoc.appointmentId,
    doctorName,
    whenHi,
    whenGu,
    { updated: appointmentUpdated },
  );
  return {
    ok: true,
    appointmentUpdated: Boolean(appointmentUpdated),
    appointment: {
      _id: String(appointmentDoc._id),
      appointmentId: appointmentDoc.appointmentId,
      hospital: String(appointmentDoc.hospital || ""),
      patient: String(appointmentDoc.patient),
      doctor: String(appointmentDoc.doctor),
      reason: appointmentDoc.reason,
      status: appointmentDoc.status,
      type: appointmentDoc.type,
      appointmentDateTime: formatInstantAsISTIso(
        appointmentDoc.appointmentDateTime,
      ),
    },
    message: messageEn,
    messageHindi: voice.messageHindi,
    messageGujarati: voice.messageGujarati,
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
        if (!reason) {
          return appointmentBilingualError(
            "Visit reason is required for create_patient.",
            "अपॉइंटमेंट के लिए पहले यह ज़रूरी है कि किस समस्या या बीमारी के लिए डॉक्टर से मिलना है। कृपया वही एक बार फिर बता दीजिए।",
            "અપોઇન્ટમેન્ટ માટે પહેલા એ જણાવવું જરૂરી છે કે શી તકલીફ માટે ડૉક્ટર પાસે આવવું છે. એ ફરી એક વાર સમજાવશો?",
          );
        }
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
      const rawAppointmentDateTimeISO = String(
        args.appointmentDateTimeISO || args.appointmentDateTime || "",
      ).trim();
      const type = String(args.type || "call").trim() || "call";
      if (!mongoose.isValidObjectId(doctorObjectId)) {
        return appointmentBilingualError(
          "Invalid doctorObjectId.",
          "माफ़ कीजिए—डॉक्टर की जानकारी सही नहीं है। कृपया list_doctors से सही डॉक्टर का MongoDB _id इस्तेमाल करें।",
          "માફ કરશો—ડૉક્ટરની વિગત સાચી નથી. list_doctors માંથી સાચા ડૉક્ટરનો MongoDB _id વાપરો.",
        );
      }
      if (!mongoose.isValidObjectId(patientObjectId)) {
        return appointmentBilingualError(
          "Call create_patient or fetch_patient_* first; patientObjectId must be the MongoDB _id from that tool (24 hex). Never use age, patientId P-…, or a short number.",
          "अपॉइंटमेंट से पहले मरीज़ का रिकॉर्ड बनाना ज़रूरी है—पहले create_patient चलाइए (या fetch), फिर उसी जवाब में मिले patient._id को patientObjectId में डालकर create_appointment चलाइए। उम्र या छोटा नंबर patientObjectId नहीं हो सकता।",
          "એપોઇન્ટમેન્ટ પહેલા દર્દીની નોંધ જરૂરી છે—પહેલા create_patient (અથવા fetch) ચલાવો, પછી જે patient._id મળે તે જ patientObjectId તરીકે create_appointment માં વાપરો. ઉંમર કે નાનો નંબર patientObjectId નથી બનતો.",
        );
      }

      const normalizedDateTime = normalizeAppointmentDateTimeISOForBooking(
        rawAppointmentDateTimeISO,
      );
      if (normalizedDateTime.hadZSuffix) {
        console.warn(
          logTag,
          "[create_appointment] normalized trailing Z as IST wall time:",
          rawAppointmentDateTimeISO,
          "→",
          normalizedDateTime.iso,
        );
      }
      const appointmentDateTimeISO = normalizedDateTime.iso;
      const dt = parseAppointmentDateTimeAsIST(appointmentDateTimeISO);
      if (Number.isNaN(dt.getTime())) {
        return appointmentBilingualError(
          "Invalid appointmentDateTimeISO.",
          "माफ़ कीजिए—तारीख या समय साफ़ नहीं लग रहा। कृपया अपॉइंटमेंट की तारीख और समय एक बार फिर बता दीजिए।",
          "માફ કરશો—તારીખ કે સમય સાફ નથી લાગતો. મુલાકાતની સાચી તારીખ અને વખત ફરી જણાવશો?",
        );
      }
      if (!reason) {
        return appointmentBilingualError(
          "Reason is required.",
          "अपॉइंटमेंट बुक करने से पहले यह ज़रूरी है कि किस बीमारी या समस्या के लिए मुलाकात चाहिए—कृपया वह पहले बता दीजिए।",
          "અપોઇન્ટમેન્ટ પહેલાં એ જણાવવું જરૂરી છે કે શા માટે ડૉક્ટર પાસે આવવું છે—એ પહેલા સમજાવશો?",
        );
      }

      // Tool contract requires English reason — skip the extra OpenAI call so
      // final booking is fast (was the main source of latency).
      const reasonDb = reason;
      const startedAt = Date.now();
      const dtWindowMs = 60 * 1000; // ±1 min tolerance for duplicate guard

      const existingAppointmentObjectId = String(
        args.existingAppointmentObjectId || "",
      ).trim();

      if (mongoose.isValidObjectId(existingAppointmentObjectId)) {
        const prev = await AppointmentModel.findOne({
          _id: existingAppointmentObjectId,
          hospital: hospitalObjectId,
        }).lean();
        if (!prev) {
          return appointmentBilingualError(
            "Appointment not found for update.",
            "माफ़ कीजिए—अपडेट के लिए अपॉइंटमेंट नहीं मिली। कृपया दोबारा बुक करने की कोशिश करें।",
            "માફ કરશો—અપડેટ માટે મુલકાત મળી નથી. ફરી બુક કરવાનો પ્રયાસ કરશો?",
          );
        }
        if (String(prev.patient) !== patientObjectId) {
          return appointmentBilingualError(
            "Patient does not match appointment being updated.",
            "माफ़ कीजिए—मरीज़ की जानकारी इस अपॉइंटमेंट से मेल नहीं खाती। कृपया सही विवरण के साथ फिर कोशिश करें।",
            "માફ કરશો—દર્દીની વિગત આ મુલાકાત સાથે મેળ ખાતી નથી. સાચી વિગતથી ફરી પ્રયાસ કરશો?",
          );
        }

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

        console.log(
          logTag,
          "[create_appointment] update existing",
          JSON.stringify({
            appointmentMongoId: existingAppointmentObjectId,
            raw: rawAppointmentDateTimeISO,
            normalized: appointmentDateTimeISO,
            istYmd: formatCalendarDateIST(dt),
          }),
        );

        if (!doctor) {
          return appointmentBilingualError(
            "Doctor not found for this hospital.",
            "माफ़ कीजिए—यह डॉक्टर इस अस्पताल से जुड़ा नहीं लगता। कृपया सूची में से सही डॉक्टर चुन लीजिए।",
            "માફ કરશો—આ ડૉક્ટર આ હોસ્પિટલ સાથે જોડાયેલા નથી લાગતા. યાદીમાંથી બીજા ડૉક્ટર પસંદ કરશો?",
          );
        }
        if (!patient) {
          return appointmentBilingualError(
            "Patient not found for this hospital.",
            "माफ़ कीजिए—मरीज़ का रिकॉर्ड नहीं मिला। कृपया सही विवरण से फिर से खोजें या नया पंजीकरण कराएं।",
            "માફ કરશો—દર્દીનો રેકોર્ડ મળ્યો નથી. સાચી વિગતથી ફરી શોધશો કે નવી નોંધણી કરાવશો?",
          );
        }

        const appointmentYmdUpdate = formatCalendarDateIST(dt);
        const holidayBlockUpdate = findHolidayCoveringYmdIST(
          doctor.holidays || [],
          appointmentYmdUpdate,
        );
        if (holidayBlockUpdate) {
          const msgs = holidayBlockMessages(
            doctor.fullName,
            holidayBlockUpdate.endLabel,
          );
          return {
            ok: false,
            code: "DOCTOR_ON_LEAVE",
            messageHindi: msgs.messageHindi,
            messageGujarati: msgs.messageGujarati,
            message: msgs.messageEnglish,
          };
        }

        const winUpdate = parseDoctorAvailabilityWindow(doctor.availability);
        const hmUpdate = getHourMinuteIST(dt);
        if (
          !isTimeWithinDoctorAvailability(hmUpdate.h, hmUpdate.min, {
            ranges: winUpdate.ranges,
          })
        ) {
          const msgs = outsideHoursMessages(doctor.fullName, winUpdate.label);
          return {
            ok: false,
            code: "OUTSIDE_DOCTOR_HOURS",
            messageHindi: msgs.messageHindi,
            messageGujarati: msgs.messageGujarati,
            message: msgs.messageEnglish,
          };
        }

        const dupOther = await AppointmentModel.findOne({
          hospital: hospitalObjectId,
          patient: patientObjectId,
          doctor: doctorObjectId,
          appointmentDateTime: {
            $gte: new Date(dt.getTime() - dtWindowMs),
            $lte: new Date(dt.getTime() + dtWindowMs),
          },
          _id: { $ne: existingAppointmentObjectId },
        }).lean();

        if (dupOther) {
          return appointmentBilingualError(
            "Another appointment already uses this slot.",
            "माफ़ कीजिए—यह समय पहले से किसी और बुकिंग में है। कृपया दूसरा समय बताइए।",
            "માફ કરશો—આ સમય પહેલેથી બીજી બુકિંગમાં છે. બીજો સમય જણાવશો?",
          );
        }

        const updatedDoc = await AppointmentModel.findOneAndUpdate(
          {
            _id: existingAppointmentObjectId,
            hospital: hospitalObjectId,
          },
          {
            $set: {
              doctor: doctorObjectId,
              reason: reasonDb,
              appointmentDateTime: dt,
              type,
            },
          },
          { new: true, runValidators: true },
        ).lean();

        if (!updatedDoc) {
          return appointmentBilingualError(
            "Could not update appointment.",
            "माफ़ कीजिए—अपॉइंटमेंट अपडेट नहीं हो पाई। कृपया फिर कोशिश करें।",
            "માફ કરશો—મુલાકાત અપડેટ થઈ શકી નહીં. ફરી પ્રયાસ કરશો?",
          );
        }

        const doctorNameU = (doctor && doctor.fullName) || "";
        const { hindi: whenHiU, gujarati: whenGuU } =
          formatAppointmentDateTimeForVoice(dt);

        console.log(
          logTag,
          "[create_appointment] UPDATED OK",
          JSON.stringify({
            appointmentId: updatedDoc.appointmentId,
            appointmentMongoId: String(updatedDoc._id),
            durationMs: Date.now() - startedAt,
          }),
        );

        return buildCreateAppointmentSuccessResult({
          appointmentDoc: updatedDoc,
          doctorName: doctorNameU,
          whenHi: whenHiU,
          whenGu: whenGuU,
          messageEn:
            "Appointment updated. Speak messageHindi or messageGujarati once as status.",
          appointmentUpdated: true,
        });
      }

      // Fetch doctor, patient and check for a duplicate — all in parallel.
      const [doctor, patient, existingAppt] = await Promise.all([
        DoctorModel.findOne({
          _id: doctorObjectId,
          hospital: hospitalObjectId,
        }).lean(),
        PatientModel.findOne({
          _id: patientObjectId,
          hospital: hospitalObjectId,
        }).lean(),
        AppointmentModel.findOne({
          hospital: hospitalObjectId,
          patient: patientObjectId,
          doctor: doctorObjectId,
          appointmentDateTime: {
            $gte: new Date(dt.getTime() - dtWindowMs),
            $lte: new Date(dt.getTime() + dtWindowMs),
          },
        }).lean(),
      ]);
      console.log(
        logTag,
        "[create_appointment] datetime",
        JSON.stringify({
          raw: rawAppointmentDateTimeISO,
          normalized: appointmentDateTimeISO,
          istYmd: formatCalendarDateIST(dt),
        }),
      );
      if (!doctor) {
        return appointmentBilingualError(
          "Doctor not found for this hospital.",
          "माफ़ कीजिए—यह डॉक्टर इस अस्पताल से जुड़ा नहीं लगता। कृपया सूची में से सही डॉक्टर चुन लीजिए।",
          "માફ કરશો—આ ડૉક્ટર આ હોસ્પિટલ સાથે જોડાયેલા નથી લાગતા. યાદીમાંથી બીજા ડૉક્ટર પસંદ કરશો?",
        );
      }
      if (!patient) {
        return appointmentBilingualError(
          "Patient not found for this hospital.",
          "माफ़ कीजिए—मरीज़ का रिकॉर्ड नहीं मिला। कृपया सही विवरण से फिर से खोजें या नया पंजीकरण कराएं।",
          "માફ કરશો—દર્દીનો રેકોર્ડ મળ્યો નથી. સાચી વિગતથી ફરી શોધશો કે નવી નોંધણી કરાવશો?",
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

      // Return existing appointment if this is a duplicate call (same slot).
      if (existingAppt) {
        console.log(
          logTag,
          "[create_appointment] DUPLICATE SKIPPED — returning existing",
          JSON.stringify({
            appointmentId: existingAppt.appointmentId,
            durationMs: Date.now() - startedAt,
          }),
        );
        return buildCreateAppointmentSuccessResult({
          appointmentDoc: existingAppt,
          doctorName,
          whenHi,
          whenGu,
          messageEn:
            "Already booked. Speak messageHindi or messageGujarati once as booking status.",
        });
      }

      const year = istCalendarYear();
      const prefix = `A-${year}-`;
      let appointment = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
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
        try {
          appointment = await AppointmentModel.create({
            hospital: hospitalObjectId,
            appointmentId,
            patient: patientObjectId,
            doctor: doctorObjectId,
            reason: reasonDb,
            status: "Upcoming",
            type,
            appointmentDateTime: dt,
          });
          break;
        } catch (createErr) {
          if (!isDuplicateKeyError(createErr)) {
            throw createErr;
          }
          const dup = await findAppointmentInSlotWindow(
            hospitalObjectId,
            patientObjectId,
            doctorObjectId,
            dt,
            dtWindowMs,
          );
          if (dup) {
            appointment = dup;
            break;
          }
          if (attempt >= 2) {
            throw createErr;
          }
        }
      }

      if (!appointment) {
        return appointmentBilingualError(
          "Could not create appointment.",
          "माफ़ कीजिए—अपॉइंटमेंट बुक नहीं हो पाई। कृपया एक बार फिर कोशिश करें या दूसरा समय बता दीजिए।",
          "માફ કરશો—અપોઇન્ટમેન્ટ બુક થઈ શકી નહીં. એક વાર ફરી પ્રયાસ કરશો કે બીજો સમય જણાવશો?",
        );
      }

      console.log(
        logTag,
        "[create_appointment] BOOKED OK",
        JSON.stringify({
          appointmentId: appointment.appointmentId,
          appointmentMongoId: String(appointment._id),
          durationMs: Date.now() - startedAt,
        }),
      );
      return buildCreateAppointmentSuccessResult({
        appointmentDoc: appointment,
        doctorName,
        whenHi,
        whenGu,
        messageEn:
          "Booked. Speak messageHindi or messageGujarati once as booking status (no second confirmation — they already confirmed).",
      });
    }

    return { ok: false, message: `Unknown tool: ${name}` };
  } catch (err) {
    console.error(logTag, "Tool execution error:", err.message);
    if (name === "create_appointment") {
      return appointmentBilingualError(
        err.message || "Tool error",
        "माफ़ कीजिए—अपॉइंटमेंट बुक नहीं हो पाई। कृपया एक बार फिर कोशिश करें या दूसरा समय बता दीजिए।",
        "માફ કરશો—અપોઇન્ટમેન્ટ બુક થઈ શકી નહીં. એક વાર ફરી પ્રયાસ કરશો કે બીજો સમય જણાવશો?",
      );
    }
    return { ok: false, message: err.message || "Tool error" };
  }
}

module.exports = { runHospitalTool };
