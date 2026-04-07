const {
  getPatientsByPhone,
  getLastPrescriptionsByPatientId,
} = require("../services/hospitalBackend");
const {
  prescriptionViewUrl,
  hasPrescriptionPortalLink,
} = require("../utils/prescriptionPortalUrl");
const { FLOW_EXIT_HINT } = require("../utils/flowHints");

const STEPS = {
  PICK_PATIENT: "PICK_PATIENT",
};

const SEP = "─────────────────";

/** User asks for links again (outside completed flow, messageProcessor may restart flow) */
function wantsFullDetailsOrLinks(text) {
  return /\b(full\s*details?|all\s*(the\s*)?(prescription|rx)s?|give\s+me\s+(the\s*)?(full\s*)?details?|official\s*(website|site|link|portal)|view\s+(online|on\s*(the\s*)?(website|site))|show\s+(me\s*)?all|every(thing)?|all\s+links?|prescription\s*links?)\b/i.test(
    String(text || "").trim(),
  );
}

/** One profile line: number, name, ID in brackets only */
function formatPatientLine(p, indexLabel) {
  const name = p.fullName?.trim() || "Patient";
  const pid = p.patientId || "—";
  return `${indexLabel}) *${name}* (${pid})`;
}

/**
 * Links only — no medicine names (privacy + portal is source of truth).
 */
function buildPrescriptionLinksReply(patientName, patientCode, rxList) {
  const name = patientName?.trim() || "patient";
  const code = patientCode || "";

  const urls = rxList
    .map((rx) => {
      const prescriptionObjectId = rx?._id != null ? String(rx._id) : "";
      return prescriptionObjectId ? prescriptionViewUrl(prescriptionObjectId) : null;
    })
    .filter(Boolean);

  if (!hasPrescriptionPortalLink() || !urls.length) {
    const hint =
      "Secure prescription links are not available in this chat at the moment.\n\nPlease contact *reception* or your care team for a copy of your records.";
    const who =
      code.length > 0 ? `*${name}* (${code})` : `*${name}*`;
    const body = [
      "*Prescriptions*",
      "",
      "*Status:* Links not enabled",
      "",
      "*Patient*",
      who,
      "",
      SEP,
      "",
      hint,
    ].join("\n");
    return { reply: body, endFlow: true };
  }

  const who =
    code.length > 0 ? `*${name}* (${code})` : `*${name}*`;

  const linkBlocks = rxList.map((rx, i) => {
    const prescriptionObjectId = rx?._id != null ? String(rx._id) : "";
    const u = prescriptionObjectId ? prescriptionViewUrl(prescriptionObjectId) : null;
    if (!u) return null;
    return `*Prescription ${i + 1} of ${rxList.length}*\n${u}`;
  }).filter(Boolean);

  const body = [
    "*Prescriptions*",
    "",
    "*Patient*",
    who,
    "",
    `*Your prescription links*`,
    `_Newest first · ${urls.length} shown_`,
    "",
    SEP,
    "",
    linkBlocks.join("\n\n"),
    "",
    SEP,
    "",
    "_Tap a link to open in your browser._",
    "",
    code.length > 0
      ? `_Each link uses that prescription’s database ID in the URL (the long id at the end — not your patient ID ${code})._`
      : `_Each link uses that prescription’s database ID in the URL, not a patient ID code._`,
  ].join("\n");

  return { reply: body, endFlow: true };
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

async function startPrescriptionFlow(ctx, phone, hospitalId) {
  const patients = await getPatientsByPhone(phone, hospitalId);
  if (!patients.length) {
    return {
      reply: [
        "*Prescriptions*",
        "",
        "*No profile found*",
        "",
        "This WhatsApp number is not linked to a patient record at our hospital.",
        "",
        SEP,
        "",
        "Please contact *reception* to register.",
        "",
        "_Or reply *appointment* to book a visit._",
      ].join("\n"),
      endFlow: true,
    };
  }

  ctx.activeFlow = "prescription";
  ctx.prescription = {
    step: STEPS.PICK_PATIENT,
    patients,
  };

  const labels = patients.map((p, i) => formatPatientLine(p, i + 1));
  const letters = patients.map((_, i) => String.fromCharCode(65 + i));
  const n = patients.length;
  const letterHint =
    n <= 26
      ? `_Reply with a number (1–${n}) or a letter (${letters[0]}–${letters[n - 1]})._`
      : `_Reply with a number from 1 to ${n}._`;

  const body = [
    "*Prescriptions*",
    "",
    FLOW_EXIT_HINT,
    "",
    "*Choose your profile*",
    "",
    `We found *${n}* record(s) on this number.`,
    "",
    SEP,
    "",
    ...labels.flatMap((line) => [line, ""]),
    SEP,
    "",
    letterHint,
  ].join("\n");

  return { reply: body };
}

async function handlePrescriptionMessage(ctx, text, phone, hospitalId) {
  const st = ctx.prescription;
  if (!st || !st.patients?.length) {
    return startPrescriptionFlow(ctx, phone, hospitalId);
  }

  if (st.step === STEPS.PICK_PATIENT) {
    const idx = parseLetterOrNumber(text, st.patients.length);
    if (idx < 0) {
      const len = st.patients.length;
      const hint =
        len <= 26
          ? `Please reply with a *number* (1–${len}) or a *letter* (A–${String.fromCharCode(64 + len)}).`
          : `Please reply with a *number* from *1* to *${len}*.`;
      return { reply: hint };
    }

    const chosen = st.patients[idx];
    const patientId = String(chosen._id);
    const selectedPatientName = chosen.fullName?.trim() || "Patient";
    const selectedPatientCode = chosen.patientId || "";

    const rxList = await getLastPrescriptionsByPatientId(
      patientId,
      hospitalId,
      4,
    );

    const who =
      selectedPatientCode.length > 0
        ? `*${selectedPatientName}* (${selectedPatientCode})`
        : `*${selectedPatientName}*`;

    if (!rxList.length) {
      return {
        reply: [
          "*Prescriptions*",
          "",
          "*No records*",
          "",
          who,
          "",
          SEP,
          "",
          "We have no prescription records on file for this profile.",
          "",
          "_If this seems wrong, please contact *reception*._",
        ].join("\n"),
        endFlow: true,
      };
    }

    return buildPrescriptionLinksReply(
      selectedPatientName,
      selectedPatientCode,
      rxList,
    );
  }

  return startPrescriptionFlow(ctx, phone, hospitalId);
}

module.exports = {
  startPrescriptionFlow,
  handlePrescriptionMessage,
  wantsFullDetailsOrLinks,
};
