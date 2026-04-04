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
  return `*Preferred date*\n\nYou can reply in any of these ways:\n• *Day only* — e.g. *15* (we use the current month and *${y}*; if that day has already passed this month, we move to the next month)\n• *Day + month name* — e.g. *5 April*, *April 5*, *20 Dec*\n• *Numeric date* — e.g. *15/04/${y}* or *${y}-04-15*\n\nIf you do not mention a year, we assume *${y}*.`;
}

function dateParseErrorReply() {
  const y = new Date().getFullYear();
  return `We could not read that date.\n\nTry one of these:\n• *25* (day only)\n• *10 May* or *May 10*\n• *${y}-05-10* or *10/05/${y}*\n\nYear defaults to *${y}* when omitted.`;
}

function timeParseErrorReply() {
  return `We could not read that time.\n\nExamples that work:\n• *10:30 AM* or *2:45 pm*\n• *14:30* (24-hour)\n• *930* or *1430* (hours and minutes, no colon)`;
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
  const age = p.age != null ? p.age : "—";
  const gender = p.gender || "—";
  return `${indexNum}. *${name}* — Age ${age}, ${gender} — Patient ID ${pid}`;
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
    (c) => c.label.toLowerCase().includes(t.toLowerCase()) && t.length >= 3
  );
  return byName || null;
}

async function doctorsReply(st, doctors) {
  st.doctorChoices = mapDoctorsForChoice(doctors);
  st.step = STEPS.SHOW_DOCTORS;
  const n = doctors.length;
  const lines = doctors.map(
    (d, i) => `${i + 1}. *${d.fullName}* — ${d.designation}`
  );
  const lastLetter = String.fromCharCode(64 + n);
  return {
    reply: `*Suggested doctors*\n\nBased on the reason you gave, here are suitable options — including *relevant specialists* and *general physicians* where helpful:\n\n${lines.join(
      "\n"
    )}\n\nPlease reply with a *number* (1–${n})${n <= 26 ? ` or a *letter* (A–${lastLetter})` : ""} to confirm your choice.`,
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
        reply: `Thank you. To register a *new patient*, please send the following in a single message:

• *Full name*
• *Age*
• *Gender*
• *Reason for visit* (symptoms or concern)

*Example:*
Name: John Doe
Age: 30
Gender: Male
Problem: Fever and headache`,
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
          reply: `We found your profile for *${disp}*.\n\nIn one short message, please describe your *reason for this visit* or your main *symptoms*.`,
        };
      }
      st.existingPatients = patients;
      st.step = STEPS.PICK_EXISTING_PATIENT;
      const labels = patients.map((p, i) => formatExistingPatientLine(p, i + 1));
      const n = patients.length;
      const letterHint =
        n <= 26
          ? `Reply with a *number* (1–${n}) or a *letter* (A–${String.fromCharCode(64 + n)}).`
          : `Reply with a *number* from *1* to *${n}*.`;
      return {
        reply: `*Existing patients on this number*\n\nMore than one profile uses this WhatsApp number. Who is this appointment for?\n\n${labels.join(
          "\n",
        )}\n\n${letterHint}`,
      };
    }

    return {
      reply:
        "*Appointment booking*\n\nIs this visit for a *new patient* or an *existing patient* who is already registered with us?\n\nPlease reply *new* or *existing*.",
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
      reply: `Thank you, *${disp}*.\n\nIn one short message, please describe your *reason for this visit* or your main *symptoms*.`,
    };
  }

  if (st.step === STEPS.COLLECT_NEW_DETAILS) {
    const details = await extractNewPatientDetails(t);
    if (!details || !details.name || !details.age) {
      return {
        reply:
          "We could not read all the required details. Please send them again using this format:\n\nName: …\nAge: …\nGender: …\nProblem: …",
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
    return {
      reply: `*Date saved:* ${parsedDate.display}\n\n*Preferred time*\n\nReply with a time, for example *10:30 AM*, *2 pm*, *14:30*, or *915* for 9:15 AM.`,
    };
  }

  if (st.step === STEPS.ASK_TIME) {
    const now = new Date();
    const parsedTime = parseFlexibleTime(t, now);
    if (!parsedTime) {
      return { reply: timeParseErrorReply() };
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
      "*Appointment booking*\n\nIs this for a *new* or *existing* patient?\n\nPlease reply *new* or *existing*.",
  };
}

function startAppointmentFlow(ctx) {
  ctx.activeFlow = "appointment";
  ctx.appointment = { step: STEPS.ASK_PATIENT_TYPE };
  return {
    reply:
      "*Appointment booking*\n\nIs this visit for a *new patient* or an *existing patient* who is already registered?\n\nPlease reply *new* or *existing*.",
  };
}

module.exports = {
  handleAppointmentMessage,
  startAppointmentFlow,
};
