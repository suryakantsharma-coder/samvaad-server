const Hospital = require("../../src/models/hospital.model");
const env = require("../../src/config/env");
const { getPatientsByPhone } = require("../services/hospitalBackend");
const { startAppointmentFlow } = require("./appointmentFlow");
const { FLOW_EXIT_HINT } = require("../utils/flowHints");

const STEPS = {
  MENU: "MENU",
  PICK_TELECALLER_PATIENT: "PICK_TELECALLER_PATIENT",
};

function parseChoice(text, count) {
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

function buildFirstNameFromPatients(patients) {
  const full = String(patients?.[0]?.fullName || "").trim();
  const first = full.split(/\s+/)[0] || "";
  return first || "there";
}

function followUpIntroReply() {
  return (
    "We hope you are doing well and feeling better after completing your prescribed medicine course. " +
    "Your health and recovery are very important to us, and we would love to know how you are feeling now.\n\n" +
    "If you require any further assistance, follow-up consultation, or would like to share your experience, " +
    "please feel free to choose one of the options below. Our team is always here to support you.\n\n" +
    "Wishing you continued good health and a smooth recovery."
  );
}

function followUpButtons() {
  return [
    { id: "tele_caller", title: "Tele-caller" },
    { id: "book_appointment", title: "Book Appointment" },
    { id: "give_review", title: "Give Review" },
  ];
}

async function startFollowUpFlow(ctx, phone, hospitalId) {
  const patients = await getPatientsByPhone(phone, hospitalId);
  buildFirstNameFromPatients(patients);
  ctx.activeFlow = "followup";
  ctx.followup = { step: STEPS.MENU };
  return {
    reply: `${followUpIntroReply()}\n\n${FLOW_EXIT_HINT}`,
    interactive: {
      body: followUpIntroReply(),
      buttons: followUpButtons(),
    },
  };
}

function formatPatientLine(p, i) {
  const name = p.fullName?.trim() || "Patient";
  const pid = p.patientId || "—";
  return `${i}) *${name}* (${pid})`;
}

function withPatientIdAtEnd(baseUrl, patientId) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const pid = encodeURIComponent(String(patientId || "").trim());
  if (!base || !pid) return base;
  return `${base}/${pid}`;
}

async function handleTelecallerSelection(ctx, phone, hospitalId) {
  const patients = await getPatientsByPhone(phone, hospitalId);
  if (!patients.length) {
    return {
      reply:
        "We could not find any registered patient linked to this WhatsApp number.\n\nPlease contact reception for assistance.",
      endFlow: true,
    };
  }
  ctx.followup = {
    step: STEPS.PICK_TELECALLER_PATIENT,
    patients,
  };
  const lines = patients.map((p, i) => formatPatientLine(p, i + 1)).join("\n");
  return {
    reply:
      `Please select the patient for tele-caller service.\n\n${lines}\n\nReply with a number (or letter).`,
  };
}

async function handleGiveReview(hospitalId) {
  const hospital = await Hospital.findById(hospitalId)
    .select("name reviewUrls url")
    .lean();
  const urls = Array.isArray(hospital?.reviewUrls)
    ? hospital.reviewUrls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  const fallback = String(hospital?.url || "").trim();
  if (urls.length === 0 && !fallback) {
    const hospitalName = hospital?.name?.trim() || "the hospital";
    return {
      reply:
        `Thank you for your willingness to share feedback.\n\nThe review link is currently unavailable. Please contact *${hospitalName}* reception for support.`,
      endFlow: true,
    };
  }
  const lines =
    urls.length > 0
      ? urls.map((u, i) => `${i + 1}. ${u}`).join("\n")
      : fallback;
  return {
    reply:
      urls.length > 1
        ? `We’d love your feedback! Please share your experience:\n${lines}`
        : `We’d love your feedback! Please share your experience here:\n${urls[0] || fallback}`,
    endFlow: true,
  };
}

async function handleFollowUpMessage(ctx, text, phone, hospitalId) {
  const st = ctx.followup || { step: STEPS.MENU };
  const t = String(text || "").trim();
  const lower = t.toLowerCase();

  if (st.step === STEPS.PICK_TELECALLER_PATIENT) {
    const idx = parseChoice(t, st.patients?.length || 0);
    if (idx < 0) {
      return { reply: "Please reply with a valid patient number from the list." };
    }
    const chosen = st.patients[idx];
    const telecallerLink = String(env.TELECALLER_BOOKING_LINK || "").trim();
    if (!telecallerLink) {
      return {
        reply:
          "Tele-caller booking is currently unavailable. Please contact reception for assistance.",
        endFlow: true,
      };
    }
    // URL segment must be MongoDB ObjectId (for /api/tele-caller/patients/:id), not display patientId (P-YYYY-…).
    const patientCode =
      chosen?._id != null ? String(chosen._id) : String(chosen?.patientId || "").trim();
    const finalLink = withPatientIdAtEnd(telecallerLink, patientCode);
    return {
      reply:
        `You can proceed with the tele-caller booking by clicking the link below:\n${finalLink}`,
      endFlow: true,
    };
  }

  if (/tele[-\s]?caller/i.test(lower)) {
    return handleTelecallerSelection(ctx, phone, hospitalId);
  }
  if (/book\s+appointment/i.test(lower)) {
    return startAppointmentFlow(ctx);
  }
  if (/give\s+review|\breview\b/i.test(lower)) {
    return handleGiveReview(hospitalId);
  }

  const patients = await getPatientsByPhone(phone, hospitalId);
  buildFirstNameFromPatients(patients);
  return {
    reply:
      `${followUpIntroReply()}\n\nPlease choose one option below.`,
    interactive: {
      body: followUpIntroReply(),
      buttons: followUpButtons(),
    },
  };
}

module.exports = {
  startFollowUpFlow,
  handleFollowUpMessage,
};
