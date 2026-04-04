const {
  getPatientsByPhone,
  getLastPrescriptionsByPatientId,
} = require("../services/hospitalBackend");
const {
  prescriptionViewUrl,
  hasPrescriptionPortalLink,
} = require("../utils/prescriptionPortalUrl");

const STEPS = {
  PICK_PATIENT: "PICK_PATIENT",
};

/** User asks for links again (outside completed flow, messageProcessor may restart flow) */
function wantsFullDetailsOrLinks(text) {
  return /\b(full\s*details?|all\s*(the\s*)?(prescription|rx)s?|give\s+me\s+(the\s*)?(full\s*)?details?|official\s*(website|site|link|portal)|view\s+(online|on\s*(the\s*)?(website|site))|show\s+(me\s*)?all|every(thing)?|all\s+links?|prescription\s*links?)\b/i.test(
    String(text || "").trim(),
  );
}

function formatPatientLine(p, indexLabel) {
  const name = p.fullName?.trim() || "Patient";
  const pid = p.patientId || "—";
  const age = p.age != null ? p.age : "—";
  const gender = p.gender || "—";
  const rx =
    typeof p.rxCount === "number"
      ? ` | ${p.rxCount} prescription(s) on file`
      : "";
  return `${indexLabel}. *${name}* — Age ${age}, ${gender} — Patient ID ${pid}${rx}`;
}

/**
 * Links only — no medicine names (privacy + portal is source of truth).
 */
function buildPrescriptionLinksReply(patientName, patientCode, rxList) {
  const name = patientName?.trim() || "patient";
  const code = patientCode || "";

  const urls = rxList.map((rx) => prescriptionViewUrl(rx._id)).filter(Boolean);

  if (!hasPrescriptionPortalLink() || !urls.length) {
    const hint =
      "Secure prescription links are not available in this chat at the moment. Please contact *reception* or your care team for a copy of your records.";
    return {
      reply:
        code.length > 0
          ? `*Prescriptions*\n\nWe have prescription record(s) on file for *${name}* (Patient ID: ${code}), but online viewing links are not enabled yet.\n\n${hint}`
          : `*Prescriptions*\n\nWe have prescription record(s) on file for *${name}*, but online viewing links are not enabled yet.\n\n${hint}`,
      endFlow: true,
    };
  }

  const header =
    code.length > 0
      ? `*Prescriptions*\n\nPatient: *${name}*\nPatient ID: ${code}\n\nShowing your *${urls.length} most recent* prescription link(s) (newest first). Tap to open in the browser.`
      : `*Prescriptions*\n\nPatient: *${name}*\n\nShowing your *${urls.length} most recent* prescription link(s) (newest first). Tap to open in the browser.`;

  const lines = [header, "", ...urls.map((u, i) => `${i + 1}. ${u}`)];
  return { reply: lines.join("\n"), endFlow: true };
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
      reply:
        "*Prescriptions*\n\nNo patient profile is linked to this WhatsApp number at our hospital.\n\nPlease contact *reception* to register, or reply *appointment* to book a visit.",
      endFlow: true,
    };
  }

  ctx.activeFlow = "prescription";
  ctx.prescription = {
    step: STEPS.PICK_PATIENT,
    patients,
  };

  const labels = patients.map((p, i) =>
    formatPatientLine(p, i + 1),
  );
  const letters = patients.map((_, i) => String.fromCharCode(65 + i));
  const n = patients.length;
  const letterHint =
    n <= 26
      ? `Reply with a *number* (1–${n}) or a *letter* (${letters[0]}–${letters[n - 1]}) for the correct record.`
      : `Reply with a *number* from *1* to *${n}* for the correct record. (Letters A–Z match only the first 26 rows.)`;
  return {
    reply: `*Prescriptions*\n\nWe found *${n}* patient record(s) linked to this number. Please select *your* record:\n\n${labels.join(
      "\n",
    )}\n\n${letterHint}`,
  };
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
          ? `Please reply with a *number* (1–${len}) or a *letter* (A–${String.fromCharCode(
              64 + len,
            )}).`
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
    if (!rxList.length) {
      return {
        reply: `*Prescriptions*\n\nWe have no prescription records on file for *${selectedPatientName}* (Patient ID: ${selectedPatientCode || patientId}).\n\nIf this seems incorrect, please contact *reception*.`,
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
