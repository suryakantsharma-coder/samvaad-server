const {
  getPatientsByPhone,
  getRescheduleOptionsByPatientId,
  rescheduleAppointment,
} = require("../services/hospitalBackend");
const {
  parseFlexibleDate,
  parseFlexibleTime,
  toYyyyMmDd,
  to24hClock,
  combineToAppointmentDate,
} = require("../utils/appointmentDateTime");
const { FLOW_EXIT_HINT } = require("../utils/flowHints");

const STEPS = {
  PICK_PATIENT: "PICK_PATIENT",
  PICK_APPOINTMENT: "PICK_APPOINTMENT",
  ASK_NEW_DATE: "ASK_NEW_DATE",
  ASK_NEW_TIME: "ASK_NEW_TIME",
};

function formatPatientLine(p, i) {
  const name = p.fullName?.trim() || "Patient";
  const pid = p.patientId || "—";
  return `${i}) *${name}* (${pid})`;
}

function parseLetterOrNumber(text, count) {
  const t = String(text || "").trim();
  const upper = t.toUpperCase();
  const letter = upper.match(/^([A-Z])$/);
  if (letter) {
    const idx = letter[1].charCodeAt(0) - 65;
    if (idx >= 0 && idx < count) return idx;
  }
  const num = parseInt(t, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= count) return num - 1;
  return -1;
}

function formatDateTimeIST(d) {
  try {
    return new Date(d).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return String(d || "—");
  }
}

function formatAppointmentLine(a, i) {
  const when = formatDateTimeIST(a.appointmentDateTime);
  return `${i}) *${when}*`;
}

async function startRescheduleFlow(ctx, phone, hospitalId) {
  const patients = await getPatientsByPhone(phone, hospitalId);
  if (!patients.length) {
    return {
      reply:
        "No patient profile is linked to this WhatsApp number.\n\nPlease contact reception to update your phone number.",
      endFlow: true,
    };
  }

  ctx.activeFlow = "reschedule";
  ctx.reschedule = {
    step: STEPS.PICK_PATIENT,
    patients,
  };

  const lines = patients.map((p, i) => formatPatientLine(p, i + 1)).join("\n");
  return {
    reply:
      `*Reschedule appointment — Step 1*\n\n${FLOW_EXIT_HINT}\n\nChoose a patient profile:\n\n${lines}\n\nReply with a number (or letter).`,
  };
}

async function handleRescheduleMessage(ctx, text, phone, hospitalId) {
  const st = ctx.reschedule;
  if (!st || !st.patients?.length) {
    return startRescheduleFlow(ctx, phone, hospitalId);
  }

  if (st.step === STEPS.PICK_PATIENT) {
    const idx = parseLetterOrNumber(text, st.patients.length);
    if (idx < 0) {
      return { reply: "Please reply with a valid patient number from the list." };
    }
    const patient = st.patients[idx];
    const opts = await getRescheduleOptionsByPatientId(
      String(patient._id),
      hospitalId,
      new Date(),
    );

    if (!opts.eligible.length) {
      if (opts.within24h.length) {
        return {
          reply:
            "Your appointment is within the next 24 hours. Please contact the hospital receptionist to reschedule.",
          endFlow: true,
        };
      }
      return {
        reply: "No upcoming appointments available for rescheduling.",
        endFlow: true,
      };
    }

    st.selectedPatientId = String(patient._id);
    st.appointments = opts.eligible;
    st.step = STEPS.PICK_APPOINTMENT;

    const lines = opts.eligible
      .map((a, i) => formatAppointmentLine(a, i + 1))
      .join("\n");
    return {
      reply:
        `*Step 2 — Select appointment*\n\nBelow are your eligible upcoming appointments. Please select the one you wish to reschedule or update.\n\n${lines}\n\nReply with a number (or letter).`,
    };
  }

  if (st.step === STEPS.PICK_APPOINTMENT) {
    const list = st.appointments || [];
    const idx = parseLetterOrNumber(text, list.length);
    if (idx < 0) {
      return { reply: "Please reply with a valid appointment number." };
    }
    const chosen = list[idx];
    st.selectedAppointmentId = String(chosen._id);
    st.step = STEPS.ASK_NEW_DATE;
    return {
      reply:
        "*Step 3 — New date*\n\nPlease enter the new appointment date. Example: *10 May* or *2026-05-10*.",
    };
  }

  if (st.step === STEPS.ASK_NEW_DATE) {
    const parsedDate = parseFlexibleDate(text, new Date());
    if (!parsedDate) {
      return {
        reply:
          "We could not read that date. Please send a valid date, e.g. *10 May*.",
      };
    }
    st.newDateYmd = toYyyyMmDd(parsedDate.y, parsedDate.m0, parsedDate.d);
    st.newDateLabel = parsedDate.display;
    st.step = STEPS.ASK_NEW_TIME;
    return {
      reply:
        `*Step 4 — New time*\n\nDate selected: *${parsedDate.display}*\n\nPlease enter a new time. Example: *3:00 PM*.`,
    };
  }

  if (st.step === STEPS.ASK_NEW_TIME) {
    const parsedTime = parseFlexibleTime(text, new Date());
    if (!parsedTime) {
      return { reply: "We could not read that time. Example: *3:00 PM*." };
    }

    let nextDateTime;
    try {
      nextDateTime = combineToAppointmentDate(st.newDateYmd, to24hClock(parsedTime.h, parsedTime.min), new Date());
    } catch {
      return {
        reply:
          "Could not read the new date/time. Please try again with a clear date and time.",
      };
    }
    if (nextDateTime.getTime() <= Date.now()) {
      return { reply: "The new appointment time must be in the future." };
    }

    try {
      await rescheduleAppointment({
        appointmentId: st.selectedAppointmentId,
        patientId: st.selectedPatientId,
        hospitalId,
        newDateTime: nextDateTime,
      });
    } catch (err) {
      return {
        reply:
          `We could not reschedule this appointment.\n\n*Details:* ${err.message}\n\nPlease choose another date/time or contact the hospital.`,
      };
    }

    return {
      reply: "Your appointment has been successfully rescheduled.",
      endFlow: true,
    };
  }

  return startRescheduleFlow(ctx, phone, hospitalId);
}

module.exports = {
  startRescheduleFlow,
  handleRescheduleMessage,
};
