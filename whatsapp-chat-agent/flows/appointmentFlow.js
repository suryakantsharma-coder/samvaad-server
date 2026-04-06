const Doctor = require("../../src/models/doctor.model");
const {
  getPatientsByPhone,
  getDoctorsByDisease,
  createAppointment,
} = require("../services/hospitalBackend");
const { extractNewPatientDetails } = require("../services/aiService");
const {
  parseFlexibleDate,
  parseFlexibleTime,
  toYyyyMmDd,
  to24hClock,
} = require("../utils/appointmentDateTime");
const {
  parseDoctorAvailabilityWindow,
  isTimeWithinDoctorAvailability,
} = require("../utils/doctorAvailability");

const STEPS = {
  ASK_PATIENT_TYPE: "ASK_PATIENT_TYPE",
  PICK_EXISTING_PATIENT: "PICK_EXISTING_PATIENT",
  COLLECT_NEW_DETAILS: "COLLECT_NEW_DETAILS",
  ASK_EXISTING_REASON: "ASK_EXISTING_REASON",
  SHOW_DOCTORS: "SHOW_DOCTORS",
  ASK_DATE: "ASK_DATE",
  ASK_TIME: "ASK_TIME",
};

function ensureState(ctx) {
  if (!ctx.appointment || typeof ctx.appointment !== "object") {
    ctx.appointment = { step: STEPS.ASK_PATIENT_TYPE };
  }
  return ctx.appointment;
}

function preferredDatePrompt() {
  const y = new Date().getFullYear();
  return `*Step 4 — Date*\n\nWhich day do you want? Example: *5 April* (year defaults to *${y}* if you skip it).`;
}

function dateParseErrorReply() {
  const y = new Date().getFullYear();
  return `We could not read that date. Example: *10 May* or *${y}-05-10*.`;
}

function timeParseErrorReply() {
  return `We could not read that time. Example: *10:30 AM*.`;
}

function mapDoctorsForChoice(doctors) {
  return doctors.map((d) => ({
    id: String(d._id),
    label: `${d.fullName} (${d.designation})`,
  }));
}

function parsePatientPickIndex(text, count) {
  const trimmed = String(text || "").trim();
  const upper = trimmed.toUpperCase();
  const letter = upper.match(/^([A-Z])$/);
  if (letter) {
    const idx = letter[1].charCodeAt(0) - 65;
    if (idx >= 0 && idx < count) return idx;
  }
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= count) return num - 1;
  return -1;
}

function formatExistingPatientLine(p, indexNum) {
  const name = p.fullName?.trim() || "Patient";
  const pid = p.patientId || "—";
  return `${indexNum}) *${name}* (${pid})`;
}

function parseDoctorChoice(text, choices) {
  const t = String(text || "").trim();
  const upper = t.toUpperCase();
  const letter = upper.match(/^([A-Z])$/);
  if (letter) {
    const idx = letter[1].charCodeAt(0) - 65;
    if (idx >= 0 && idx < choices.length) return choices[idx];
  }
  const num = parseInt(t, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= choices.length) {
    return choices[num - 1];
  }
  const byName = choices.find(
    (c) => c.label.toLowerCase().includes(t.toLowerCase()) && t.length >= 3,
  );
  return byName || null;
}

async function doctorsReply(st, doctors) {
  st.doctorChoices = mapDoctorsForChoice(doctors);
  st.step = STEPS.SHOW_DOCTORS;
  const n = doctors.length;
  const lines = doctors.map(
    (d, i) => `${i + 1}. *${d.fullName}* — ${d.designation}`,
  );
  const lastLetter = String.fromCharCode(64 + n);
  return {
    reply: `*Step 3 — Choose a doctor*\n\nBased on your reason, here are suitable options:\n\n${lines.join(
      "\n",
    )}\n\nReply with a *number* (1–${n})${n <= 26 ? ` or a *letter* (A–${lastLetter})` : ""}.`,
  };
}

/**
 * @param {object} ctx - full context from contextService
 * @param {string} text - user message
 * @param {string} phoneDisplay - raw WhatsApp phone / digits for storage
 * @param {string} hospitalId
 */
async function handleAppointmentMessage(ctx, text, phoneDisplay, hospitalId) {
  const st = ensureState(ctx);
  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (st.step === STEPS.ASK_PATIENT_TYPE) {
    if (/^new\b|^n$/i.test(lower) || /new patient|first time/i.test(lower)) {
      st.patientType = "new";
      st.step = STEPS.COLLECT_NEW_DETAILS;
      return {
        reply: `*Step 2 — New patient details*\n\nReply in *one message* with your full name, age, gender, and reason for visit.\n\nExample: *Name: John Doe, Age: 30, Gender: Male, Problem: Fever*`,
      };
    }

    if (/^existing\b|old patient|returning|already registered/i.test(lower)) {
      st.patientType = "existing";
      const patients = await getPatientsByPhone(phoneDisplay, hospitalId);
      if (!patients.length) {
        return {
          reply:
            "We could not find an existing patient record linked to this WhatsApp number.\n\nIf you are new to our hospital, please reply *new* to continue as a new patient.",
        };
      }
      if (patients.length === 1) {
        const only = patients[0];
        st.patientId = String(only._id);
        st.disease = "";
        st.step = STEPS.ASK_EXISTING_REASON;
        const disp = only.fullName?.trim() || "Patient";
        return {
          reply: `*Step 2 — Reason for visit*\n\nWe found your profile for *${disp}*.\n\nIn one short message, describe why you are coming in (symptoms or concern). Example: *Follow-up for diabetes*`,
        };
      }
      st.existingPatients = patients;
      st.step = STEPS.PICK_EXISTING_PATIENT;
      const labels = patients.map((p, i) =>
        formatExistingPatientLine(p, i + 1),
      );
      const n = patients.length;
      const letterHint =
        n <= 26
          ? `Reply with a *number* (1–${n}) or a *letter* (A–${String.fromCharCode(64 + n)}).`
          : `Reply with a *number* from *1* to *${n}*.`;
      return {
        reply: `*Step 2 — Who is the visit for?*\n\nMore than one profile uses this number. Choose one:\n\n${labels.join(
          "\n\n",
        )}\n\n${letterHint}`,
      };
    }

    return {
      reply:
        "*Appointment booking — Step 1*\n\nIs this for a *new patient* or an *existing patient* who is already registered?\n\nReply *new* or *existing*.",
    };
  }

  if (st.step === STEPS.PICK_EXISTING_PATIENT) {
    const patients = st.existingPatients || [];
    if (!patients.length) {
      st.step = STEPS.ASK_PATIENT_TYPE;
      return {
        reply:
          "*Appointment booking*\n\nIs this visit for a *new patient* or an *existing patient*?\n\nPlease reply *new* or *existing*.",
      };
    }
    const idx = parsePatientPickIndex(t, patients.length);
    if (idx < 0) {
      const len = patients.length;
      const hint =
        len <= 26
          ? `Please reply with a *number* (1–${len}) or a *letter* (A–${String.fromCharCode(64 + len)}).`
          : `Please reply with a *number* from *1* to *${len}*.`;
      return { reply: hint };
    }
    const chosen = patients[idx];
    st.patientId = String(chosen._id);
    delete st.existingPatients;
    st.disease = "";
    st.step = STEPS.ASK_EXISTING_REASON;
    const disp = chosen.fullName?.trim() || "Patient";
    return {
      reply: `*Step 2 — Reason for visit*\n\nThank you, *${disp}*.\n\nIn one short message, describe why you are coming in. Example: *Chest pain*`,
    };
  }

  if (st.step === STEPS.COLLECT_NEW_DETAILS) {
    const details = await extractNewPatientDetails(t);
    if (!details || !details.name || !details.age) {
      return {
        reply:
          "We could not read those details. Please send one message again. Example: *Name: John Doe, Age: 30, Gender: Male, Problem: Fever*",
      };
    }
    st.name = details.name;
    st.age = details.age;
    st.gender = details.gender;
    st.disease = details.disease || "Consultation";
    const doctors = await getDoctorsByDisease(st.disease, hospitalId);
    if (!doctors.length) {
      return {
        reply:
          "We could not match a suitable doctor to the information provided.\n\nPlease try describing your concern differently, or contact *reception* for assistance.",
        endFlow: true,
      };
    }
    return doctorsReply(st, doctors);
  }

  if (st.step === STEPS.ASK_EXISTING_REASON) {
    st.disease = t || "Consultation";
    const doctors = await getDoctorsByDisease(st.disease, hospitalId);
    if (!doctors.length) {
      return {
        reply:
          "We could not match a suitable doctor to your symptoms.\n\nPlease rephrase your symptoms briefly, or contact *reception* for help choosing a doctor.",
        endFlow: true,
      };
    }
    return doctorsReply(st, doctors);
  }

  if (st.step === STEPS.SHOW_DOCTORS) {
    const choice = parseDoctorChoice(t, st.doctorChoices || []);
    if (!choice) {
      return {
        reply:
          "That selection was not recognized.\n\nPlease reply with a *number* (1, 2, 3, …) or a *letter* (A, B, C, …) from the list above.",
      };
    }
    st.selectedDoctorId = choice.id;
    const doc = await Doctor.findById(choice.id).select("availability").lean();
    const win = parseDoctorAvailabilityWindow(doc?.availability);
    st.doctorAvailabilityLabel = win.label;
    st.doctorAvailabilityRanges = win.ranges;
    st.step = STEPS.ASK_DATE;
    return { reply: preferredDatePrompt() };
  }

  if (st.step === STEPS.ASK_DATE) {
    const now = new Date();
    const parsedDate = parseFlexibleDate(t, now);
    if (!parsedDate) {
      return { reply: dateParseErrorReply() };
    }
    st.dateYmd = toYyyyMmDd(parsedDate.y, parsedDate.m0, parsedDate.d);
    st.dateLabel = parsedDate.display;
    st.step = STEPS.ASK_TIME;
    const hoursLabel = st.doctorAvailabilityLabel || "9 AM - 5 PM";
    return {
      reply: `*Step 5 — Time*\n\n*Date:* ${parsedDate.display}\n\nThis doctor is normally available during:\n${hoursLabel}\n\nPick a time in one of those windows. Example: *1:00 PM*.`,
    };
  }

  if (st.step === STEPS.ASK_TIME) {
    const now = new Date();
    const parsedTime = parseFlexibleTime(t, now);
    if (!parsedTime) {
      return { reply: timeParseErrorReply() };
    }
    const spec = {
      ranges:
        st.doctorAvailabilityRanges ||
        parseDoctorAvailabilityWindow(st.doctorAvailabilityLabel).ranges,
    };
    if (!isTimeWithinDoctorAvailability(parsedTime.h, parsedTime.min, spec)) {
      const hoursLabel =
        st.doctorAvailabilityLabel ||
        "9 AM - 5 PM";
      return {
        reply: `*Doctor not available*\n\nThat time is outside this doctor’s usual hours:\n${hoursLabel}\n\nPlease send a time within those hours. Example: *10:30 AM*.`,
      };
    }
    st.time24 = to24hClock(parsedTime.h, parsedTime.min);
    st.timeLabel = parsedTime.display;
    try {
      const payload = {
        disease: st.disease,
        doctor: st.selectedDoctorId,
        date: st.dateYmd,
        time: st.time24,
        phone: phoneDisplay,
        hospitalId,
      };
      if (st.patientType === "existing") {
        payload.patientId = st.patientId;
      } else {
        payload.name = st.name;
        payload.age = st.age;
        payload.gender = st.gender;
      }
      await createAppointment(payload);
    } catch (e) {
      return {
        reply: `We could not complete your booking.\n\n*Details:* ${e.message}\n\nPlease try again, or call the hospital if you need help.`,
      };
    }
    return {
      reply: `Your appointment has been *confirmed* for *${st.dateLabel}* at *${st.timeLabel}*.\n\nThank you — we look forward to seeing you. To change or cancel, please contact the hospital.`,
      endFlow: true,
    };
  }

  return {
    reply:
      "*Appointment booking — Step 1*\n\nIs this for a *new* or *existing* patient?\n\nReply *new* or *existing*.",
  };
}

/**
 * Only clear “yes I’m new/existing” replies — not long messages that also mention booking.
 * Used so the first booking message always shows Step 1.
 */
function isDirectPatientTypeAnswer(text) {
  const compact = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!compact || compact.length > 42) return false;
  if (
    compact === "n" ||
    compact === "e" ||
    compact === "new" ||
    compact === "existing"
  ) {
    return true;
  }
  if (compact === "new patient" || compact === "existing patient") {
    return true;
  }
  return false;
}

function startAppointmentFlow(ctx) {
  ctx.activeFlow = "appointment";
  ctx.appointment = { step: STEPS.ASK_PATIENT_TYPE };
  return {
    reply:
      "*Appointment booking — Step 1*\n\nWe’ll go *step by step*.\n\nIs this visit for a *new patient* or an *existing patient* who is already registered?\n\nReply *new* or *existing*.",
  };
}

module.exports = {
  handleAppointmentMessage,
  startAppointmentFlow,
  isDirectPatientTypeAnswer,
};
