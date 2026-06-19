const Doctor = require("../../src/models/doctor.model");
const Hospital = require("../../src/models/hospital.model");
const Prescription = require("../../src/models/prescription.model");
const env = require("../../src/config/env");
const { getResolvedHospitalMessagingSettings } = require("../../src/utils/hospitalMessagingSettings");
const { getPatientsByPhone } = require("../services/hospitalBackend");
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
const { findHolidayCoveringYmd } = require("../../src/utils/doctorHoliday");
const { createAppointment } = require("../services/hospitalBackend");
const { clearDosageCompletionState } = require("../services/contextService");

const STEPS = {
  FOLLOWUP_CHOICE: "FOLLOWUP_CHOICE",
  IN_PERSON_DATE: "IN_PERSON_DATE",
  IN_PERSON_TIME: "IN_PERSON_TIME",
};

const FULLY_RECOVERED_RE = /^\s*fully\s+recovered\s*$/i;
const NOT_YET_RE = /^\s*not\s+yet\s*$/i;
const TELE_RE = /tele[-\s]?consult(ation)?|tele\s*caller/i;
const IN_PERSON_RE = /in[-\s]?person|in\s*person\s*visit|clinic\s*visit|hospital\s*visit/i;

function isDosageCompletionPending(ctx) {
  return ctx?.activeFlow === "dosage_completion" && ctx?.dosageCompletion?.prescriptionId;
}

function isDosageFollowUpActive(ctx) {
  return ctx?.activeFlow === "dosage_followup" && ctx?.dosageFollowup?.prescriptionId;
}

/**
 * @param {string} text
 * @param {string} [buttonId]
 * @param {object} ctx
 * @returns {'fully_recovered'|'not_yet'|null}
 */
function detectDosageCompletionButtonReply(text, buttonId, ctx) {
  if (!isDosageCompletionPending(ctx)) return null;
  const t = String(text || "").trim();
  const id = String(buttonId || "").trim().toLowerCase();

  if (FULLY_RECOVERED_RE.test(t) || id.includes("fully_recovered") || id === "fully recovered") {
    return "fully_recovered";
  }
  if (NOT_YET_RE.test(t) || id.includes("not_yet") || id === "not yet") {
    return "not_yet";
  }
  return null;
}

async function markPrescriptionDosageFlowComplete(prescriptionId) {
  if (!prescriptionId) return;
  await Prescription.findOneAndUpdate(
    { _id: prescriptionId, status: { $ne: "Cancelled" } },
    {
      $set: {
        status: "Completed",
        reminderFeedbackCompletedAt: new Date(),
      },
    },
  );
}

async function buildReviewReply(hospitalId, patientName, doctorName) {
  const hospital = await Hospital.findById(hospitalId)
    .select("name reviewUrls url")
    .lean();
  const hospitalName = hospital?.name?.trim() || "our hospital";
  const name = patientName?.trim() || "there";
  const doctor = doctorName?.trim() || "your doctor";

  const urls = Array.isArray(hospital?.reviewUrls)
    ? hospital.reviewUrls.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  const fallback = String(hospital?.url || "").trim();
  const link = urls[0] || fallback;

  const lines = [
    `Thank you for the update, *${name}*.`,
    "",
    `We are glad to hear you are feeling fully recovered. *${doctor}* will be pleased to know.`,
    "",
  ];

  if (link) {
    lines.push(
      "Your feedback helps us improve care for every patient. Please share a valuable review when you have a moment:",
      link,
    );
  } else {
    lines.push(
      "Your feedback helps us improve care for every patient. Please contact our reception if you would like to share a review.",
    );
  }

  lines.push("", `— ${hospitalName} Care Team`);
  return lines.join("\n");
}

function buildNotYetFollowUpInteractive(patientName, doctorName, hospitalName) {
  const name = patientName?.trim() || "there";
  const doctor = doctorName?.trim() || "your doctor";
  const facility = hospitalName?.trim() || "Hospital";

  const body = [
    `Thank you for the update, *${name}*.`,
    "",
    `Based on your treatment plan, a follow-up consultation with *${doctor}* is recommended.`,
    "",
    "Please select your preferred consultation method below.",
    "",
    `— ${facility} Care Team`,
  ].join("\n");

  return {
    reply: body,
    interactive: {
      body,
      buttons: [
        { id: "dosage_tele", title: "Tele-Consultation" },
        { id: "dosage_in_person", title: "In-Person Visit" },
      ],
    },
  };
}

function withPatientIdAtEnd(baseUrl, patientId) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const pid = encodeURIComponent(String(patientId || "").trim());
  if (!base || !pid) return base;
  return `${base}/${pid}`;
}

async function buildTeleConsultationReply(hospitalId, patientMongoId) {
  const resolved = await getResolvedHospitalMessagingSettings(hospitalId);
  if (!resolved.teleCaller?.isEnabled) {
    return {
      reply:
        "Tele-consultation is not available at this hospital right now.\n\nPlease contact reception, or choose *In-Person Visit* if you still need a follow-up.",
    };
  }
  const telecallerLink = String(env.TELECALLER_BOOKING_LINK || "").trim();
  if (!telecallerLink) {
    return {
      reply:
        "Tele-consultation booking is temporarily unavailable.\n\nPlease contact reception for assistance.",
      endFlow: true,
    };
  }
  const finalLink = withPatientIdAtEnd(telecallerLink, patientMongoId);
  return {
    reply: [
      "Thank you for choosing *Tele-Consultation*.",
      "",
      "Please use the link below to schedule your follow-up with our tele-caller team:",
      finalLink,
      "",
      "If you need help, our care team is here for you.",
    ].join("\n"),
    endFlow: true,
  };
}

function preferredDatePrompt() {
  const y = new Date().getFullYear();
  return `*Follow-up visit — date*\n\nWhich day would you like to visit? Example: *5 April* (year defaults to *${y}* if omitted).`;
}

async function startInPersonFollowUp(ctx, dosageData) {
  const doctorId = dosageData.doctorId;
  if (!doctorId) {
    return {
      reply:
        "We could not find the doctor linked to your prescription.\n\nPlease contact reception to book an in-person follow-up.",
      endFlow: true,
    };
  }

  const doc = await Doctor.findById(doctorId).select("availability fullName").lean();
  const win = parseDoctorAvailabilityWindow(doc?.availability);

  ctx.activeFlow = "dosage_followup";
  ctx.dosageFollowup = {
    step: STEPS.IN_PERSON_DATE,
    mode: "in_person",
    prescriptionId: dosageData.prescriptionId,
    patientId: dosageData.patientId,
    doctorId,
    doctorName: dosageData.doctorName,
    hospitalName: dosageData.hospitalName,
    disease: "Follow-up consultation",
    doctorAvailabilityLabel: win.label,
    doctorAvailabilityRanges: win.ranges,
  };

  return { reply: preferredDatePrompt() };
}

async function handleDosageCompletionMessage(ctx, text, phone, hospitalId, buttonId) {
  const kind = detectDosageCompletionButtonReply(text, buttonId, ctx);
  if (!kind) return null;

  const data = ctx.dosageCompletion || {};

  if (kind === "fully_recovered") {
    const reply = await buildReviewReply(hospitalId, data.patientName, data.doctorName);
    await markPrescriptionDosageFlowComplete(data.prescriptionId);
    clearDosageCompletionState(phone);
    return { reply, endFlow: true };
  }

  ctx.activeFlow = "dosage_followup";
  ctx.dosageFollowup = {
    step: STEPS.FOLLOWUP_CHOICE,
    prescriptionId: data.prescriptionId,
    patientId: data.patientId,
    patientName: data.patientName,
    doctorId: data.doctorId,
    doctorName: data.doctorName,
    hospitalName: data.hospitalName,
  };

  return buildNotYetFollowUpInteractive(data.patientName, data.doctorName, data.hospitalName);
}

async function handleDosageFollowUpMessage(ctx, text, phone, hospitalId, buttonId) {
  const st = ctx.dosageFollowup;
  if (!st?.prescriptionId) return null;

  const t = String(text || "").trim();
  const id = String(buttonId || "").trim().toLowerCase();

  if (st.step === STEPS.FOLLOWUP_CHOICE) {
    if (TELE_RE.test(t) || id === "dosage_tele" || id.includes("tele")) {
      const patientId =
        st.patientId ||
        (await getPatientsByPhone(phone, hospitalId))[0]?._id?.toString();
      const result = await buildTeleConsultationReply(hospitalId, patientId);
      await markPrescriptionDosageFlowComplete(st.prescriptionId);
      clearDosageCompletionState(phone);
      return result;
    }
    if (IN_PERSON_RE.test(t) || id === "dosage_in_person" || id.includes("in_person")) {
      return startInPersonFollowUp(ctx, st);
    }
    return buildNotYetFollowUpInteractive(st.patientName, st.doctorName, st.hospitalName);
  }

  if (st.step === STEPS.IN_PERSON_DATE) {
    const now = new Date();
    const parsedDate = parseFlexibleDate(t, now);
    if (!parsedDate) {
      return {
        reply: `We could not read that date. Example: *10 May* or *${now.getFullYear()}-05-10*.`,
      };
    }
    st.dateYmd = toYyyyMmDd(parsedDate.y, parsedDate.m0, parsedDate.d);
    st.dateLabel = parsedDate.display;

    const docForHoliday = await Doctor.findById(st.doctorId)
      .select("holidays fullName")
      .lean();
    const holidayBlock = findHolidayCoveringYmd(docForHoliday?.holidays || [], st.dateYmd);
    if (holidayBlock) {
      const name = docForHoliday?.fullName?.trim() || "This doctor";
      return {
        reply: `Sorry — *${name}* is not available on *${parsedDate.display}* (leave through *${holidayBlock.endLabel}*).\n\nPlease choose another date after *${holidayBlock.endLabel}*.`,
      };
    }

    st.step = STEPS.IN_PERSON_TIME;
    const hoursLabel = st.doctorAvailabilityLabel || "9 AM - 5 PM";
    return {
      reply: `*Follow-up visit — time*\n\n*Date:* ${parsedDate.display}\n\n*Doctor availability:* ${hoursLabel}\n\nPlease send your preferred time. Example: *11:30 AM*.`,
    };
  }

  if (st.step === STEPS.IN_PERSON_TIME) {
    const now = new Date();
    const parsedTime = parseFlexibleTime(t, now);
    if (!parsedTime) {
      return { reply: "We could not read that time. Example: *10:30 AM*." };
    }
    const spec = {
      ranges:
        st.doctorAvailabilityRanges ||
        parseDoctorAvailabilityWindow(st.doctorAvailabilityLabel).ranges,
    };
    if (!isTimeWithinDoctorAvailability(parsedTime.h, parsedTime.min, spec)) {
      const hoursLabel = st.doctorAvailabilityLabel || "9 AM - 5 PM";
      return {
        reply: `That time is outside the doctor's usual hours (${hoursLabel}).\n\nPlease send a time within those hours.`,
      };
    }

    let patientId = st.patientId;
    if (!patientId) {
      const patients = await getPatientsByPhone(phone, hospitalId);
      patientId = patients[0]?._id != null ? String(patients[0]._id) : null;
    }
    if (!patientId) {
      return {
        reply:
          "We could not find your patient profile on this number.\n\nPlease contact reception to complete your booking.",
        endFlow: true,
      };
    }

    try {
      await createAppointment({
        patientId,
        disease: st.disease || "Follow-up consultation",
        doctor: st.doctorId,
        date: st.dateYmd,
        time: to24hClock(parsedTime.h, parsedTime.min),
        phone,
        hospitalId,
      });
    } catch (e) {
      return {
        reply: `We could not complete your booking.\n\n*Details:* ${e.message}\n\nPlease try again or contact reception.`,
      };
    }

    await markPrescriptionDosageFlowComplete(st.prescriptionId);
    clearDosageCompletionState(phone);
    return {
      reply: [
        "Your *in-person follow-up* appointment has been confirmed.",
        "",
        `*Date:* ${st.dateLabel}`,
        `*Time:* ${parsedTime.display}`,
        "",
        "Thank you — we look forward to seeing you. If you need to change the time later, message us here on WhatsApp.",
      ].join("\n"),
      endFlow: true,
    };
  }

  return null;
}

module.exports = {
  isDosageCompletionPending,
  isDosageFollowUpActive,
  detectDosageCompletionButtonReply,
  handleDosageCompletionMessage,
  handleDosageFollowUpMessage,
};
