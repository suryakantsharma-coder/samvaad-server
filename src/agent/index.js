const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const mongoose = require("mongoose");
require("dotenv").config();
const env = require("../config/env");
const AppointmentModel = require("../models/appointment.model");
const HospitalModel = require("../models/hospital.model");
const DoctorModel = require("../models/doctor.model");
const PatientModel = require("../models/patient.model");
const {
  resample8kTo24k,
  resample24kTo8k,
  resample8kTo48k,
  resample48kTo24k,
  pcm24kToWavBuffer,
  computeRms,
  applyNoiseReduction,
  EXOTEL_CHUNK_BYTES,
  OPENAI_SAMPLE_RATE,
  OPENAI_SAMPLE_WIDTH,
} = require("./audioUtils");
const { parseAppointmentFromTranscript } = require("./transcriptParser");
const { getRealtimeTools } = require("./realtimeTools");
const { loadRnnoise, processPcm24kWithRnnoise } = require("./rnnoiseProcessor");

const app = express();
expressWs(app);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

const USE_TRANSCRIPT_ONLY = true;
const USE_SARVAM_STREAMING_STT = true;
const USE_SARVAM_TTS_FOR_OUTPUT = true;
const USE_NOISE_REDUCTION = true;
/** RNNoise (WASM) between Exotel and STT: Exotel -> RNNoise -> STT (Sarvam) -> ... */
const USE_RNNOISE = true;
const NOISE_GATE_THRESHOLD = 180;
const TRANSCRIPT_ONLY_SILENCE_MS = USE_SARVAM_STREAMING_STT ? 250 : 400;
const TRANSCRIPT_ONLY_SPEECH_THRESHOLD = 350;
const TRANSCRIPT_ONLY_MIN_DURATION_MS = 200;
const STREAMING_CHUNK_MS = 120;
const STREAMING_CHUNK_BYTES_24K =
  (STREAMING_CHUNK_MS / 1000) * OPENAI_SAMPLE_RATE * OPENAI_SAMPLE_WIDTH;

async function transcribeWithSarvam(wavBuffer) {
  if (!SARVAM_API_KEY) {
    console.warn("[Agent] SARVAM_API_KEY not set; skipping Sarvam STT");
    return "";
  }
  try {
    const { SarvamAIClient } = require("sarvamai");
    const client = new SarvamAIClient({
      apiSubscriptionKey: SARVAM_API_KEY,
    });
    const response = await client.speechToText.transcribe({
      file: wavBuffer,
    });
    // SDK returns { data: body }; API body typically has transcript
    const body = response?.data ?? response;
    const text =
      (body && (body.transcript ?? body.text ?? body.transcription)) || "";
    return String(text).trim();
  } catch (err) {
    console.error("[Agent] Sarvam STT error:", err.message);
    throw err;
  }
}

const SARVAM_WS_BASE = "wss://api.sarvam.ai/speech-to-text/ws";
const SARVAM_TTS_WS_BASE = "wss://api.sarvam.ai/text-to-speech/ws";

const HOSPITAL_PROMPT = `
You are a Hospital Calling Assistant. Follow this flow strictly.
If the hospital is already known from context (this call is for one specific hospital), do NOT ask the caller to choose Hospital A or B — start directly with greeting and language.

LANGUAGE:
- GREETING: Always and ONLY in Hindi. Start every call with a warm Hindi greeting only, e.g. "नमस्ते, अस्पताल की तरफ से आपका स्वागत है।"
- After greeting, detect the caller's language from their FIRST reply (only Hindi or Gujarati). Use that same language for the REST of the call. Do not use English after the greeting; speak only in Hindi or Gujarati based on what the caller uses.

CALL FLOW:
1) GREETING (first thing): Say a warm greeting ONLY in Hindi. Then ask in Hindi: "क्या आप Hospital A जाना चाहेंगे या Hospital B?" Do not suggest doctors until they choose.
2) HOSPITAL CHOICE: Wait for their answer (Hospital A or B). Then continue in their language (Hindi or Gujarati).
3) DOCTORS: Based on their choice, use ONLY that hospital's list. HOSPITAL A: General Medicine: Dr. Amit Sharma (Mon–Sat 10:00AM–2:00PM), Dr. Neha Verma (Mon–Fri 4:00PM–8:00PM); Cardiology: Dr. Rajesh Mehta (Mon–Sat 11:00AM–3:00PM); Orthopedics: Dr. Suresh Iyer (Mon–Fri 10:00AM–1:00PM); Dermatology: Dr. Pooja Malhotra (Tue–Sun 12:00PM–5:00PM); ENT: Dr. Vikram Singh (Mon–Sat 9:00AM–12:00PM); Pediatrics: Dr. Anjali Rao (Mon–Sat 10:00AM–4:00PM). HOSPITAL B: General Medicine: Dr. Karan Patel (Mon–Fri 9:00AM–1:00PM), Dr. Priya Desai (Tue–Sat 2:00PM–6:00PM); Cardiology: Dr. Sunil Nair (Mon–Sat 10:00AM–2:00PM); Orthopedics: Dr. Meera Krishnan (Mon–Fri 11:00AM–3:00PM); Dermatology: Dr. Ravi Joshi (Mon–Sat 12:00PM–4:00PM); ENT: Dr. Deepa Reddy (Mon–Fri 9:00AM–12:00PM); Pediatrics: Dr. Arun Menon (Mon–Sat 10:00AM–5:00PM). Symptom mapping: Fever/cold/headache/weakness→General Medicine; Chest pain/BP/heart→Cardiology; Joint/back pain/fracture→Orthopedics; Skin allergy/rashes/acne→Dermatology; Ear/throat/sinus→ENT; Child-related→Pediatrics.
4) BOOKING: Ask ONE question at a time in this exact order: patient name (मरीज का नाम / રોગીનું નામ), patient age (उम्र / ઉંમર), phone number, preferred date (तारीख / તારીખ), preferred time (समय / સમય).
5) RULES: Do NOT diagnose or prescribe. If life-threatening, tell them to go to nearest emergency.
6) When confirming the appointment, say clearly in one sentence: "Hospital A/B, Dr. [Name], patient [name], age [number], phone [number], date [date], time [time]." This helps us log the appointment.
`;

// =========================
// Helper: Get hospital-specific instructions with doctors from database
// =========================
const getHospitalInstructions = async (hospital, callerPhone = null) => {
  if (!hospital) {
    console.warn(
      "[Agent] getHospitalInstructions: no hospital provided, using HOSPITAL_PROMPT",
    );
    return HOSPITAL_PROMPT;
  }

  const hospitalName = hospital.name || "unknown";
  const hospitalId = hospital._id ? String(hospital._id) : "no-id";
  const hasCallerNumber =
    callerPhone &&
    String(callerPhone).trim() &&
    String(callerPhone).trim().toLowerCase() !== "unknown";
  const callerNumberForPrompt = hasCallerNumber
    ? String(callerPhone).trim().replace(/\D/g, "").slice(-10) ||
      String(callerPhone).trim()
    : null;
  console.log(
    `[Agent] getHospitalInstructions: fetching for ${hospitalName} (${hospitalId})${hasCallerNumber ? ` caller=${callerNumberForPrompt || callerPhone}` : ""}`,
  );

  try {
    const doctors = await DoctorModel.find({ hospital: hospital._id })
      .select("fullName designation availability status")
      .lean();

    console.log(
      `[Agent] getHospitalInstructions: DoctorModel.find returned ${doctors?.length ?? 0} doctors for ${hospitalName}`,
    );

    // Group doctors by designation/department
    const doctorsByDept = {};
    doctors.forEach((doctor) => {
      const dept = doctor.designation || "General";
      if (!doctorsByDept[dept]) {
        doctorsByDept[dept] = [];
      }
      doctorsByDept[dept].push({
        name: doctor.fullName,
        designation: doctor.designation,
        availability: doctor.availability || "9 AM - 5 PM",
        status: doctor.status || "On Duty",
      });
    });

    // Build doctor list string for prompt
    let doctorListText = "";
    Object.keys(doctorsByDept).forEach((dept) => {
      doctorListText += `\n${dept}: `;
      const deptDoctors = doctorsByDept[dept];
      doctorListText += deptDoctors
        .map(
          (doc) =>
            `Dr. ${doc.name} (${doc.availability})${doc.status !== "On Duty" ? ` - Status: ${doc.status}` : ""}`,
        )
        .join(", ");
    });

    const dynamicPrompt = `You are **Neha**, a polite, friendly, and professional **female AI Hospital Receptionist** from ${hospital.name}.

Your only role is to help patients **quickly book medical appointments** in a smooth and natural conversation.

Speak like a **calm and caring female receptionist**.

Hospital Details:
${hospital.name}
${hospital.address}, ${hospital.city} - ${hospital.pincode}
Phone: ${hospital.phoneCountryCode || "+91"} ${hospital.phoneNumber}

Available Doctors:
${doctorListText || "No doctors currently available."}

IMPORTANT:
This call is already for **${hospital.name} only**.
Do NOT ask the caller to choose between hospitals.

Start directly with greeting and language selection.

────────────────────────
LANGUAGE RULES (STRICT)
────────────────────────

You must speak **ONLY in Hindi or Gujarati**.

Never speak English with the caller.

Start every conversation with:

Hindi:
"नमस्ते, मैं ${hospital.name} से नेहा बोल रही हूँ। आप हिंदी में बात करना चाहेंगे या गुजराती में?"

Gujarati:
"નમસ્તે, હું ${hospital.name}થી નેહા બોલી રહી છું। તમે હિન્દી કે ગુજરાતી માં વાત કરશો?"

Wait for the user to choose language.

After language selection:

* Continue conversation **only in that language**
* Never switch languages.

────────────────────────
FAST APPOINTMENT FLOW
────────────────────────

Follow this **single fast flow**.

Step 1 — Ask Problem / Disease

Hindi:
"आपको किस समस्या या बीमारी के लिए डॉक्टर से मिलना है?"

Gujarati:
"તમને કઈ સમસ્યા અથવા બીમારી માટે ડોક્ટર પાસે જવું છે?"

Then confirm once:

Hindi:
"ठीक है, आपको [reason] की समस्या है, सही है?"

Gujarati:
"બરાબર, તમને [reason] ની સમસ્યા છે, સાચું?"

REASON (for database) — IMPORTANT:

* Capture exactly what the caller said.
* Store it in **English** in the database.
* If caller says disease in English (example: piles, BP, diabetes, fever, cold, cough etc) → store EXACT same word.
* If caller says disease in Hindi or Gujarati → convert to correct English medical term.

Examples:
बवासीर → piles
मधुमेह → diabetes
બાવાસીર → piles

Do not change English disease names.

────────────────────────

Step 2 — Ask Previous Visit

Hindi:
"क्या आप पहले भी ${hospital.name} में इलाज करा चुके हैं?"

Gujarati:
"શું તમે પહેલાં ${hospital.name} માં સારવાર લીધી છે?"

This is only for conversation context.
Flow remains same for all patients.

────────────────────────

Step 3 — Collect Patient Details

Ask one by one.

Name

Hindi:
"मरीज का नाम बताइए।"

Gujarati:
"દર્દીનું નામ જણાવો."

Age

Hindi:
"उम्र कितनी है?"

Gujarati:
"ઉમર કેટલી છે?"

Gender

Hindi:
"पुरुष हैं या महिला?"

Gujarati:
"પુરુષ છે કે સ્ત્રી?"

────────────────────────

Step 4 — Doctor Suggestion

Analyze the **Reason** and suggest the most relevant doctor from:

${doctorListText}

If no exact match → suggest **General Physician**.

Confirm doctor with patient.

Hindi:
"इस समस्या के लिए Dr. [doctorName] सही रहेंगे। क्या मैं इनके साथ अपॉइंटमेंट बुक कर दूँ?"

Gujarati:
"આ સમસ્યા માટે Dr. [doctorName] યોગ્ય રહેશે। શું હું તેમની સાથે અપોઈન્ટમેન્ટ બુક કરું?"

Save doctor._id

────────────────────────

Step 5 — Ask Date

Hindi:
"आप किस दिन आना चाहेंगे?"

Gujarati:
"તમે કયા દિવસે આવશો?"

────────────────────────

Step 6 — Ask Time

Hindi:
"किस समय आना सुविधाजनक रहेगा?"

Gujarati:
"કયા સમયે આવવું અનુકૂળ રહેશે?"

Convert to ISO UTC format.

────────────────────────

Step 7 — Phone Number

Phone number will be **caller number by default**.

${
  callerNumberForPrompt
    ? `Use this number automatically:
${callerNumberForPrompt}`
    : `Ask phone number if not available.

Hindi:
"अपना मोबाइल नंबर बताइए।"

Gujarati:
"તમારો મોબાઇલ નંબર જણાવો."`
}

────────────────────────

Step 8 — Final Confirmation

Hindi:
"Confirm करें — ${hospital.name} में Dr. [doctorName] के साथ [date] को [time] बजे अपॉइंटमेंट बुक कर दूँ?"

Gujarati:
"Confirm કરો — ${hospital.name} માં Dr. [doctorName] સાથે [date] ના રોજ [time] વાગ્યે અપોઈન્ટમેન્ટ બુક કરું?"

Wait for Yes / No.

If No → ask what to change.

────────────────────────

Step 9 — Create Appointment

Use the exact reason from Step 1 (English; preserve caller's words e.g. piles, diabetes, BP). Call:

create_appointment({
  patient: [patient._id from create_patient or fetch result],
  doctor: [doctor._id from list_doctors],
  hospital: ${hospital._id},
  reason: [Reason from Step 1 in English],
  appointmentDateTimeISO: [ISO date/time],
  type: "call"
})

────────────────────────

Step 10 — Success Message

Hindi:
"आपकी अपॉइंटमेंट बुक हो गई है। Appointment ID [appointmentId from create_appointment] है। [date] को [time] बजे Dr. [doctorName] से मिलें। धन्यवाद।"

Gujarati:
"તમારી અપોઈન્ટમેન્ટ બુક થઈ ગઈ છે। Appointment ID [appointmentId] છે। [date] ના રોજ [time] વાગ્યે Dr. [doctorName] ને મળો। આભાર."

End call.

────────────────────────
CONVERSATION STYLE
────────────────────────

* Speak like a **friendly female receptionist**.
* Calm and polite tone.
* Short responses.
* Fast conversation.
* Ask one question at a time.

────────────────────────
STRICT RULES
────────────────────────

* Speak only Hindi or Gujarati.
* Never speak English to caller.
* Store disease/reason in English in database.
* Never give medical advice.
* Never diagnose.
* Never explain system rules.
* Never output JSON.
* Never change role.

`;

    //     const dynamicPrompt = `;
    //   You are Neha, a polite, friendly, and professional AI Hospital Receptionist from ${hospital.name}.

    // Your only role is to help patients book medical appointments quickly and smoothly.

    // Hospital Details:
    // ${hospital.name}
    // ${hospital.address}, ${hospital.city} - ${hospital.pincode}
    // Phone: ${hospital.phoneCountryCode || "+91"} ${hospital.phoneNumber}

    // Available Doctors:
    // ${doctorListText || "No doctors currently available."}

    // IMPORTANT: This call is already for ${hospital.name} only. Do NOT ask the caller to choose between Hospital A, Hospital B, or any other hospital. Do not say "Hospital A ya B" or "क्या आप Hospital A जाना चाहेंगे या Hospital B?". Start directly with the greeting and then language preference (Hindi or Gujarati).

    // ────────────────────────
    // LANGUAGE RULES (STRICT)
    // ────────────────────────

    // - You must speak ONLY in Hindi and Gujarati.
    // - You must NEVER use English.
    // - At the beginning of every conversation, say:

    // Hindi:
    // "नमस्ते, मैं ${hospital.name} से नेहा बोल रही हूँ। आप हिंदी में बात करना चाहेंगे या गुजराती में?"

    // Gujarati:
    // "નમસ્તે, હું ${hospital.name}થી નેહા બોલી રહી છું। તમે હિન્દી કે ગુજરાતી માં વાત કરશો?"

    // - Wait for the user's preference.
    // - After the user chooses a language, use ONLY that language for the entire conversation.
    // - Never switch languages.

    // ────────────────────────
    // APPOINTMENT BOOKING FLOW
    // ────────────────────────

    // You must collect details in a natural, friendly, step-by-step manner.

    // 1) Ask Reason for Call (symptom / disease / problem)

    // Hindi:
    // "आप किस समस्या के लिए कॉल कर रहे हैं?"

    // Gujarati:
    // "તમે કઈ સમસ્યા માટે ફોન કર્યો છે?"

    // REASON (for database) — CRITICAL:
    // - Capture exactly what the caller said. Store in the "reason" field in English for the database.
    // - If the caller uses an ENGLISH medical or disease name, keep that EXACT English word. Examples: piles, diabetes, blood pressure, BP, fever, cold, cough, asthma, thyroid, hernia, acidity, migraine, back pain, knee pain, skin allergy, headache, weakness, chest pain, etc. Do NOT translate these to Hindi/Gujarati; store them as-is (e.g. "piles" → reason = "piles").
    // - If the caller says the problem only in Hindi or Gujarati, translate it to the standard English medical term for the database (e.g. बवासीर → "piles", मधुमेह → "diabetes").
    // - Never paraphrase or guess: use the caller's exact medical term when they say it in English, and the correct English equivalent when they say it in another language.

    // 2) Ask Existing or New Patient

    // Hindi:
    // "क्या आप पहले यहां इलाज करा चुके हैं?"

    // Gujarati:
    // "શું તમે પહેલાં અહીં સારવાર લીધી છે?"

    // If YES → Existing Patient
    // If NO → New Patient

    // 3) Existing Patient Flow

    // ${
    //   callerNumberForPrompt
    //     ? `CALLER NUMBER: The call is from number ending **${callerNumberForPrompt.slice(-4)}** (full: ${callerNumberForPrompt}). Use this first.
    // - Ask the caller if this is their registered mobile number (confirm once).

    // Hindi: "क्या यही नंबर आपका रजिस्टर्ड नंबर है?"
    // Gujarati: "શું આ જ નંબર તમારો રજિસ્ટર્ડ નંબર છે?"

    // - If caller says YES: Call fetch_patient_by_phone with this number: ${callerNumberForPrompt}. If found → say "आपका पिछला रिकॉर्ड मिल गया है। कृपया अपना नाम और उम्र बताइए।" / "તમારો પહેલાનો રેકોર્ડ મળી ગયો છે। કૃપા કરીને તમારું નામ અને ઉમર કહો." After they confirm name and age, save patient._id, then doctor/date/time and create appointment with Step 1 Reason. If NOT found → say they are not registered with this number and ask to register as new (Go to Step 4).
    // - If caller says NO or gives another number: Ask "अपना मोबाइल नंबर बताइए।" / "તમારો મોબાઇલ નંબર આપો." then use that number in fetch_patient_by_phone. If found → same as above (previous record found, ask name and age, then book with new reason). If not found → register as new.`
    //     : `Ask Mobile Number.

    // Hindi:
    // "अपना मोबाइल नंबर बताइए।"

    // Gujarati:
    // "તમારો મોબાઇલ નંબર આપો."

    // Use:
    // fetch_patient_by_phone(phoneNumber)`
    // }

    // If found:
    // Tell the caller their previous record is found, then ask name and age to confirm.

    // Hindi: "आपका पिछला रिकॉर्ड मिल गया है। कृपया अपना नाम और उम्र बताइए ताकि हम कन्फर्म कर लें।"
    // Gujarati: "તમારો પહેલાનો રેકોર્ડ મળી ગયો છે। કૃપા કરીને તમારું નામ અને ઉમર કહો જેથી અમે કન્ફર્મ કરી લઈએ."

    // After they say name and age (match with patient record), confirm and save patient._id. Then proceed to doctor selection, date, time and create_appointment. Always use Step 1 Reason (this call's reason) in create_appointment — never use old patient reason.

    // If not found:
    // Ask to register as new.
    // If yes → Go to Step 4

    // 4) New Patient Registration

    // Collect one by one:

    // Name (Confirm spelling)
    // Age
    // Gender
    // Mobile Number
    // Date of Birth

    // Create with:
    // create_patient()

    // Save patient._id

    // 5) Doctor Assignment

    // - Analyze Reason.
    // - Match with available doctor specialty.
    // - If no match → General Physician.
    // - Confirm with patient.
    // - Save doctor._id

    // 6) Date and Time

    // Ask preferred date.

    // Hindi:
    // "किस दिन आना चाहेंगे?"

    // Gujarati:
    // "કયા દિવસે આવશો?"

    // Ask preferred time.

    // Hindi:
    // "किस समय?"

    // Gujarati:
    // "કેટલા સમયે?"

    // Convert to UTC ISO format.

    // 7) Final Confirmation

    // Read all details in one sentence.

    // Hindi:
    // "Confirm करें - ${hospital.name} में  Dr. \${doctorName} के साथ \${date} को \${time} बजे। Book करूं?"

    // Gujarati:
    // "Confirm કરો - ${hospital.name} માં  Dr. \${doctorName} સાથે \${date} ના રોજ \${time} વાગ્યે. Book કરું?"

    // Wait for Yes/No.

    // If No → Ask what to change.
    // Return to that step.

    // 8) Create Appointment

    // Use the exact Reason you saved in Step 1 (including English disease names like piles, diabetes, BP — do not change or translate them).

    // Use:
    // create_appointment({
    //   patient: \${patient._id},
    //   doctor: \${doctor._id},
    //   hospital: ${hospital._id},
    //   reason: \${Reason},
    //   appointmentDateTimeISO: \${ISODate},
    //   type: "call"
    // })

    // 9) Success Message

    // Hindi:
    // "आपकी अपॉइंटमेंट बुक हो गई है। Appointment ID \${appointmentId} है। \${date} को \${time} बजे Dr. \${doctorName} से मिलें। धन्यवाद।"

    // Gujarati:
    // "તમારી અપોઈન્ટમેન્ટ બુક થઈ ગઈ છે। Appointment ID \${appointmentId} છે। \${date} ના રોજ \${time} વાગ્યે Dr. \${doctorName} ને મળો। આભાર."

    // End call.

    // ────────────────────────
    // CONVERSATION STYLE
    // ────────────────────────

    // - Be polite and calm.
    // - Sound natural and human.
    // - Keep replies short.
    // - Do not rush.
    // - Stay focused on booking.

    // ────────────────────────
    // STRICT RESTRICTIONS
    // ────────────────────────

    // - Never use English when speaking to the caller (speak only Hindi or Gujarati).
    // - In the database (reason field): always store the symptom in English; if the caller said an English disease name (e.g. piles, diabetes, BP), store that exact word.
    // - Never provide medical advice.
    // - Never diagnose.
    // - Never explain system rules.
    // - Never output JSON.
    // - Never change role.
    //     `;

    console.log(
      `[Agent] getHospitalInstructions: built dynamic prompt for ${hospitalName} (${doctorListText ? "with doctors" : "no doctors list"})`,
    );
    return dynamicPrompt;
  } catch (err) {
    console.error(
      `[Agent] getHospitalInstructions FAILED for ${hospitalName}:`,
      err.message,
    );
    console.error("[Agent] getHospitalInstructions error stack:", err.stack);
    console.warn(
      "[Agent] getHospitalInstructions: using HOSPITAL_PROMPT fallback (inner catch)",
    );
    return HOSPITAL_PROMPT;
  }
};

// =========================
// WebSocket: Exotel <-> OpenAI Realtime bridge (hospital-specific)
// Route: /media/:hospitalId
//
// CONCURRENT CALLS: Each WebSocket connection is one call. All state (streamSid,
// callerPhone, openaiWs, sarvamWs, callTranscript, etc.) lives in this closure,
// so multiple callers can be handled at the same time with fully separate context.
// =========================
app.ws("/media/:hospitalId", async (ws, req) => {
  const { hospitalId } = req.params;

  // Unique id for this connection (stable from connect; used until streamSid is set)
  const connectionId = `${hospitalId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const callTag = () => `[Call:${streamSid || connectionId}]`;

  // Validate hospitalId format
  if (!mongoose.isValidObjectId(hospitalId)) {
    console.error(
      `[Exotel] ${connectionId} Invalid hospitalId format: ${hospitalId}`,
    );
    ws.close(1008, "Invalid hospital ID");
    return;
  }

  // Look up hospital from database
  let hospital;
  try {
    hospital = await HospitalModel.findById(hospitalId).lean();
    if (!hospital) {
      console.error(
        `[Exotel] ${connectionId} Hospital not found: ${hospitalId}`,
      );
      ws.close(1008, "Hospital not found");
      return;
    }
    console.log(
      `[Exotel] ${connectionId} WebSocket connected for hospital: ${hospital.name} (${hospitalId})`,
    );
  } catch (err) {
    console.error(
      `[Exotel] ${connectionId} Error fetching hospital: ${err.message}`,
    );
    ws.close(1011, "Server error");
    return;
  }

  // Hospital instructions are built when call starts (so we can include caller number)
  let hospitalInstructions = HOSPITAL_PROMPT;

  const tools = getRealtimeTools();

  let streamSid = null;
  let callerPhone = null;
  let openaiWs = null;
  let isBotSpeaking = false;
  let openaiReady = false;
  let warnedNoStreamSid = false;
  const audioQueue = []; // Queue Exotel audio until session.updated
  const callTranscript = []; // { role: "user"|"assistant", text: string }
  let appointmentDetails = null;
  let callSummaryWritten = false;
  let userIsSpeaking = false;
  let scheduleEndCallAfterAppointmentSuccess = false;

  // Transcript-only (Sarvam STT): buffer user audio, VAD, then send text to Realtime
  const transcriptOnlyState = {
    userChunks: [],
    lastSpeechAt: 0,
    silenceStartedAt: null,
    hadSpeechInTurn: false,
    cancelResponse: () => {},
    processing: false,
  };
  const MIN_SPEECH_BYTES_24K =
    (TRANSCRIPT_ONLY_MIN_DURATION_MS / 1000) *
    OPENAI_SAMPLE_RATE *
    OPENAI_SAMPLE_WIDTH;

  // RNNoise: one buffered processor per call (lazy init).
  let rnnoiseProcessorPromise = null;
  let rnnoiseProcessor = null;

  // Sarvam Streaming STT: one WS per call; stream 24k PCM, flush on silence, get transcript.
  let sarvamWs = null;
  const sarvamStreamingBuffer = [];
  let sarvamStreamingBufferBytes = 0;

  const connectSarvamStreaming = (onTranscript) => {
    if (!SARVAM_API_KEY) return null;
    const url = `${SARVAM_WS_BASE}?model=saaras:v3&mode=transcribe&sample_rate=24000&input_audio_codec=wav`;
    try {
      const ws = new WebSocket(url, {
        headers: { "Api-Subscription-Key": SARVAM_API_KEY },
      });
      ws.on("open", () => {
        console.log(callTag(), "[Agent] Sarvam streaming STT connected");
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (
            msg.type === "data" &&
            msg.data &&
            typeof msg.data.transcript === "string"
          ) {
            const t = String(msg.data.transcript).trim();
            if (t) onTranscript(t);
          } else if (msg.type === "error") {
            console.error("[Agent] Sarvam streaming error:", msg.data);
          }
        } catch (e) {
          console.error("[Agent] Sarvam streaming parse error:", e.message);
        }
      });
      ws.on("error", (err) => {
        console.error("[Agent] Sarvam streaming WS error:", err.message);
      });
      ws.on("close", () => {
        console.log("[Agent] Sarvam streaming STT closed");
      });
      return ws;
    } catch (err) {
      console.error("[Agent] Sarvam streaming connect error:", err.message);
      return null;
    }
  };

  const cleanupRnnoise = () => {
    if (rnnoiseProcessor) {
      try {
        rnnoiseProcessor.destroy();
      } catch (e) {
        console.error("[Agent] RNNoise cleanup error:", e.message);
      }
      rnnoiseProcessor = null;
      rnnoiseProcessorPromise = null;
    }
  };

  const cleanupSarvamStreaming = () => {
    if (sarvamWs && sarvamWs.readyState === WebSocket.OPEN) {
      try {
        sarvamWs.close();
      } catch (e) {
        console.error("[Agent] Sarvam WS close error:", e);
      }
      sarvamWs = null;
    }
    sarvamStreamingBuffer.length = 0;
    sarvamStreamingBufferBytes = 0;
  };

  // Sarvam Streaming TTS: one WS per call; send text, receive 8kHz PCM, forward to Exotel.
  let sarvamTtsWs = null;

  const connectSarvamTtsStreaming = (instantGreetingText) => {
    if (!SARVAM_API_KEY) return null;
    const url = `${SARVAM_TTS_WS_BASE}?model=bulbul:v3-beta`;
    try {
      const ttsWs = new WebSocket(url, {
        headers: { "Api-Subscription-Key": SARVAM_API_KEY },
      });
      ttsWs.on("open", () => {
        console.log(callTag(), "[Agent] Sarvam streaming TTS connected");
        const config = {
          type: "config",
          data: {
            target_language_code: "gu-IN",
            speaker: "pooja",
            model: "bulbul:v3-beta",
            speech_sample_rate: "8000",
            output_audio_codec: "linear16",
            max_chunk_length: 500,
            pace: 1.1,
          },
        };
        try {
          ttsWs.send(JSON.stringify(config));
          if (instantGreetingText && String(instantGreetingText).trim()) {
            ttsWs.send(
              JSON.stringify({
                type: "text",
                data: { text: String(instantGreetingText).trim() },
              }),
            );
            ttsWs.send(JSON.stringify({ type: "flush" }));
            console.log(callTag(), "[Agent] Instant greeting sent to TTS");
          }
        } catch (e) {
          console.error("[Agent] Sarvam TTS config send error:", e.message);
        }
      });
      ttsWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "audio" && msg.data && msg.data.audio) {
            let pcm = Buffer.from(msg.data.audio, "base64");
            const contentType = msg.data.content_type || "";
            const sampleRate = msg.data.speech_sample_rate;
            if (pcm.length >= 44 && pcm[0] === 0x52 && pcm[1] === 0x49) {
              pcm = pcm.subarray(44);
            }
            const rate = Number(sampleRate) || 0;
            const is24k =
              rate === 24000 ||
              (contentType && String(contentType).includes("24000"));
            const pcm8k = is24k ? resample24kTo8k(pcm) : pcm;
            const sid = streamSid || "default";
            let chunkCount = 0;
            let lastChunkSize = 0;
            for (let i = 0; i < pcm8k.length; i += EXOTEL_CHUNK_BYTES) {
              if (userIsSpeaking) break;
              const end = Math.min(i + EXOTEL_CHUNK_BYTES, pcm8k.length);
              let chunk = pcm8k.subarray(i, end);
              lastChunkSize = chunk.length;
              if (chunk.length < EXOTEL_CHUNK_BYTES && chunk.length > 0) {
                const padded = Buffer.alloc(EXOTEL_CHUNK_BYTES, 0);
                chunk.copy(padded);
                chunk = padded;
              }
              const payload = chunk.toString("base64");
              try {
                ws.send(
                  JSON.stringify({
                    event: "media",
                    streamSid: sid,
                    media: { payload },
                  }),
                );
                chunkCount++;
              } catch (e) {
                console.error("[Exotel] Send media error (TTS):", e);
              }
            }
            console.log(
              "[TTS->Exotel] chunks=" +
                chunkCount +
                " streamSid=" +
                sid +
                (lastChunkSize && lastChunkSize !== EXOTEL_CHUNK_BYTES
                  ? " (last padded from " + lastChunkSize + ")"
                  : ""),
            );
          } else if (msg.type === "error") {
            console.error("[Agent] Sarvam TTS error:", msg.data);
          }
        } catch (e) {
          console.error("[Agent] Sarvam TTS message parse error:", e.message);
        }
      });
      ttsWs.on("error", (err) => {
        console.error("[Agent] Sarvam TTS WS error:", err.message);
      });
      ttsWs.on("close", () => {
        console.log("[Agent] Sarvam streaming TTS closed");
      });
      return ttsWs;
    } catch (err) {
      console.error("[Agent] Sarvam TTS connect error:", err.message);
      return null;
    }
  };

  const cleanupSarvamTtsStreaming = () => {
    if (sarvamTtsWs && sarvamTtsWs.readyState === WebSocket.OPEN) {
      try {
        sarvamTtsWs.close();
      } catch (e) {
        console.error("[Agent] Sarvam TTS WS close error:", e);
      }
      sarvamTtsWs = null;
    }
  };

  const cleanupOpenAI = () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.close();
      } catch (e) {
        console.error("[OpenAI] Error closing:", e);
      }
      openaiWs = null;
    }
  };

  const connectOpenAIRealtime = () => {
    if (!OPENAI_API_KEY) {
      console.error("[OpenAI] OPENAI_API_KEY not set");
      return null;
    }
    const model = "gpt-realtime-mini-2025-12-15";
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const client = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    // Realtime API may send function_call via response.output_item.added + response.function_call_arguments.done
    const pendingFunctionCalls = {};

    client.on("open", () => {
      console.log(
        callTag(),
        `[OpenAI] Realtime connected for hospital: ${hospital.name}`,
      );
      // Beta Realtime API format: no session.type, use modalities + input_audio_format etc.
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: hospitalInstructions, // Use hospital-specific instructions
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          tools,
          tool_choice: "auto",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
          },
        },
      };
      client.send(JSON.stringify(sessionUpdate));
    });

    client.on("message", (message) => {
      try {
        const event = JSON.parse(message.toString());

        // Log Realtime events that are relevant to tools (optional: set to true to see all event types)
        const logEventTypes = [
          "response.output_item.added",
          "response.function_call_arguments.done",
          "conversation.item.created",
        ];
        if (logEventTypes.includes(event.type)) {
          console.log(
            "[Agent] Realtime event:",
            event.type,
            event.item?.type || "",
            event.item?.name || event.call_id || "",
          );
        }

        const hospitalObjectId = hospital?._id;

        const sendToolOutput = async (callId, outputObj) => {
          console.log(
            callTag(),
            "[Agent] Tool response (data sent to ChatGPT):",
            JSON.stringify(outputObj, null, 2),
          );
          client.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify(outputObj ?? {}),
              },
            }),
          );
          client.send(JSON.stringify({ type: "response.create" }));
        };

        const runTool = async (callId, name, args) => {
          console.log(
            callTag(),
            "[Agent] ChatGPT requested tool:",
            name,
            "| call_id:",
            callId,
            "| hospitalId:",
            String(hospitalObjectId || ""),
          );
          console.log(
            "[Agent] ChatGPT tool args (full):",
            JSON.stringify(args, null, 2),
          );
          try {
            if (name === "fetch_patient_by_patientId") {
              const patientId = String(args.patientId || "").trim();
              console.log(
                "[Agent] fetch_patient_by_patientId: looking up patientId:",
                patientId,
              );
              const patient = await PatientModel.findOne({
                patientId,
                hospital: hospitalObjectId,
              }).lean();
              if (!patient) {
                console.log(
                  "[Agent] fetch_patient_by_patientId: NOT FOUND for patientId:",
                  patientId,
                );
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Patient not found for this hospital.",
                });
              }
              const out = {
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
              console.log(
                "[Agent] fetch_patient_by_patientId: FOUND | _id:",
                out.patient._id,
                "| patientId:",
                out.patient.patientId,
                "| fullName:",
                out.patient.fullName,
              );
              return await sendToolOutput(callId, out);
            }

            if (name === "fetch_patient_by_phone") {
              const raw = String(args.phoneNumber || "").trim();
              const digits = raw.replace(/\D/g, "");
              const phoneNumber =
                digits.length >= 10 ? digits.slice(-10) : digits;
              console.log(
                "[Agent] fetch_patient_by_phone: looking up phoneNumber:",
                phoneNumber,
              );
              if (!phoneNumber || phoneNumber.length !== 10) {
                return await sendToolOutput(callId, {
                  ok: false,
                  message:
                    "Invalid phone number. Provide a 10-digit mobile number.",
                });
              }
              const patient = await PatientModel.findOne({
                hospital: hospitalObjectId,
                $or: [
                  { phoneNumber },
                  { phoneNumber: raw },
                  { phoneNumber: digits },
                  { phoneNumber: "0" + phoneNumber },
                ],
              }).lean();
              if (!patient) {
                console.log(
                  "[Agent] fetch_patient_by_phone: NOT FOUND for phone:",
                  phoneNumber,
                );
                return await sendToolOutput(callId, {
                  ok: false,
                  message:
                    "No patient registered with this phone number at this hospital.",
                });
              }
              const out = {
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
              console.log(
                "[Agent] fetch_patient_by_phone: FOUND | _id:",
                out.patient._id,
                "| patientId:",
                out.patient.patientId,
                "| fullName:",
                out.patient.fullName,
              );
              return await sendToolOutput(callId, out);
            }

            if (name === "create_patient") {
              const fullName = String(args.fullName || "").trim();
              const age = Number(args.age);
              const gender = String(args.gender || "").trim();
              const reason = String(args.reason || "").trim();
              // Use Exotel caller number (number that called in); fall back to what model collected
              const argsPhone = String(args.phoneNumber || "").trim();
              const fromCall =
                callerPhone && callerPhone !== "unknown" ? callerPhone : "";
              const phoneNumber =
                fromCall ||
                (argsPhone && argsPhone.toLowerCase() !== "not provided"
                  ? argsPhone
                  : "");
              console.log("[Agent] create_patient inputs:", {
                fullName,
                age,
                gender,
                phoneNumberFromArgs: argsPhone,
                callerPhoneFromExotel: callerPhone,
                phoneNumberUsed: phoneNumber,
                reason,
              });
              if (
                !fullName ||
                !Number.isFinite(age) ||
                age < 0 ||
                !phoneNumber ||
                !reason
              ) {
                console.log(
                  "[Agent] create_patient validation failed: missing/invalid fields",
                );
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Missing/invalid patient fields.",
                });
              }
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
              console.log(
                "[Agent] Creating patient in DB with patientId:",
                patientId,
              );
              const patient = await PatientModel.create({
                hospital: hospitalObjectId,
                patientId,
                fullName,
                age,
                gender,
                phoneNumber,
                reason,
              });
              const out = {
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
              console.log(
                "[Agent] create_patient: CREATED | _id:",
                out.patient._id,
                "| patientId:",
                out.patient.patientId,
              );
              return await sendToolOutput(callId, out);
            }

            if (name === "list_doctors") {
              console.log(
                "[Agent] list_doctors: fetching ALL doctors for hospital:",
                String(hospitalObjectId || ""),
              );
              const doctors = await DoctorModel.find({
                hospital: hospitalObjectId,
              })
                .select("_id fullName doctorId designation availability status")
                .lean();
              const doctorsPayload = doctors.map((d) => ({
                _id: String(d._id),
                doctorId: d.doctorId || "",
                fullName: d.fullName,
                designation: d.designation,
                availability: d.availability,
                status: d.status,
              }));
              console.log(
                "[Agent] list_doctors: DB returned",
                doctors.length,
                "doctors. Full list (use _id to book):",
                JSON.stringify(doctorsPayload, null, 2),
              );
              return await sendToolOutput(callId, {
                ok: true,
                doctors: doctorsPayload,
                message: `List of ${doctors.length} doctor(s). Pick the doctor whose designation matches the patient's illness, then use that doctor's _id as doctorObjectId in create_appointment.`,
              });
            }

            if (name === "search_doctors") {
              const query = String(args.query || "").trim();
              const limit = Math.max(1, Math.min(20, Number(args.limit || 10)));
              console.log(
                "[Agent] search_doctors: query:",
                query,
                "limit:",
                limit,
              );
              if (!query)
                return await sendToolOutput(callId, {
                  ok: false,
                  message:
                    "Query is required. To get all doctors use list_doctors.",
                });
              const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const regex = new RegExp(escaped, "i");
              const doctors = await DoctorModel.find({
                hospital: hospitalObjectId,
                $or: [{ fullName: regex }, { designation: regex }],
              })
                .select("_id fullName doctorId designation availability status")
                .limit(limit)
                .lean();
              console.log(
                "[Agent] search_doctors: DB returned",
                doctors.length,
                "doctors. Raw from DB:",
                JSON.stringify(
                  doctors.map((d) => ({
                    _id: String(d._id),
                    doctorId: d.doctorId,
                    fullName: d.fullName,
                    designation: d.designation,
                  })),
                  null,
                  2,
                ),
              );
              const doctorsPayload = doctors.map((d) => ({
                _id: String(d._id),
                doctorId: d.doctorId || "",
                fullName: d.fullName,
                designation: d.designation,
                availability: d.availability,
                status: d.status,
              }));
              console.log(
                "[Agent] search_doctors: sending to ChatGPT (each doctor has _id for create_appointment):",
                JSON.stringify(doctorsPayload, null, 2),
              );
              return await sendToolOutput(callId, {
                ok: true,
                doctors: doctorsPayload,
              });
            }

            if (name === "create_appointment") {
              const doctorObjectId = String(args.doctorObjectId || "").trim();
              const patientObjectId = String(args.patientObjectId || "").trim();
              const reason = String(args.reason || "").trim();
              const appointmentDateTimeISO = String(
                args.appointmentDateTimeISO || args.appointmentDateTime || "",
              ).trim();
              const type = String(args.type || "call").trim() || "call";
              console.log(
                "[Agent] create_appointment: ChatGPT sent doctorObjectId:",
                doctorObjectId,
                "patientObjectId:",
                patientObjectId,
                "reason:",
                reason,
                "appointmentDateTimeISO:",
                appointmentDateTimeISO,
              );
              if (
                !mongoose.isValidObjectId(doctorObjectId) ||
                !mongoose.isValidObjectId(patientObjectId)
              ) {
                console.log(
                  "[Agent] create_appointment: REJECTED - invalid ObjectId (doctorObjectId valid:",
                  mongoose.isValidObjectId(doctorObjectId),
                  "patientObjectId valid:",
                  mongoose.isValidObjectId(patientObjectId),
                  ")",
                );
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Invalid doctor or patient id.",
                });
              }
              const dt = new Date(appointmentDateTimeISO);
              if (Number.isNaN(dt.getTime()))
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Invalid appointmentDateTimeISO.",
                });
              if (!reason)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Reason is required.",
                });

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
                "[Agent] create_appointment: Doctor lookup by _id:",
                doctorObjectId,
                "->",
                doctor ? "FOUND" : "NOT FOUND",
                doctor
                  ? { _id: String(doctor._id), fullName: doctor.fullName }
                  : "",
              );
              console.log(
                "[Agent] create_appointment: Patient lookup by _id:",
                patientObjectId,
                "->",
                patient ? "FOUND" : "NOT FOUND",
                patient
                  ? { _id: String(patient._id), fullName: patient.fullName }
                  : "",
              );
              if (!doctor)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Doctor not found for this hospital.",
                });
              if (!patient)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: "Patient not found for this hospital.",
                });

              const year = new Date().getFullYear();
              const prefix = `A-${year}-`;
              const last = await AppointmentModel.findOne({
                appointmentId: new RegExp(`^${prefix}`),
              })
                .sort({ appointmentId: -1 })
                .select("appointmentId")
                .lean();
              const nextNum = last
                ? parseInt(
                    String(last.appointmentId).slice(prefix.length),
                    10,
                  ) + 1
                : 1;
              const appointmentId = `${prefix}${String(nextNum).padStart(6, "0")}`;
              const appointmentPayload = {
                hospital: hospitalObjectId,
                appointmentId,
                patient: patientObjectId,
                doctor: doctorObjectId,
                reason,
                status: "Upcoming",
                type,
                appointmentDateTime: dt,
              };
              console.log(
                "[Agent] create_appointment: exact payload before save to database:",
              );
              console.log(JSON.stringify(appointmentPayload, null, 2));
              const appointment =
                await AppointmentModel.create(appointmentPayload);
              scheduleEndCallAfterAppointmentSuccess = true;
              return await sendToolOutput(callId, {
                ok: true,
                appointment: {
                  _id: String(appointment._id),
                  appointmentId: appointment.appointmentId,
                  hospital: String(appointment.hospital || ""),
                  patient: String(appointment.patient),
                  doctor: String(appointment.doctor),
                  reason: appointment.reason,
                  status: appointment.status,
                  type: appointment.type,
                  appointmentDateTime:
                    appointment.appointmentDateTime?.toISOString?.() || null,
                },
              });
            }

            console.log("[Agent] Unknown tool:", name);
            return await sendToolOutput(callId, {
              ok: false,
              message: `Unknown tool: ${name}`,
            });
          } catch (err) {
            console.error(
              "[Agent] Tool execution error:",
              err.message,
              err.stack,
            );
            return await sendToolOutput(callId, {
              ok: false,
              message: err.message || "Tool error",
            });
          }
        };

        // 1) Server sends conversation.item.created when an item (e.g. function_call) is added to the conversation
        if (
          event.type === "conversation.item.created" &&
          event.item?.type === "function_call"
        ) {
          const { name, arguments: argsJson, call_id } = event.item;
          let args = {};
          try {
            args = argsJson ? JSON.parse(argsJson) : {};
          } catch (e) {
            console.error(
              "[Agent] Failed to parse function args (conversation.item.created):",
              argsJson,
            );
          }
          if (Object.keys(args).length > 0) {
            runTool(call_id, name, args);
          } else {
            pendingFunctionCalls[call_id] = { name };
            console.log(
              "[Agent] Stored pending function call (no args yet):",
              name,
              call_id,
            );
          }
        }

        // 2) During response streaming, server sends response.output_item.added for each new item (e.g. function_call)
        if (
          event.type === "response.output_item.added" &&
          event.item?.type === "function_call"
        ) {
          const { name, call_id } = event.item;
          pendingFunctionCalls[call_id] = { name };
          console.log(
            "[Agent] Pending function call (response.output_item.added):",
            name,
            call_id,
          );
          const argsJson = event.item.arguments;
          if (argsJson) {
            try {
              const args = JSON.parse(argsJson);
              delete pendingFunctionCalls[call_id];
              runTool(call_id, name, args);
            } catch (e) {
              console.error(
                "[Agent] Failed to parse function args (output_item.added):",
                argsJson,
              );
            }
          }
        }

        // 3) When function call arguments finish streaming, we get the full arguments here
        if (event.type === "response.function_call_arguments.done") {
          const { call_id, arguments: argsJson } = event;
          const pending = pendingFunctionCalls[call_id];
          if (pending) {
            delete pendingFunctionCalls[call_id];
            let args = {};
            try {
              args = argsJson ? JSON.parse(argsJson) : {};
            } catch (e) {
              console.error(
                "[Agent] Failed to parse function args (arguments.done):",
                argsJson,
              );
            }
            console.log(
              "[Agent] Running tool from response.function_call_arguments.done:",
              pending.name,
              call_id,
            );
            runTool(call_id, pending.name, args);
          }
        }

        if (event.type === "session.updated") {
          openaiReady = true;
          console.log("[OpenAI] Session ready");
          if (!USE_TRANSCRIPT_ONLY) {
            while (audioQueue.length > 0) {
              const b64 = audioQueue.shift();
              client.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: b64,
                }),
              );
            }
          } else {
            audioQueue.length = 0;
          }
          transcriptOnlyState.cancelResponse = () => {
            userIsSpeaking = true;
            try {
              client.send(JSON.stringify({ type: "response.cancel" }));
            } catch (_) {}
          };
          try {
            client.send(JSON.stringify({ type: "response.create" }));
          } catch (_) {}
        }

        // Stream output audio to Exotel: 8kHz 16-bit PCM in 20ms (320-byte) chunks (only when not using Sarvam TTS)
        if (
          !USE_SARVAM_TTS_FOR_OUTPUT &&
          (event.type === "response.audio.delta" ||
            event.type === "response.output_audio.delta")
        ) {
          userIsSpeaking = false;
          const b64 = event.delta || event.audio;
          if (b64) {
            const sid = streamSid || "default";
            if (!streamSid && !warnedNoStreamSid) {
              warnedNoStreamSid = true;
              console.warn(
                "[Exotel] streamSid was null; sending media with streamSid='default'. If no audio on call, check Exotel payload for stream ID.",
              );
            }
            const pcm24k = Buffer.from(b64, "base64");
            const pcm8k = resample24kTo8k(pcm24k);
            for (let i = 0; i < pcm8k.length; i += EXOTEL_CHUNK_BYTES) {
              if (userIsSpeaking) break;
              const chunk = pcm8k.subarray(
                i,
                Math.min(i + EXOTEL_CHUNK_BYTES, pcm8k.length),
              );
              const payload = chunk.toString("base64");
              try {
                ws.send(
                  JSON.stringify({
                    event: "media",
                    streamSid: sid,
                    media: { payload },
                  }),
                );
              } catch (e) {
                console.error("[Exotel] Send media error:", e);
              }
            }
            if (!isBotSpeaking) {
              isBotSpeaking = true;
              console.log("[Exotel] Bot started speaking");
            }
          }
        }

        if (
          event.type === "response.done" ||
          event.type === "response.output_audio.done"
        ) {
          userIsSpeaking = false;
          if (isBotSpeaking) {
            isBotSpeaking = false;
            console.log("[OpenAI] Bot finished speaking");
          }
        }

        if (event.type === "input_audio_buffer.speech_started") {
          console.log("[OpenAI] User speech started — canceling bot response");
          userIsSpeaking = true;
          client.send(JSON.stringify({ type: "response.cancel" }));
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          console.log("[OpenAI] User speech stopped");
        }
        // Collect user transcript
        if (
          event.type ===
            "conversation.item.input_audio_transcription.completed" &&
          event.transcript
        ) {
          callTranscript.push({ role: "user", text: event.transcript });
        }
        // Collect assistant transcript (Realtime API may send response.output_audio_transcript.done)
        if (
          event.type === "response.output_audio_transcript.done" &&
          event.transcript
        ) {
          callTranscript.push({ role: "assistant", text: event.transcript });
          if (
            USE_SARVAM_TTS_FOR_OUTPUT &&
            sarvamTtsWs &&
            sarvamTtsWs.readyState === WebSocket.OPEN
          ) {
            isBotSpeaking = true;
            try {
              console.log(
                "[TTS] Sending to Sarvam len=" +
                  (event.transcript?.length ?? 0),
              );
              sarvamTtsWs.send(
                JSON.stringify({
                  type: "text",
                  data: { text: event.transcript },
                }),
              );
              sarvamTtsWs.send(JSON.stringify({ type: "flush" }));
              if (scheduleEndCallAfterAppointmentSuccess) {
                const t = (event.transcript || "").toLowerCase();
                if (
                  t.includes("बुक हो गई") ||
                  t.includes("धन्यवाद") ||
                  t.includes("appointment id")
                ) {
                  scheduleEndCallAfterAppointmentSuccess = false;
                  setTimeout(() => {
                    try {
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        console.log(
                          callTag(),
                          "[Agent] Auto-ending call after appointment success",
                        );
                        ws.close();
                      }
                    } catch (e) {}
                  }, 3500);
                }
              }
            } catch (e) {
              console.error("[Agent] Sarvam TTS send error:", e.message);
            }
          }
        }
        if (
          event.type === "response.audio_transcript.done" &&
          event.transcript
        ) {
          callTranscript.push({ role: "assistant", text: event.transcript });
          if (
            USE_SARVAM_TTS_FOR_OUTPUT &&
            sarvamTtsWs &&
            sarvamTtsWs.readyState === WebSocket.OPEN
          ) {
            isBotSpeaking = true;
            try {
              console.log(
                "[TTS] Sending to Sarvam len=" +
                  (event.transcript?.length ?? 0),
              );
              sarvamTtsWs.send(
                JSON.stringify({
                  type: "text",
                  data: { text: event.transcript },
                }),
              );
              sarvamTtsWs.send(JSON.stringify({ type: "flush" }));
              if (scheduleEndCallAfterAppointmentSuccess) {
                const t = (event.transcript || "").toLowerCase();
                if (
                  t.includes("बुक हो गई") ||
                  t.includes("धन्यवाद") ||
                  t.includes("appointment id")
                ) {
                  scheduleEndCallAfterAppointmentSuccess = false;
                  setTimeout(() => {
                    try {
                      if (ws && ws.readyState === WebSocket.OPEN) {
                        console.log(
                          callTag(),
                          "[Agent] Auto-ending call after appointment success",
                        );
                        ws.close();
                      }
                    } catch (e) {}
                  }, 3500);
                }
              }
            } catch (e) {
              console.error("[Agent] Sarvam TTS send error:", e.message);
            }
          }
        }
        if (event.type === "error") {
          console.error("[OpenAI] Event error:", event.error || event);
        }
      } catch (e) {
        console.error("[OpenAI] Message parse error:", e);
      }
    });

    client.on("error", (err) => {
      console.error("[OpenAI] WebSocket error:", err);
      cleanupOpenAI();
    });

    client.on("close", () => {
      console.log("[OpenAI] Realtime closed");
      openaiWs = null;
    });

    return client;
  };

  // Extract stream ID from any of the keys Exotel/Twilio might use
  const extractStreamSid = (obj) => {
    if (typeof obj !== "object") return null;
    if (obj.streamSid) return obj.streamSid;
    if (obj.stream_id) return obj.stream_id;
    if (obj.CallSid) return obj.CallSid;
    if (obj.callSid) return obj.callSid;
    if (obj.start?.streamSid) return obj.start.streamSid;
    if (obj.start?.stream_id) return obj.start.stream_id;
    if (obj.Stream?.StreamSID) return obj.Stream.StreamSID;
    if (obj.media?.streamSid) return obj.media.streamSid;
    return null;
  };

  let firstMessageLogged = false;
  ws.on("message", async (message) => {
    try {
      if (!message) return;
      const data = JSON.parse(message.toString());

      const extracted = extractStreamSid(data);
      if (extracted && extracted !== streamSid) {
        streamSid = extracted;
        console.log(callTag(), "[Exotel] streamSid:", streamSid);
      }

      if (!firstMessageLogged) {
        firstMessageLogged = true;
        console.log(
          callTag(),
          "[Exotel] First message keys:",
          Object.keys(data).join(", "),
          data.start
            ? " start.keys: " + Object.keys(data.start).join(", ")
            : "",
        );
      }

      if (data.event === "start") {
        if (!streamSid)
          streamSid = data.start?.streamSid ?? data.streamSid ?? null;
        callerPhone =
          data.start?.customParameters?.From ??
          data.start?.callerId ??
          data.start?.from ??
          "unknown";
        console.log(
          callTag(),
          `[Exotel] Call start streamSid=${streamSid} caller=${callerPhone}`,
        );
        try {
          hospitalInstructions = await getHospitalInstructions(
            hospital,
            callerPhone,
          );
          const isFallback = hospitalInstructions === HOSPITAL_PROMPT;
          console.log(
            `[Agent] Loaded instructions for ${hospital.name}${isFallback ? " (FALLBACK)" : " (dynamic + caller number)"}`,
          );
        } catch (err) {
          console.error(
            `[Agent] Error generating hospital instructions on start: ${err.message}`,
          );
          hospitalInstructions = HOSPITAL_PROMPT;
        }
        openaiWs = connectOpenAIRealtime();
        if (USE_SARVAM_TTS_FOR_OUTPUT) {
          const instantGreeting = `नमस्ते, मैं ${hospital.name} से नेहा बोल रही हूँ। आप हिंदी में बात करना चाहेंगे या गुजराती में?`;
          sarvamTtsWs = connectSarvamTtsStreaming(instantGreeting);
          if (!sarvamTtsWs) {
            console.warn("[TTS] Sarvam TTS WebSocket failed to connect");
          }
        }
        if (USE_TRANSCRIPT_ONLY && USE_SARVAM_STREAMING_STT) {
          sarvamWs = connectSarvamStreaming((transcript) => {
            if (
              !transcript ||
              !openaiWs ||
              openaiWs.readyState !== WebSocket.OPEN
            )
              return;
            console.log(
              callTag(),
              "[Agent] Input transcription (Sarvam streaming):",
              transcript,
            );
            callTranscript.push({ role: "user", text: transcript });
            openaiWs.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: transcript }],
                },
              }),
            );
            openaiWs.send(JSON.stringify({ type: "response.create" }));
            transcriptOnlyState.processing = false;
          });
        }
      } else if (data.event === "media") {
        const payload = data.media?.payload;
        if (!payload || !openaiWs || openaiWs.readyState !== WebSocket.OPEN)
          return;
        if (!streamSid)
          streamSid = data.streamSid ?? data.media?.streamSid ?? streamSid;
        const pcm8k = Buffer.from(payload, "base64");

        // Exotel -> RNNoise -> STT (Sarvam) -> ChatGPT -> TTS (Sarvam) -> Exotel
        let pcm24k = resample8kTo24k(pcm8k);
        if (USE_RNNOISE) {
          try {
            if (!rnnoiseProcessorPromise) {
              rnnoiseProcessorPromise = loadRnnoise();
            }
            const rnnoise =
              rnnoiseProcessor ??
              (rnnoiseProcessor = await rnnoiseProcessorPromise);
            pcm24k = processPcm24kWithRnnoise(pcm24k, rnnoise);
          } catch (err) {
            console.error("[Agent] RNNoise error:", err.message);
          }
        }
        if (USE_NOISE_REDUCTION) {
          pcm24k = applyNoiseReduction(pcm24k);
        }

        if (USE_TRANSCRIPT_ONLY) {
          const rms = computeRms(pcm24k);
          const now = Date.now();
          const isSpeech = rms > TRANSCRIPT_ONLY_SPEECH_THRESHOLD;
          const pcmChunk = Buffer.from(pcm24k);

          if (
            USE_SARVAM_STREAMING_STT &&
            sarvamWs &&
            sarvamWs.readyState === WebSocket.OPEN
          ) {
            // Streaming path: send audio to Sarvam WS in chunks; flush on silence.
            sarvamStreamingBuffer.push(pcmChunk);
            sarvamStreamingBufferBytes += pcmChunk.length;
            if (sarvamStreamingBufferBytes >= STREAMING_CHUNK_BYTES_24K) {
              const wavChunk = pcm24kToWavBuffer(
                Buffer.concat(sarvamStreamingBuffer),
              );
              sarvamStreamingBuffer.length = 0;
              sarvamStreamingBufferBytes = 0;
              try {
                sarvamWs.send(
                  JSON.stringify({
                    audio: {
                      data: wavChunk.toString("base64"),
                      sample_rate: "24000",
                      encoding: "audio/wav",
                    },
                  }),
                );
              } catch (e) {
                console.error(
                  "[Agent] Sarvam streaming send error:",
                  e.message,
                );
              }
            }

            if (transcriptOnlyState.processing) {
              // wait for transcript from Sarvam
            } else if (isSpeech) {
              transcriptOnlyState.hadSpeechInTurn = true;
              if (transcriptOnlyState.silenceStartedAt !== null) {
                transcriptOnlyState.cancelResponse();
              }
              transcriptOnlyState.lastSpeechAt = now;
              transcriptOnlyState.silenceStartedAt = null;
              transcriptOnlyState.userChunks.push(pcmChunk);
            } else {
              transcriptOnlyState.userChunks.push(pcmChunk);
              if (transcriptOnlyState.silenceStartedAt === null) {
                transcriptOnlyState.silenceStartedAt = now;
              }
              const totalBytes = transcriptOnlyState.userChunks.reduce(
                (s, c) => s + c.length,
                0,
              );
              const silenceDuration =
                now - transcriptOnlyState.silenceStartedAt;
              if (
                transcriptOnlyState.hadSpeechInTurn &&
                totalBytes >= MIN_SPEECH_BYTES_24K &&
                silenceDuration >= TRANSCRIPT_ONLY_SILENCE_MS
              ) {
                transcriptOnlyState.userChunks = [];
                transcriptOnlyState.silenceStartedAt = null;
                transcriptOnlyState.lastSpeechAt = 0;
                transcriptOnlyState.hadSpeechInTurn = false;
                transcriptOnlyState.processing = true;
                try {
                  if (sarvamStreamingBufferBytes > 0) {
                    const wavTail = pcm24kToWavBuffer(
                      Buffer.concat(sarvamStreamingBuffer),
                    );
                    sarvamStreamingBuffer.length = 0;
                    sarvamStreamingBufferBytes = 0;
                    sarvamWs.send(
                      JSON.stringify({
                        audio: {
                          data: wavTail.toString("base64"),
                          sample_rate: "24000",
                          encoding: "audio/wav",
                        },
                      }),
                    );
                  }
                  sarvamWs.send(JSON.stringify({ type: "flush" }));
                } catch (e) {
                  console.error(
                    "[Agent] Sarvam streaming flush error:",
                    e.message,
                  );
                  transcriptOnlyState.processing = false;
                }
              }
            }
          } else {
            // REST path (or streaming unavailable): buffer + VAD, then one Sarvam REST call.
            if (transcriptOnlyState.processing) {
              // skip while transcribing previous turn
            } else if (isSpeech) {
              transcriptOnlyState.hadSpeechInTurn = true;
              if (transcriptOnlyState.silenceStartedAt !== null) {
                transcriptOnlyState.cancelResponse();
              }
              transcriptOnlyState.lastSpeechAt = now;
              transcriptOnlyState.silenceStartedAt = null;
              transcriptOnlyState.userChunks.push(pcmChunk);
            } else {
              transcriptOnlyState.userChunks.push(pcmChunk);
              if (transcriptOnlyState.silenceStartedAt === null) {
                transcriptOnlyState.silenceStartedAt = now;
              }
              const totalBytes = transcriptOnlyState.userChunks.reduce(
                (s, c) => s + c.length,
                0,
              );
              const silenceDuration =
                now - transcriptOnlyState.silenceStartedAt;
              if (
                transcriptOnlyState.hadSpeechInTurn &&
                totalBytes >= MIN_SPEECH_BYTES_24K &&
                silenceDuration >= TRANSCRIPT_ONLY_SILENCE_MS
              ) {
                const wavBuffer = pcm24kToWavBuffer(
                  Buffer.concat(transcriptOnlyState.userChunks),
                );
                transcriptOnlyState.userChunks = [];
                transcriptOnlyState.silenceStartedAt = null;
                transcriptOnlyState.lastSpeechAt = 0;
                transcriptOnlyState.hadSpeechInTurn = false;
                transcriptOnlyState.processing = true;

                transcribeWithSarvam(wavBuffer)
                  .then((transcript) => {
                    if (
                      !transcript ||
                      !openaiWs ||
                      openaiWs.readyState !== WebSocket.OPEN
                    )
                      return;
                    console.log(
                      callTag(),
                      "[Agent] Input transcription (Sarvam):",
                      transcript,
                    );
                    callTranscript.push({ role: "user", text: transcript });
                    openaiWs.send(
                      JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                          type: "message",
                          role: "user",
                          content: [{ type: "input_text", text: transcript }],
                        },
                      }),
                    );
                    openaiWs.send(JSON.stringify({ type: "response.create" }));
                  })
                  .catch((err) => {
                    console.error(
                      "[Agent] Sarvam transcription error:",
                      err.message,
                    );
                  })
                  .finally(() => {
                    transcriptOnlyState.processing = false;
                  });
              }
            }
          }
        } else {
          const b64 = pcm24k.toString("base64");
          if (openaiReady) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: b64,
              }),
            );
          } else {
            audioQueue.push(b64);
          }
        }
      } else if (data.event === "stop") {
        console.log(
          callTag(),
          `[Exotel] Call stop for hospital: ${hospital.name}`,
        );
        appointmentDetails =
          parseAppointmentFromTranscript(callTranscript, callerPhone) ||
          (callTranscript.some((t) =>
            /appointment|book|hospital|dr\./i.test(t.text),
          )
            ? {
                hospital: hospital._id.toString(),
                hospitalName: hospital.name,
                doctorName: null,
                patientName: null,
                patientAge: null,
                phone: callerPhone !== "unknown" ? callerPhone : null,
                preferredDate: null,
                preferredTime: null,
                callEndedAt: new Date().toISOString(),
              }
            : null);

        // Ensure hospital ID is set in appointment details
        if (appointmentDetails && !appointmentDetails.hospital) {
          appointmentDetails.hospital = hospital._id.toString();
          appointmentDetails.hospitalName = hospital.name;
        }

        const callSummary = {
          hospitalId: hospital._id.toString(),
          hospitalName: hospital.name,
          callTranscript,
          appointmentDetails: appointmentDetails || {
            status: "no_appointment",
            callEndedAt: new Date().toISOString(),
          },
          callerPhone: callerPhone !== "unknown" ? callerPhone : null,
          streamSid,
        };
        try {
          console.log(
            `[Exotel] Call stop for ${hospital.name}. (No auto-create on stop)`,
          );
        } catch (e) {
          console.error("[Exotel] Failed to write call JSON:", e);
          console.log(
            "[Exotel] Call summary (inline):",
            JSON.stringify(callSummary, null, 2),
          );
        }
        cleanupRnnoise();
        cleanupSarvamStreaming();
        cleanupSarvamTtsStreaming();
        cleanupOpenAI();
        ws.close();
      }
    } catch (e) {
      console.error("[Exotel] Message error:", e);
    }
  });

  ws.on("close", () => {
    console.log(callTag(), "[Exotel] WebSocket disconnected");
    if (!callSummaryWritten && callTranscript.length > 0) {
      let details = appointmentDetails;
      if (!details) {
        details = parseAppointmentFromTranscript(callTranscript, callerPhone);
        if (
          !details &&
          callTranscript.some((t) =>
            /appointment|book|hospital|dr\./i.test(t.text),
          )
        ) {
          details = {
            hospital: null,
            doctorName: null,
            patientName: null,
            patientAge: null,
            phone: callerPhone !== "unknown" ? callerPhone : null,
            preferredDate: null,
            preferredTime: null,
            callEndedAt: new Date().toISOString(),
          };
        }
      }
      const callSummary = {
        hospitalId: hospital._id.toString(),
        hospitalName: hospital.name,
        callTranscript,
        appointmentDetails: details || {
          status: "no_appointment",
          callEndedAt: new Date().toISOString(),
        },
        callerPhone: callerPhone !== "unknown" ? callerPhone : null,
        streamSid,
      };
      try {
        const fs = require("fs");
        const path = require("path");
        const dir = path.join(process.cwd(), "call_logs");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = path.join(
          dir,
          `call_${streamSid || Date.now()}_${Date.now()}.json`,
        );
        fs.writeFileSync(
          filename,
          JSON.stringify(callSummary, null, 2),
          "utf8",
        );
        callSummaryWritten = true;
        console.log(
          "[Exotel] Call transcript and appointment JSON saved (on close):",
          filename,
        );
      } catch (e) {
        console.error("[Exotel] Failed to write call JSON:", e);
      }
    }
    cleanupRnnoise();
    cleanupSarvamStreaming();
    cleanupSarvamTtsStreaming();
    cleanupOpenAI();
  });

  ws.on("error", (err) => {
    console.error(callTag(), "[Exotel] WebSocket error:", err);
    cleanupRnnoise();
    cleanupSarvamStreaming();
    cleanupSarvamTtsStreaming();
    cleanupOpenAI();
  });
});

// =========================
// Health / root
// =========================
app.get("/", (req, res) => {
  res.send(
    "Chat-bot Voice Agent (Exotel + OpenAI Realtime). Connect to /media/:hospitalId via WebSocket.",
  );
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ success: true, service: "voice-agent" });
});

// List available hospitals endpoint (for debugging/config)
// TODO: Add a flag to enable/disable RNNoise
// TODO: Add a flag to enable/disable Sarvam streaming STT
// TODO: Add a flag to enable/disable Sarvam TTS for output
// TODO: Add a flag to enable/disable OpenAI streaming output
// TODO: Add a flag to enable/disable OpenAI streaming input
// TODO: Add a flag to enable/disable OpenAI streaming input

app.get("/hospitals", async (req, res) => {
  try {
    const PORT = env.AGENT_PORT || 5002;
    const CLOUDFLARE_DOMAIN = env.CLOUDFLARE_DOMAIN;

    const hospitals = await HospitalModel.find({})
      .select("_id name phoneNumber email address city pincode")
      .lean();

    // Get doctor counts for each hospital
    const hospitalsWithDoctors = await Promise.all(
      hospitals.map(async (h) => {
        const doctorCount = await DoctorModel.countDocuments({
          hospital: h._id,
        });
        const localWsUrl = `ws://localhost:${PORT}/media/${h._id}`;
        const cloudflareWsUrl = CLOUDFLARE_DOMAIN
          ? `wss://${CLOUDFLARE_DOMAIN}/media/${h._id}`
          : null;

        return {
          id: h._id.toString(),
          name: h.name,
          phoneNumber: h.phoneNumber,
          email: h.email,
          address: h.address,
          city: h.city,
          pincode: h.pincode,
          doctorCount,
          websocketUrl: localWsUrl,
          cloudflareUrl: cloudflareWsUrl,
          exotelUrl: cloudflareWsUrl || localWsUrl, // Preferred URL for Exotel
        };
      }),
    );

    res.json({
      success: true,
      data: {
        hospitals: hospitalsWithDoctors,
        cloudflareDomain: CLOUDFLARE_DOMAIN || null,
        note: CLOUDFLARE_DOMAIN
          ? "Use cloudflareUrl for Exotel production connections"
          : "Set CLOUDFLARE_DOMAIN in .env to get Cloudflare URLs",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================
// Start server
// =========================
const startAgent = async () => {
  const PORT = env.AGENT_PORT || 5002;
  const CLOUDFLARE_DOMAIN = env.CLOUDFLARE_DOMAIN;

  // Fetch and log all hospitals from database at startup
  try {
    console.log("\n🏥 Loading hospitals from database...");
    const hospitals = await HospitalModel.find({})
      .select("_id name phoneNumber email address city pincode")
      .lean();

    if (hospitals.length === 0) {
      console.log(
        "   ⚠️  No hospitals found in database. Add hospitals to enable voice agent endpoints.",
      );
    } else {
      console.log(`   ✓ Found ${hospitals.length} hospital(s):\n`);

      // Get doctor counts and details for each hospital
      const hospitalsWithDetails = await Promise.all(
        hospitals.map(async (h) => {
          const doctors = await DoctorModel.find({ hospital: h._id })
            .select("fullName designation availability status")
            .lean();
          const doctorCount = doctors.length;

          // Group doctors by department
          const doctorsByDept = {};
          doctors.forEach((doc) => {
            const dept = doc.designation || "General";
            if (!doctorsByDept[dept]) {
              doctorsByDept[dept] = [];
            }
            doctorsByDept[dept].push(doc.fullName);
          });

          // Build WebSocket URLs (local and Cloudflare)
          const localWsUrl = `ws://0.0.0.0:${PORT}/media/${h._id}`;
          const cloudflareWsUrl = CLOUDFLARE_DOMAIN
            ? `wss://${CLOUDFLARE_DOMAIN}/media/${h._id}`
            : null;

          return {
            id: h._id.toString(),
            name: h.name,
            phoneNumber: h.phoneNumber,
            email: h.email,
            address: `${h.address}, ${h.city} - ${h.pincode}`,
            doctorCount,
            doctorsByDept,
            websocketUrl: localWsUrl,
            cloudflareUrl: cloudflareWsUrl,
          };
        }),
      );

      // Log each hospital with details
      hospitalsWithDetails.forEach((hospital, index) => {
        console.log(`   ${index + 1}. ${hospital.name}`);
        console.log(`      ID: ${hospital.id}`);
        console.log(`      Phone: ${hospital.phoneNumber}`);
        console.log(`      Email: ${hospital.email}`);
        console.log(`      Address: ${hospital.address}`);
        console.log(`      Doctors: ${hospital.doctorCount} available`);

        if (hospital.doctorCount > 0) {
          const deptList = Object.keys(hospital.doctorsByDept)
            .map((dept) => `${dept} (${hospital.doctorsByDept[dept].length})`)
            .join(", ");
          console.log(`      Departments: ${deptList}`);
        } else {
          console.log(`      ⚠️  No doctors assigned to this hospital`);
        }

        console.log(`      Local WebSocket: ${hospital.websocketUrl}`);
        if (hospital.cloudflareUrl) {
          console.log(`      🌐 Cloudflare URL: ${hospital.cloudflareUrl}`);
        }
        console.log("");
      });

      console.log(
        `📞 Chat-bot Voice Agent ready for ${hospitals.length} hospital(s)`,
      );

      // Show Exotel-ready endpoints (first 2 hospitals)
      if (hospitalsWithDetails.length > 0) {
        console.log("\n📱 Exotel Configuration Endpoints:");
        console.log(
          "   Configure these WebSocket URLs in your Exotel voice app:\n",
        );

        hospitalsWithDetails.slice(0, 2).forEach((hospital, index) => {
          const exotelUrl =
            hospital.cloudflareUrl ||
            hospital.websocketUrl.replace("0.0.0.0", "localhost");
          console.log(`   ${index + 1}. ${hospital.name}:`);
          console.log(`      WebSocket URL: ${exotelUrl}`);
          console.log(`      Hospital ID: ${hospital.id}`);
          console.log("");
        });

        if (hospitalsWithDetails.length > 2) {
          console.log(
            `   ... and ${hospitalsWithDetails.length - 2} more hospital(s)`,
          );
          console.log(`   Use GET /hospitals API to see all endpoints\n`);
        }

        if (!CLOUDFLARE_DOMAIN) {
          console.log("   ⚠️  CLOUDFLARE_DOMAIN not set in .env");
          console.log(
            "   Set CLOUDFLARE_DOMAIN=your-domain.com to get Cloudflare URLs\n",
          );
        }
      }
    }
  } catch (err) {
    console.error(`   ❌ Error loading hospitals: ${err.message}`);
    console.error(
      `   Agent will still start, but hospital validation may fail.`,
    );
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log("\n📞 Chat-bot Voice Agent Server Started");
    console.log(`   Port: ${PORT}`);
    console.log(`   WebSocket Pattern: ws://0.0.0.0:${PORT}/media/:hospitalId`);
    if (CLOUDFLARE_DOMAIN) {
      console.log(
        `   Cloudflare Pattern: wss://${CLOUDFLARE_DOMAIN}/media/:hospitalId`,
      );
    }
    console.log(`   Health Check: http://0.0.0.0:${PORT}/health`);
    console.log(`   Hospitals API: http://0.0.0.0:${PORT}/hospitals`);
    console.log(
      `   Exotel: Use Cloudflare URLs above for production connections.\n`,
    );
  });
};

// Export the start function so it can be called from the main server
module.exports = { startAgent };

// If this file is run directly (not imported), start the agent server
if (require.main === module) {
  startAgent().catch((err) => {
    console.error("[Agent] Failed to start:", err);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
}
