const mongoose = require("mongoose");
const Patient = require("../../src/models/patient.model");
const Doctor = require("../../src/models/doctor.model");
const Appointment = require("../../src/models/appointment.model");
const Prescription = require("../../src/models/prescription.model");
const {
  notifyAppointmentBooked,
} = require("../../src/services/appointmentWhatsAppNotify");
const {
  combineToAppointmentDate,
} = require("../utils/appointmentDateTime");

function phoneSearchVariants(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const out = new Set();
  if (raw) out.add(String(raw).trim());
  if (digits) {
    out.add(digits);
    if (digits.length >= 10) out.add(digits.slice(-10));
    if (digits.length === 11 && digits.startsWith("0")) {
      out.add(digits.slice(1));
    }
    if (digits.length === 12 && digits.startsWith("91")) {
      out.add(digits.slice(2));
    }
    if (digits.length === 13 && digits.startsWith("091")) {
      out.add(digits.slice(3));
    }
  }
  return [...out];
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toObjectId(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

/**
 * Resolve registered patient by WhatsApp / saved phone (hospital-scoped).
 * @param {string} phone
 * @param {string} hospitalId
 */
async function getUserByPhone(phone, hospitalId) {
  const hid = toObjectId(hospitalId);
  const variants = phoneSearchVariants(phone);
  if (!variants.length || !hid) return null;

  return Patient.findOne({
    hospital: hid,
    phoneNumber: { $in: variants },
  }).lean();
}

const MAX_APPOINTMENT_DOCTOR_SUGGESTIONS = 10;

/** General / family / internal medicine — offered alongside specialists when a symptom rule matches */
const GENERAL_PHYSICIAN_RE =
  /\b(general\s*physician|general\s*medicine|family\s*medicine|internal\s*medicine|consultant\s*physician|g\.?\s*p\.?\b|primary\s*care)\b/i;

/**
 * Symptom / problem → designation regexes (Mongo). When a rule matches, we suggest those specialists
 * plus up to 2 general physicians (e.g. heart → cardiologists + GPs).
 */
const APPOINTMENT_SPECIALTY_RULES = [
  {
    keywords:
      /\b(heart|cardiac|cardio|chest\s*pain|angina|palpitation|tachycardia|bp\b|blood\s*pressure|hypertension|cholesterol)\b/i,
    designationRes: [/\bcardi/i, /\bheart\b/i],
  },
  {
    keywords: /\b(skin|rash|acne|eczema|dermat|psoriasis|hives|itch)\b/i,
    designationRes: [/\bdermat/i],
  },
  {
    keywords:
      /\b(bone|joint|fracture|ortho|knee|back\s*pain|spine|arthritis|sprain)\b/i,
    designationRes: [/\bortho/i],
  },
  {
    keywords:
      /\b(headache|migraine|neuro|seizure|stroke|paralysis|numbness|brain)\b/i,
    designationRes: [/\bneuro/i],
  },
  {
    keywords:
      /\b(child|baby|infant|pediatric|paediatric|toddler|newborn)\b/i,
    designationRes: [/\bpaed/i, /\bpediat/i],
  },
  {
    keywords: /\b(eye|vision|sight|ophthal|cataract|retina|glaucoma)\b/i,
    designationRes: [/\bophthal/i],
  },
  {
    keywords: /\b(ear|nose|throat|ent\b|hearing|tonsil|sinus)\b/i,
    designationRes: [/\bent\b/i, /\botolaryng/i],
  },
  {
    keywords:
      /\b(stomach|gastric|abdomen|liver|digest|gastro|nausea|vomit|constipation|diarrhoea|diarrhea|ibs)\b/i,
    designationRes: [/\bgastro/i, /\bhepat/i],
  },
  {
    keywords: /\b(diabetes|sugar|thyroid|endocrine|hormone|insulin)\b/i,
    designationRes: [/\bendocrin/i, /\bdiabet/i],
  },
  {
    keywords:
      /\b(lung|breath|asthma|respiratory|pulmon|copd|bronch|wheez)\b/i,
    designationRes: [/\bpulmon/i, /\brespir/i],
  },
  {
    keywords: /\b(kidney|renal|urine|urolog|prostate|bladder)\b/i,
    designationRes: [/\burolog/i, /\bnephro/i, /\brenal/i],
  },
  {
    keywords:
      /\b(gynae|gynec|obstet|pregnancy|pregnant|ovulation|period\s*pain)\b/i,
    designationRes: [/\bgyn/i, /\bobstet/i],
  },
];

function addUniqueDoctors(bucket, doctors, seenIds, maxLen) {
  for (const d of doctors) {
    if (bucket.length >= maxLen) break;
    const id = String(d._id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    bucket.push(d);
  }
}

/**
 * Match doctors for appointment: maps common problems to specialties, adds general physicians,
 * then fills with keyword search on designation / name.
 * @param {string} disease
 * @param {string} hospitalId
 */
async function getDoctorsByDisease(disease, hospitalId) {
  const hid = toObjectId(hospitalId);
  const q = String(disease || "").trim();
  if (!hid || !q) return [];

  const seen = new Set();
  const bucket = [];

  const matchedRules = APPOINTMENT_SPECIALTY_RULES.filter((r) =>
    r.keywords.test(q),
  );

  if (matchedRules.length) {
    const patternKey = new Set();
    const orConditions = [];
    for (const rule of matchedRules) {
      for (const re of rule.designationRes) {
        const key = `${re.source}|${re.flags || ""}`;
        if (patternKey.has(key)) continue;
        patternKey.add(key);
        orConditions.push({
          designation: { $regex: re.source, $options: "i" },
        });
      }
    }

    if (orConditions.length) {
      const specialists = await Doctor.find({
        hospital: hid,
        status: "On Duty",
        $or: orConditions,
      })
        .sort({ utilization: 1 })
        .limit(6)
        .lean();
      addUniqueDoctors(
        bucket,
        specialists,
        seen,
        MAX_APPOINTMENT_DOCTOR_SUGGESTIONS,
      );
    }

    const generals = await Doctor.find({
      hospital: hid,
      status: "On Duty",
      designation: { $regex: GENERAL_PHYSICIAN_RE.source, $options: "i" },
    })
      .sort({ utilization: 1 })
      .limit(2)
      .lean();
    addUniqueDoctors(
      bucket,
      generals,
      seen,
      MAX_APPOINTMENT_DOCTOR_SUGGESTIONS,
    );
  }

  if (bucket.length < 4) {
    const escaped = escapeRegex(q);
    const regex = { $regex: escaped, $options: "i" };
    const more = await Doctor.find({
      hospital: hid,
      status: "On Duty",
      $or: [{ designation: regex }, { fullName: regex }, { availability: regex }],
    })
      .sort({ utilization: 1 })
      .limit(25)
      .lean();
    addUniqueDoctors(
      bucket,
      more,
      seen,
      MAX_APPOINTMENT_DOCTOR_SUGGESTIONS,
    );
  }

  if (!bucket.length) {
    const onDuty = await Doctor.find({ hospital: hid, status: "On Duty" })
      .sort({ utilization: 1 })
      .limit(25)
      .lean();
    addUniqueDoctors(
      bucket,
      onDuty,
      seen,
      MAX_APPOINTMENT_DOCTOR_SUGGESTIONS,
    );
  }

  if (!bucket.length) {
    return Doctor.find({ hospital: hid })
      .sort({ utilization: 1 })
      .limit(15)
      .lean();
  }

  return bucket.slice(0, MAX_APPOINTMENT_DOCTOR_SUGGESTIONS);
}

async function generatePatientId() {
  const year = new Date().getFullYear();
  const prefix = `P-${year}-`;
  const last = await Patient.findOne({ patientId: new RegExp(`^${prefix}`) })
    .sort({ patientId: -1 })
    .select("patientId")
    .lean();
  const nextNum = last
    ? parseInt(last.patientId.slice(prefix.length), 10) + 1
    : 1;
  const suffix = String(nextNum).padStart(6, "0");
  return `${prefix}${suffix}`;
}

async function generateAppointmentId() {
  const year = new Date().getFullYear();
  const prefix = `A-${year}-`;
  const last = await Appointment.findOne({
    appointmentId: new RegExp(`^${prefix}`),
  })
    .sort({ appointmentId: -1 })
    .select("appointmentId")
    .lean();
  const nextNum = last
    ? parseInt(last.appointmentId.slice(prefix.length), 10) + 1
    : 1;
  const suffix = String(nextNum).padStart(6, "0");
  return `${prefix}${suffix}`;
}

function normalizeGender(g) {
  const s = String(g || "")
    .trim()
    .toLowerCase();
  if (["m", "male", "man"].includes(s)) return "Male";
  if (["f", "female", "woman"].includes(s)) return "Female";
  return "Other";
}

function parseAppointmentDateTime(dateInput, timeInput, now = new Date()) {
  const d = String(dateInput || "").trim();
  const t = String(timeInput || "").trim();
  if (!d || !t) throw new Error("Date and time are required");

  try {
    return combineToAppointmentDate(d, t, now);
  } catch {
    const combined = new Date(`${d} ${t}`);
    if (Number.isNaN(combined.getTime())) {
      const alt = new Date(`${d}T${t}`);
      if (Number.isNaN(alt.getTime()))
        throw new Error(
          "Could not read date/time. Please use a clear date and time.",
        );
      return alt;
    }
    return combined;
  }
}

/**
 * All patients at this hospital whose saved phone matches WhatsApp variants (same number, multiple records possible).
 * @param {string} phone
 * @param {string} hospitalId
 */
async function getPatientsByPhone(phone, hospitalId) {
  const hid = toObjectId(hospitalId);
  const variants = phoneSearchVariants(phone);
  if (!variants.length || !hid) return [];

  const patients = await Patient.find({
    hospital: hid,
    phoneNumber: { $in: variants },
  })
    .sort({ fullName: 1, createdAt: -1 })
    .lean();

  if (!patients.length) return [];

  const ids = patients.map((p) => p._id);
  const counts = await Prescription.aggregate([
    { $match: { patient: { $in: ids } } },
    { $group: { _id: "$patient", c: { $sum: 1 } } },
  ]);
  const countByPatient = new Map(counts.map((row) => [String(row._id), row.c]));

  return patients.map((p) => ({
    ...p,
    rxCount: countByPatient.get(String(p._id)) || 0,
  }));
}

/**
 * Milliseconds for sorting — newest first. Prefers updatedAt, then createdAt, appointmentDate, then ObjectId time.
 * @param {object} rx
 */
function getPrescriptionLatestMillis(rx) {
  const tryTime = (v) => {
    if (v == null) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const u = tryTime(rx.updatedAt);
  if (u != null) return u;
  const c = tryTime(rx.createdAt);
  if (c != null) return c;
  const ap = tryTime(rx.appointmentDate);
  if (ap != null) return ap;
  try {
    const id = rx._id;
    if (id && typeof id.getTimestamp === "function") {
      return id.getTimestamp().getTime();
    }
    const oid = toObjectId(id);
    if (oid) return oid.getTimestamp().getTime();
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * Latest prescriptions for a patient Mongo _id (patient must belong to hospital).
 * Returns the *n* most recent by time (not an arbitrary subset of the query batch).
 * @param {string} patientMongoId
 * @param {string} hospitalId
 * @param {number} n
 */
async function getLastPrescriptionsByPatientId(
  patientMongoId,
  hospitalId,
  n = 4,
) {
  const hid = toObjectId(hospitalId);
  const pid = toObjectId(patientMongoId);
  if (!hid || !pid) return [];

  const patient = await Patient.findOne({ _id: pid, hospital: hid }).lean();
  if (!patient) return [];

  const limit = Math.min(Math.max(1, n), 10);
  /** Fetch extra rows so dedupe + resort still yields the true latest `limit` */
  const fetchCap = Math.min(Math.max(limit * 15, 40), 200);

  async function loadRx(filter) {
    return Prescription.find(filter)
      .populate("patient", "fullName patientId phoneNumber age gender")
      .populate(
        "appointment",
        "appointmentId reason appointmentDateTime status",
      )
      .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
      .limit(fetchCap)
      .lean();
  }

  /** 1) Exact patient ref (normal case) */
  let list = await loadRx({ patient: patient._id });

  /**
   * 2) Duplicate patient rows: same WhatsApp phone + same full name, different Mongo _id.
   * Prescriptions may still point at an older sibling document.
   */
  if (!list.length && patient.fullName?.trim()) {
    const variants = phoneSearchVariants(patient.phoneNumber || "");
    if (variants.length) {
      const nameRe = new RegExp(
        `^${escapeRegex(patient.fullName.trim())}$`,
        "i",
      );
      const siblings = await Patient.find({
        hospital: hid,
        phoneNumber: { $in: variants },
        fullName: nameRe,
      })
        .select("_id")
        .lean();
      const siblingIds = siblings.map((s) => s._id);
      if (siblingIds.length) {
        list = await loadRx({ patient: { $in: siblingIds } });
      }
    }
  }

  /**
   * 3) Prescription stores display name but patient ref was wrong / migrated.
   */
  if (!list.length && patient.fullName?.trim()) {
    const nameRe = new RegExp(`^${escapeRegex(patient.fullName.trim())}$`, "i");
    list = await loadRx({
      patientName: nameRe,
      $or: [{ hospital: hid }, { hospital: null }],
    });
  }

  const seen = new Set();
  const deduped = [];
  for (const rx of list) {
    const id = String(rx._id);
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(rx);
  }

  deduped.sort((a, b) => {
    const tb = getPrescriptionLatestMillis(b);
    const ta = getPrescriptionLatestMillis(a);
    if (tb !== ta) return tb - ta;
    return String(b._id).localeCompare(String(a._id));
  });

  return deduped.slice(0, limit);
}

/**
 * Create patient (if needed) and appointment; mirrors POST /api/appointments behaviour.
 * @param {object} params
 * @param {string} [params.patientId] - existing Patient _id
 * @param {string} [params.name]
 * @param {number} [params.age]
 * @param {string} [params.gender]
 * @param {string} params.disease - reason
 * @param {string} params.doctor - Doctor _id
 * @param {string} params.date
 * @param {string} params.time
 * @param {string} params.phone - stored on new patient
 * @param {string} params.hospitalId
 */
async function createAppointment(params) {
  const {
    patientId: existingPatientId,
    name,
    age,
    gender,
    disease,
    doctor: doctorId,
    date,
    time,
    phone,
    hospitalId,
  } = params;

  const hid = toObjectId(hospitalId);
  const docId = toObjectId(doctorId);
  if (!hid || !docId) throw new Error("Invalid hospital or doctor");

  const doctor = await Doctor.findById(docId).lean();
  if (!doctor) throw new Error("Doctor not found");

  let patient = null;
  if (existingPatientId) {
    const pid = toObjectId(existingPatientId);
    patient = pid
      ? await Patient.findOne({ _id: pid, hospital: hid }).lean()
      : null;
    if (!patient) throw new Error("Patient not found");
  } else {
    const fullName = String(name || "").trim();
    const ageNum = parseInt(String(age), 10);
    if (!fullName || !ageNum || ageNum < 0)
      throw new Error("Valid name and age are required");
    const patientIdStr = await generatePatientId();
    const phoneNumber =
      String(phone || "").trim() || phoneSearchVariants(phone)[0];
    patient = await Patient.create({
      fullName,
      phoneNumber,
      age: ageNum,
      gender: normalizeGender(gender),
      reason: String(disease || "").trim() || "Consultation",
      patientId: patientIdStr,
      hospital: hid,
    });
    patient = patient.toObject();
  }

  const appointmentDateTime = parseAppointmentDateTime(date, time, new Date());
  const appointmentId = await generateAppointmentId();
  const appointment = await Appointment.create({
    patient: patient._id,
    doctor: docId,
    reason: String(disease || "").trim() || "Consultation",
    appointmentDateTime,
    status: "Upcoming",
    type: "hospital",
    appointmentId,
    hospital: hid,
  });

  const populated = await Appointment.findById(appointment._id)
    .populate("doctor", "fullName doctorId designation")
    .populate("patient", "fullName patientId phoneNumber age gender")
    .populate("hospital", "name phoneCountryCode")
    .lean();

  notifyAppointmentBooked(populated).catch((err) =>
    console.error("[whatsapp-chat-agent] appointment notify:", err.message),
  );

  return populated;
}

module.exports = {
  getUserByPhone,
  getPatientsByPhone,
  getDoctorsByDisease,
  getLastPrescriptionsByPatientId,
  createAppointment,
  phoneSearchVariants,
};
