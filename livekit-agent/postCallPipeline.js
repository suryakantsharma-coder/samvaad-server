const mongoose = require("mongoose");
const PatientModel = require("../src/models/patient.model");
const DoctorModel = require("../src/models/doctor.model");
const { processAppointmentExtraction } = require("../ai/services/processAppointment");
const {
  normalizeCallerKey,
  writeLatestTranscript,
  writeExtractionSidecar,
} = require("../src/services/callTranscriptStore");
const {
  translateTranscriptTurnsToEnglish,
} = require("../src/services/transcriptEnglishTranslate");

function normalizePhone10(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return null;
}

/** @param {{ items?: unknown[] }} chatCtx */
function chatItemsToTranscript(chatCtx) {
  const items = chatCtx && Array.isArray(chatCtx.items) ? chatCtx.items : [];
  const transcript = [];
  for (const item of items) {
    if (!item || item.type !== "message") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text =
      typeof item.textContent === "string" ? item.textContent : undefined;
    if (!text || !String(text).trim()) continue;
    transcript.push({ role: item.role, text: String(text).trim() });
  }
  return transcript;
}

async function loadRefsForExtraction(hospitalObjectId, callerPhone) {
  const hid =
    hospitalObjectId instanceof mongoose.Types.ObjectId
      ? hospitalObjectId
      : new mongoose.Types.ObjectId(String(hospitalObjectId));

  const doctors = await DoctorModel.find({ hospital: hid })
    .select("fullName doctorId designation")
    .lean();

  const doctorsForHospital = doctors.map((d) => ({
    doctorId: d.doctorId || "",
    doctorObjectId: String(d._id),
    fullName: d.fullName,
    designation: d.designation || "",
  }));

  const phone10 = normalizePhone10(callerPhone);
  let existingPatientsByPhone = [];
  if (phone10) {
    const raw = String(callerPhone).trim();
    const digits = String(callerPhone).replace(/\D/g, "");
    const patients = await PatientModel.find({
      hospital: hid,
      $or: [
        { phoneNumber: phone10 },
        { phoneNumber: raw },
        { phoneNumber: digits },
        { phoneNumber: `0${phone10}` },
      ],
    })
      .select("patientId fullName phoneNumber")
      .lean();

    existingPatientsByPhone = patients.map((p) => ({
      patientId: p.patientId || "",
      patientObjectId: String(p._id),
      fullName: p.fullName || "",
      phoneNumber: p.phoneNumber || "",
    }));
  }

  return { doctorsForHospital, existingPatientsByPhone };
}

/**
 * Persist under caller-numbers/, English transcript required for stored record when API key is set.
 */
async function runPostCallPipeline({
  session,
  hospital,
  callerPhone,
  roomName,
  skipExtraction = false,
  skipReason = null,
}) {
  const hospitalId = String(hospital._id);
  const hospitalNameEnglish = (hospital.name || "").trim() || "Unknown hospital";
  const phone10 = normalizePhone10(callerPhone);
  const callerKey = normalizeCallerKey(callerPhone);

  let originalLanguageTranscript = [];
  try {
    const ctx = session.chatCtx;
    originalLanguageTranscript = chatItemsToTranscript(ctx);
  } catch (err) {
    console.error("[PostCall] Could not read session.chatCtx:", err.message);
  }

  let englishTranscript = [];
  let englishTranslationVerified = false;
  let englishTranslationError = null;

  if (originalLanguageTranscript.length > 0) {
    if (skipExtraction) {
      englishTranscript = originalLanguageTranscript.map((t) => ({
        role: t.role,
        text: t.text,
      }));
      englishTranslationError =
        skipReason || "extraction skipped — live booking completed on call";
    } else if (process.env.OPENAI_API_KEY) {
      try {
        englishTranscript = await translateTranscriptTurnsToEnglish(
          originalLanguageTranscript,
        );
        englishTranslationVerified = true;
      } catch (err) {
        englishTranslationError = err.message || String(err);
        console.error(
          "[PostCall] English translation failed:",
          englishTranslationError,
        );
        englishTranscript = originalLanguageTranscript.map((t) => ({
          role: t.role,
          text: t.text,
        }));
      }
    } else {
      englishTranscript = originalLanguageTranscript.map((t) => ({
        role: t.role,
        text: t.text,
      }));
      englishTranslationError = "OPENAI_API_KEY missing — englishTranscript not verified as English";
      console.warn(`[PostCall] ${englishTranslationError}`);
    }
  }

  const savedAt = new Date().toISOString();
  const savedPayload = {
    schemaVersion: 2,
    savedAt,
    callerPhoneNumber: phone10,
    hospitalId,
    hospitalNameEnglish,
    roomName: roomName || "",
    originalLanguageTranscript,
    englishTranscript,
    recordLanguageNote:
      "originalLanguageTranscript is raw STT (may be Hindi or Gujarati). englishTranscript is the English version used for extraction and must be preferred for reporting.",
    englishTranslationVerified,
    englishTranslationError,
  };

  try {
    const p = writeLatestTranscript(savedPayload);
    console.log("[PostCall] Caller record saved:", p);
  } catch (err) {
    console.error("[PostCall] Transcript write failed:", err.message);
  }

  if (englishTranscript.length === 0) {
    console.warn("[PostCall] Empty transcript; skipping extraction.");
    return;
  }

  if (skipExtraction) {
    console.log(
      "[PostCall] Skipping GPT extraction:",
      skipReason || "skipExtraction=true",
    );
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn("[PostCall] OPENAI_API_KEY missing; skipping extraction.");
    return;
  }

  const { extractAppointmentFromTranscript } = require("../ai/services/extractAppointment");

  let extractionInput;
  try {
    const { doctorsForHospital, existingPatientsByPhone } =
      await loadRefsForExtraction(hospital._id, callerPhone);
    extractionInput = {
      hospitalId,
      hospitalName: hospitalNameEnglish,
      callerPhone: phone10,
      transcript: englishTranscript,
      existingPatientsByPhone,
      doctorsForHospital,
    };
  } catch (err) {
    console.error("[PostCall] loadRefsForExtraction failed:", err.message);
    return;
  }

  let result = null;
  try {
    result = await extractAppointmentFromTranscript(extractionInput);
  } catch (err) {
    console.error(
      "[PostCall] extractAppointmentFromTranscript failed:",
      err.message,
    );
    try {
      writeExtractionSidecar(callerKey, {
        savedAt: new Date().toISOString(),
        error: err.message,
      });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  try {
    writeExtractionSidecar(callerKey, {
        savedAt: new Date().toISOString(),
        summaryEnglish: {
          hospitalId,
          turnCount: englishTranscript.length,
        },
        result,
      });
  } catch (err) {
    console.error("[PostCall] extraction sidecar write failed:", err.message);
  }

  try {
    await processAppointmentExtraction(hospitalId, result);
  } catch (err) {
    console.error(
      "[PostCall] processAppointmentExtraction failed:",
      err.message,
    );
  }
}

module.exports = {
  runPostCallPipeline,
  chatItemsToTranscript,
};
