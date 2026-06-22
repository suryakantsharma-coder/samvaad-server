/**
 * Shared hospital tool execution for OpenAI Realtime (Exotel and frontend).
 * Returns the output object; caller sends it via conversation.item.create + response.create.
 */
const mongoose = require("mongoose");
const AppointmentModel = require("../models/appointment.model");
const DoctorModel = require("../models/doctor.model");
const PatientModel = require("../models/patient.model");
const {
  enqueueAppointmentConfirmation,
} = require("../services/appointmentConfirmationDispatch");
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
const {
  rejectIfSundayOrPast,
  snapToHourBucketStartIST,
  formatHourSlotLabelForVoice,
  loadHourBucketCounts,
  hourBucketStartMinIST,
  isHourBucketWithinAvailability,
  isSundayIST,
} = require("../utils/bookingSlotRules");
const {
  resolveHourBucketCapacity,
  validateDoctorBookingPoliciesAndSlot,
} = require("./checkupDuration");
const logTag = "[RealtimeTools]";

const IST = "Asia/Kolkata";

/**
 * Bilingual user-facing copy for the voice agent (Hindi + Gujarati + English voice).
 * `message` stays English for logs / model fallback.
 * @param {string} [messageEnglish] preferred line for English-only callers (defaults to messageEn)
 */
function appointmentBilingualError(
  messageEn,
  messageHindi,
  messageGujarati,
  messageEnglish,
) {
  return {
    ok: false,
    message: messageEn,
    messageHindi,
    messageGujarati,
    messageEnglish:
      messageEnglish != null && messageEnglish !== ""
        ? messageEnglish
        : messageEn,
  };
}

function bookingPolicyReject(v) {
  return {
    ok: false,
    code: v.code,
    message: v.messages.en,
    messageHindi: v.messages.hi,
    messageGujarati: v.messages.gu,
    messageEnglish: v.messages.enVoice,
  };
}

/**
 * Slot-aware booking confirmation copy.
 * `slotHi/slotGu/slotEn` are the one-hour slot range labels from
 * `formatHourSlotLabelForVoice`. `othersPossible` becomes a soft note that
 * other patients may also be in the same slot — true only when this isn't the
 * only booking in that bucket.
 */
function buildBookingSuccessVoiceMessages(
  appointmentId,
  doctorName,
  slotHi,
  slotGu,
  slotEn,
  opts = {},
) {
  const othersPossible = Boolean(opts.othersPossible);
  const sharedNoteHi = othersPossible
    ? " इस स्लॉट में कुछ और मरीज़ भी हो सकते हैं, इसलिए कृपया थोड़ा पहले पहुँचिए।"
    : "";
  const sharedNoteGu = othersPossible
    ? " આ સ્લોટમાં બીજા દર્દીઓ પણ હોઈ શકે છે, એટલે કૃપા કરી થોડા વહેલા પહોંચજો."
    : "";
  const sharedNoteEn = othersPossible
    ? " A few other patients may also be in the same one-hour slot, so please try to arrive a little early."
    : "";

  if (opts.updated) {
    return {
      messageHindi: `ठीक है—मैंने आपकी अपॉइंटमेंट नंबर ${appointmentId} अपडेट कर दी है। डॉ. ${doctorName}, ${slotHi}।${sharedNoteHi} थोड़ी देर में WhatsApp पर अपडेट की जानकारी मिल जाएगी। अगर बाद में फिर से समय बदलवाना हो तो WhatsApp पर संपर्क करें।`,
      messageGujarati: `બરાબર—મેં તમારી મુલાકાત નંબર ${appointmentId} અપડેટ કરી દીધી છે. ડૉ. ${doctorName}, ${slotGu}.${sharedNoteGu} થોડી વારમાં WhatsApp પર નવી વિગત મળી જશે. અગર સમય બદલાવવો હોય તો WhatsApp પર સંપર્ક કરજો.`,
      messageEnglish: `Done — I've updated your appointment, reference number ${appointmentId}. Dr. ${doctorName}, ${slotEn}.${sharedNoteEn} You'll receive the updated details on WhatsApp shortly. To change the time later, message us on WhatsApp.`,
    };
  }
  return {
    messageHindi: `मैंने आपकी अपॉइंटमेंट बुक कर ली है। अपॉइंटमेंट नंबर: ${appointmentId}। डॉ. ${doctorName}, ${slotHi}।${sharedNoteHi} थोड़ी देर में WhatsApp पर पुष्टि आ जाएगी। अगर बाद में अपॉइंटमेंट का समय बदलवाना हो तो WhatsApp पर संपर्क करें।`,
    messageGujarati: `મેં તમારી મુલાકાત બુક કરી દીધી છે. રેફરન્સ નંબર ${appointmentId}. ડૉ. ${doctorName}, ${slotGu}.${sharedNoteGu} થોડી વારમાં WhatsApp પર વિગત મળી જશે. અગર મુલાકાતનો સમય બદલાવવો હોય તો WhatsApp પર સંપર્ક કરજો.`,
    messageEnglish: `Your appointment is booked. Reference number ${appointmentId}. Dr. ${doctorName}, ${slotEn}.${sharedNoteEn} A confirmation will reach you on WhatsApp shortly. To reschedule later, contact us on WhatsApp.`,
  };
}

const SLOT_HOUR_MINUTES = 60;
const IST_OFFSET = "+05:30";

/** Conversational 12-hour slot label, e.g. 15 → "3–4 PM" (never 24h). */
function shortHourSlotLabelEN(startHour) {
  const to12 = (h) => {
    const period = h % 24 < 12 ? "AM" : "PM";
    let hh = h % 12;
    if (hh === 0) hh = 12;
    return { hh, period };
  };
  const s = to12(startHour);
  const e = to12(startHour + 1);
  return s.period === e.period
    ? `${s.hh}–${e.hh} ${s.period}`
    : `${s.hh} ${s.period}–${e.hh} ${e.period}`;
}

/** YYYY-MM-DD that is `addDays` after `ymd`, in IST. */
function addDaysToYmdIST(ymd, addDays) {
  const startMs = new Date(`${ymd}T00:00:00.000${IST_OFFSET}`).getTime();
  return formatCalendarDateIST(new Date(startMs + addDays * 24 * 60 * 60 * 1000));
}

/** Long IST label for a day, e.g. "Monday, 23 June". */
function dayLabelIST(ymd) {
  const d = new Date(`${ymd}T12:00:00.000${IST_OFFSET}`);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

/**
 * Open future appointment slots for ONE doctor on ONE IST day:
 *   doctor working hours  −  past hour-buckets (vs server `now`)  −  full buckets.
 * Capacity is per-doctor (resolveHourBucketCapacity), matching create_appointment.
 * @returns {Promise<{ slots: { startHour:number, isoStart:string, labelEnglish:string }[], availabilityLabel:string }>}
 */
async function computeOpenSlotsForDay({
  hospitalObjectId,
  doctorObjectId,
  doctor,
  ymd,
  now,
}) {
  const win = parseDoctorAvailabilityWindow(doctor && doctor.availability);
  const capacity = resolveHourBucketCapacity(doctor);
  const counts = await loadHourBucketCounts(
    hospitalObjectId,
    doctorObjectId,
    ymd,
    null,
  );
  const todayYmd = formatCalendarDateIST(now);
  const slots = [];
  for (
    let bucket = 0;
    bucket < 24 * SLOT_HOUR_MINUTES;
    bucket += SLOT_HOUR_MINUTES
  ) {
    if (!isHourBucketWithinAvailability(bucket, win.ranges)) continue; // inside doctor hours
    if ((counts.get(bucket) || 0) >= capacity) continue; // not already full
    const startHour = bucket / SLOT_HOUR_MINUTES;
    const iso = `${ymd}T${String(startHour).padStart(2, "0")}:00:00${IST_OFFSET}`;
    const start = parseAppointmentDateTimeAsIST(iso);
    if (!start || Number.isNaN(start.getTime())) continue;
    // Future only: a slot that starts at or before "now" has already begun/passed,
    // so the earliest offerable slot today starts at the next full clock hour.
    if (ymd === todayYmd && start.getTime() <= now.getTime()) continue;
    slots.push({ startHour, isoStart: iso, labelEnglish: shortHourSlotLabelEN(startHour) });
  }
  return { slots, availabilityLabel: win.label };
}

/**
 * list_available_slots tool: returns the doctor's open future slots for a date.
 * If the requested date (default today) has none, auto-advances to the next
 * working day (skipping Sundays and the doctor's leave/holidays), up to 8 days.
 */
async function listAvailableSlots(hospitalObjectId, args, now = new Date()) {
  const rawId = String(args.doctorObjectId || "").trim();
  if (!mongoose.isValidObjectId(rawId)) {
    return {
      ok: false,
      code: "INVALID_DOCTOR_REF",
      message:
        "Need a valid doctorObjectId. Call list_doctors first and reuse the id from the chosen doctor's line.",
    };
  }
  const doctor = await DoctorModel.findOne({
    _id: rawId,
    hospital: hospitalObjectId,
  }).lean();
  if (!doctor) {
    return {
      ok: false,
      code: "DOCTOR_NOT_FOUND",
      message: "Doctor not found for this hospital. Use list_doctors to pick a valid doctor.",
    };
  }

  const todayYmd = formatCalendarDateIST(now);
  let baseYmd = String(args.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(baseYmd)) baseYmd = todayYmd;

  for (let i = 0; i < 8; i += 1) {
    const ymd = addDaysToYmdIST(baseYmd, i);
    const probe = new Date(`${ymd}T12:00:00.000${IST_OFFSET}`);
    if (isSundayIST(probe)) continue; // no Sunday bookings
    if (findHolidayCoveringYmdIST(doctor.holidays || [], ymd)) continue; // on leave
    const { slots, availabilityLabel } = await computeOpenSlotsForDay({
      hospitalObjectId,
      doctorObjectId: rawId,
      doctor,
      ymd,
      now,
    });
    if (slots.length > 0) {
      const movedToNextDay = ymd !== baseYmd;
      const list = slots.map((s) => s.labelEnglish).join(", ");
      const dayLabel = dayLabelIST(ymd);
      const messageEnglish = movedToNextDay
        ? `No slots remain for ${dayLabelIST(baseYmd)}. The next available day for Dr. ${doctor.fullName} is ${dayLabel}: ${list}. Offer these and confirm one.`
        : `Open slots for Dr. ${doctor.fullName} on ${dayLabel}: ${list}. Offer ONLY these and confirm one.`;
      return {
        ok: true,
        doctorName: doctor.fullName,
        availability: availabilityLabel,
        date: ymd,
        movedToNextDay,
        requestedDate: baseYmd,
        slots,
        message: messageEnglish,
        messageEnglish,
      };
    }
  }

  return {
    ok: true,
    doctorName: doctor.fullName,
    date: baseYmd,
    slots: [],
    noSlots: true,
    message: `No open slots for Dr. ${doctor.fullName} in the next several working days. Suggest contacting the hospital or trying another doctor.`,
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

/**
 * How many non-cancelled patients are sitting in this doctor's hour-slot
 * (including the just-booked appointment). Used to decide whether to warn
 * the caller that other patients are in the same slot.
 */
async function countPatientsInHourSlot(
  hospitalObjectId,
  doctorObjectId,
  dt,
) {
  const ymd = formatCalendarDateIST(dt);
  const counts = await loadHourBucketCounts(
    hospitalObjectId,
    doctorObjectId,
    ymd,
    null,
  );
  return counts.get(hourBucketStartMinIST(dt)) || 0;
}

/**
 * Trigger the WhatsApp confirmation for an appointment booked by the voice agent.
 * The API and Razorpay paths enqueue the same confirmation; the agent's
 * create_appointment tool previously did NOT, so agent-booked appointments never
 * received a WhatsApp confirmation.
 *
 * Routes through the reliable queue (retry + persistence; falls back to a direct
 * send if Redis is down). Non-blocking — never delays or fails the voice flow.
 * Hospital messaging permissions and WhatsApp creds are enforced downstream.
 * @param {string} appointmentMongoId
 * @param {'created'|'rescheduled'} kind
 * @param {string|null} [fallbackPhone] caller/session number — used only if the patient has no phone
 */
function triggerAgentAppointmentWhatsApp(appointmentMongoId, kind, fallbackPhone) {
  if (!appointmentMongoId) return;
  Promise.resolve()
    .then(() =>
      enqueueAppointmentConfirmation(appointmentMongoId, { kind, fallbackPhone }),
    )
    .catch((err) => {
      console.error(
        logTag,
        "[create_appointment] WhatsApp confirmation dispatch failed:",
        err && err.message ? err.message : err,
      );
    });
}

function buildCreateAppointmentSuccessResult({
  appointmentDoc,
  doctorName,
  slotHi,
  slotGu,
  slotEn,
  othersPossible,
  slotPatientCount,
  slotCapacity,
  messageEn,
  appointmentUpdated = false,
}) {
  const voice = buildBookingSuccessVoiceMessages(
    appointmentDoc.appointmentId,
    doctorName,
    slotHi,
    slotGu,
    slotEn,
    { updated: appointmentUpdated, othersPossible },
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
      slot: {
        labelEnglish: slotEn,
        labelHindi: slotHi,
        labelGujarati: slotGu,
        patientCount: typeof slotPatientCount === "number" ? slotPatientCount : null,
        capacity: typeof slotCapacity === "number" ? slotCapacity : null,
      },
    },
    message: messageEn,
    messageHindi: voice.messageHindi,
    messageGujarati: voice.messageGujarati,
    messageEnglish: voice.messageEnglish,
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

/**
 * Strip honorifics / language prefixes so a name from STT can match
 * a stored DoctorModel.fullName (which is typically just "Yugen Lee" etc).
 *
 * Examples normalised:
 *   "Dr. Yugen"    -> "yugen"
 *   "डॉ युगेन"     -> "युगेन"
 *   "ડૉ. યુગેન"    -> "યુગેન"
 *   "doctor yugen" -> "yugen"
 */
function normaliseDoctorName(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .replace(/^(?:dr\.?|doctor|डॉ\.?|डाँ\.?|डा\.?|ડૉ\.?|ડોકટર|ડોક્ટર)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Look up a doctor for the given hospital using a free-text name.
 * Tries exact match first, then case-insensitive contains. Returns null on miss.
 *
 * Keeps the LLM out of a verbal "I'm checking _id…" recovery loop when it
 * passed e.g. "Dr. Yugen" as doctorObjectId.
 */
async function resolveDoctorByName(hospitalObjectId, rawName) {
  const cleaned = normaliseDoctorName(rawName);
  if (!cleaned || cleaned.length < 2) return null;
  try {
    const exact = await DoctorModel.findOne({
      hospital: hospitalObjectId,
      fullName: new RegExp(`^${cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    })
      .select("_id fullName")
      .lean();
    if (exact && exact._id) return exact;
    const contains = await DoctorModel.findOne({
      hospital: hospitalObjectId,
      fullName: new RegExp(cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    })
      .select("_id fullName")
      .lean();
    if (contains && contains._id) return contains;
  } catch (err) {
    console.warn(
      logTag,
      "resolveDoctorByName lookup failed:",
      err && err.message ? err.message : err,
    );
  }
  return null;
}

/**
 * Same idea for patients — if patientObjectId looks like a name (or P-id),
 * pull a record so create_appointment can succeed without a verbal recovery turn.
 */
async function resolvePatientFallback(
  hospitalObjectId,
  patientObjectIdRaw,
  fullNameRaw,
  callerPhone10,
) {
  const pid = String(patientObjectIdRaw || "").trim();
  try {
    if (/^P-\d{4}-\d{4,}$/i.test(pid)) {
      const byPid = await PatientModel.findOne({
        hospital: hospitalObjectId,
        patientId: pid.toUpperCase(),
      })
        .select("_id fullName")
        .lean();
      if (byPid && byPid._id) return byPid;
    }
    const phone10 = String(callerPhone10 || "").replace(/\D/g, "").slice(-10);
    if (phone10 && phone10.length === 10) {
      const byPhone = await PatientModel.findOne({
        hospital: hospitalObjectId,
        $or: [
          { phoneNumber: phone10 },
          { phoneNumber: `0${phone10}` },
        ],
      })
        .sort({ createdAt: -1 })
        .select("_id fullName")
        .lean();
      if (byPhone && byPhone._id) return byPhone;
    }
    const cleanedName = String(fullNameRaw || "").trim();
    if (cleanedName && cleanedName.length >= 2) {
      const byName = await PatientModel.findOne({
        hospital: hospitalObjectId,
        fullName: new RegExp(
          cleanedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i",
        ),
      })
        .sort({ createdAt: -1 })
        .select("_id fullName")
        .lean();
      if (byName && byName._id) return byName;
    }
  } catch (err) {
    console.warn(
      logTag,
      "resolvePatientFallback lookup failed:",
      err && err.message ? err.message : err,
    );
  }
  return null;
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
        .select(
          "_id fullName doctorId designation availability status averagePatientTime",
        )
        .lean();
      const doctorsPayload = doctors.map((d) => ({
        _id: String(d._id),
        doctorId: d.doctorId || "",
        fullName: d.fullName,
        designation: d.designation,
        availability: d.availability,
        status: d.status,
        averagePatientTime: d.averagePatientTime,
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
        .select(
          "_id fullName doctorId designation availability status averagePatientTime",
        )
        .limit(limit)
        .lean();
      const doctorsPayload = doctors.map((d) => ({
        _id: String(d._id),
        doctorId: d.doctorId || "",
        fullName: d.fullName,
        designation: d.designation,
        availability: d.availability,
        status: d.status,
        averagePatientTime: d.averagePatientTime,
      }));
      return { ok: true, doctors: doctorsPayload };
    }

    if (name === "list_available_slots") {
      return await listAvailableSlots(hospitalObjectId, args || {});
    }

    if (name === "create_appointment") {
      let doctorObjectId = String(args.doctorObjectId || "").trim();
      let patientObjectId = String(args.patientObjectId || "").trim();
      const reason = String(args.reason || "").trim();
      const rawAppointmentDateTimeISO = String(
        args.appointmentDateTimeISO || args.appointmentDateTime || "",
      ).trim();
      const type = String(args.type || "call").trim() || "call";

      /**
       * If the LLM passed a doctor *name* (e.g. "Dr. Yugen") instead of the
       * Mongo ref, resolve it server-side. This avoids the verbal recovery
       * turn where the model previously said "_id" / "MongoDB" out loud.
       */
      if (!mongoose.isValidObjectId(doctorObjectId)) {
        const resolvedDoc = await resolveDoctorByName(
          hospitalObjectId,
          args.doctorObjectId,
        );
        if (resolvedDoc) {
          console.log(
            logTag,
            "[create_appointment] resolved doctor by name:",
            JSON.stringify({
              from: String(args.doctorObjectId || ""),
              to: String(resolvedDoc._id),
              fullName: resolvedDoc.fullName,
            }),
          );
          doctorObjectId = String(resolvedDoc._id);
        } else {
          return {
            ok: false,
            code: "INVALID_DOCTOR_REF",
            message:
              "Invalid doctorObjectId and could not resolve by name. Internally retry: silently call list_doctors, pick the doctor whose designation matches the visit reason, reuse that doctor's reference, then retry create_appointment. Do NOT say anything to the caller about IDs, tools, MongoDB, or internal process — just say a short wait line in the caller's language.",
            messageHindi: "",
            messageGujarati: "",
          };
        }
      }

      if (!mongoose.isValidObjectId(patientObjectId)) {
        const resolvedPatient = await resolvePatientFallback(
          hospitalObjectId,
          args.patientObjectId,
          args.fullName,
          options.callerPhone,
        );
        if (resolvedPatient) {
          console.log(
            logTag,
            "[create_appointment] resolved patient by fallback:",
            JSON.stringify({
              from: String(args.patientObjectId || ""),
              to: String(resolvedPatient._id),
              fullName: resolvedPatient.fullName,
            }),
          );
          patientObjectId = String(resolvedPatient._id);
        } else {
          return {
            ok: false,
            code: "INVALID_PATIENT_REF",
            message:
              "Invalid patientObjectId and no fallback patient found by phone, patientId, or name. Internally retry: if this is a new patient, call create_patient first (fullName, age, gender, English reason, phone) and reuse the response patient reference; for an existing patient, call fetch_patient_by_patientId or fetch_patient_by_phone first. Never use age, the human patientId (P-…), or a short number. Do NOT mention IDs, tools, MongoDB, JSON, or any internal process to the caller.",
            messageHindi: "",
            messageGujarati: "",
          };
        }
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
      const dtRaw = parseAppointmentDateTimeAsIST(appointmentDateTimeISO);
      if (Number.isNaN(dtRaw.getTime())) {
        return appointmentBilingualError(
          "Invalid appointmentDateTimeISO.",
          "माफ़ कीजिए—तारीख या समय साफ़ नहीं लग रहा। कृपया अपॉइंटमेंट की तारीख और समय एक बार फिर बता दीजिए।",
          "માફ કરશો—તારીખ કે સમય સાફ નથી લાગતો. મુલાકાતની સાચી તારીખ અને વખત ફરી જણાવશો?",
        );
      }

      /**
       * Booking is slot-based: each clock hour is one "slot" holding up to
       * doctor-specific hour-slot capacity. Snap the caller's exact minute to
       * the start of that slot so 10:30, 10:45, 10:59 all land in the 10–11
       * slot and the stored data, the count, and what the agent says aloud
       * are consistent.
       */
      const dt = snapToHourBucketStartIST(dtRaw);

      const quickReject = rejectIfSundayOrPast(dt);
      if (quickReject) {
        return bookingPolicyReject(quickReject);
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

        const policyUpdate = await validateDoctorBookingPoliciesAndSlot({
          hospitalObjectId,
          doctorObjectId: String(doctorObjectId),
          doctor,
          dt,
          excludeAppointmentMongoId: existingAppointmentObjectId,
        });
        if (policyUpdate) {
          return bookingPolicyReject(policyUpdate);
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
        const {
          hindi: slotHiU,
          gujarati: slotGuU,
          english: slotEnU,
        } = formatHourSlotLabelForVoice(dt);
        const slotCountU = await countPatientsInHourSlot(
          hospitalObjectId,
          String(doctorObjectId),
          dt,
        );
        const slotCapacityU = resolveHourBucketCapacity(doctor);

        console.log(
          logTag,
          "[create_appointment] UPDATED OK",
          JSON.stringify({
            appointmentId: updatedDoc.appointmentId,
            appointmentMongoId: String(updatedDoc._id),
            slot: slotEnU,
            slotPatientCount: slotCountU,
            slotCapacity: slotCapacityU,
            durationMs: Date.now() - startedAt,
          }),
        );

        // Reschedule confirmed → resend the updated details on WhatsApp.
        triggerAgentAppointmentWhatsApp(
          String(updatedDoc._id),
          "rescheduled",
          effectiveSessionPhone10(options),
        );

        return buildCreateAppointmentSuccessResult({
          appointmentDoc: updatedDoc,
          doctorName: doctorNameU,
          slotHi: slotHiU,
          slotGu: slotGuU,
          slotEn: slotEnU,
          othersPossible: slotCountU > 1,
          slotPatientCount: slotCountU,
          slotCapacity: slotCapacityU,
          messageEn:
            "Appointment updated. Do NOT speak — the runtime delivers the English confirmation. Stay silent.",
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
      const {
        hindi: slotHi,
        gujarati: slotGu,
        english: slotEn,
      } = formatHourSlotLabelForVoice(dt);
      const slotCapacity = resolveHourBucketCapacity(doctor);

      // Return existing appointment if this is a duplicate call (same slot).
      if (existingAppt) {
        const slotCountDup = await countPatientsInHourSlot(
          hospitalObjectId,
          String(doctorObjectId),
          dt,
        );
        console.log(
          logTag,
          "[create_appointment] DUPLICATE SKIPPED — returning existing",
          JSON.stringify({
            appointmentId: existingAppt.appointmentId,
            slot: slotEn,
            slotPatientCount: slotCountDup,
            slotCapacity,
            durationMs: Date.now() - startedAt,
          }),
        );
        return buildCreateAppointmentSuccessResult({
          appointmentDoc: existingAppt,
          doctorName,
          slotHi,
          slotGu,
          slotEn,
          othersPossible: slotCountDup > 1,
          slotPatientCount: slotCountDup,
          slotCapacity,
          messageEn:
            "Already booked. Speak messageHindi, messageGujarati, or messageEnglish once as booking status.",
        });
      }

      const policyNew = await validateDoctorBookingPoliciesAndSlot({
        hospitalObjectId,
        doctorObjectId: String(doctorObjectId),
        doctor,
        dt,
        excludeAppointmentMongoId: null,
      });
      if (policyNew) {
        return bookingPolicyReject(policyNew);
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

      const slotCountNew = await countPatientsInHourSlot(
        hospitalObjectId,
        String(doctorObjectId),
        dt,
      );
      console.log(
        logTag,
        "[create_appointment] BOOKED OK",
        JSON.stringify({
          appointmentId: appointment.appointmentId,
          appointmentMongoId: String(appointment._id),
          slot: slotEn,
          slotPatientCount: slotCountNew,
          slotCapacity,
          durationMs: Date.now() - startedAt,
        }),
      );
      // Send the WhatsApp appointment confirmation for this agent booking.
      // Fall back to the caller's session number if the patient record has no phone.
      triggerAgentAppointmentWhatsApp(
        String(appointment._id),
        "created",
        effectiveSessionPhone10(options),
      );
      return buildCreateAppointmentSuccessResult({
        appointmentDoc: appointment,
        doctorName,
        slotHi,
        slotGu,
        slotEn,
        othersPossible: slotCountNew > 1,
        slotPatientCount: slotCountNew,
        slotCapacity,
        messageEn:
          "Booked. Do NOT speak — the runtime delivers the English confirmation. Stay silent.",
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
