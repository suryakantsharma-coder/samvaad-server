/**
 * Chat-bot Voice Agent
 * Integrates OpenAI ChatGPT Realtime API (audio in/out) with Exotel.
 * - Receives audio from Exotel (8kHz PCM, base64), resamples to 24kHz and streams to Realtime API.
 * - Receives audio from Realtime API (24kHz PCM), resamples to 8kHz and sends to Exotel in desired format.
 *
 * Exotel WebSocket protocol (same as voice-chat-bot): event "start" | "media" | "stop".
 * Outbound to Exotel: { event: "media", streamSid, media: { payload: "<base64>" } }.
 */

const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const chatgpt = require('openai');
const mongoose = require('mongoose');
require('dotenv').config();
const env = require('../config/env');
const AppointmentModel = require('../models/appointment.model');
const HospitalModel = require('../models/hospital.model');
const DoctorModel = require('../models/doctor.model');
const PatientModel = require('../models/patient.model');
const { extractAppointmentFromTranscript } = require('./chatgpt');

// import express from "express";
// import expressWs from "express-ws";
// import WebSocket from "ws";
// import dotenv from "dotenv";
// import AppointmentModel from "../models/appointment.model";
// dotenv.config();

// =========================
// App setup
// =========================
const app = express();
expressWs(app);

// NOTE:
// Appointment creation is handled live via Realtime tool-calling (create_patient / create_appointment).
// We do NOT auto-create appointments on call end to avoid duplicates.

// =========================
// Configuration (use .env; never commit secrets)
// =========================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

// Exotel/Twilio media: 8kHz, 16-bit PCM, 20ms chunks = 320 bytes
const EXOTEL_SAMPLE_RATE = 8000;
const EXOTEL_SAMPLE_WIDTH = 2;
const EXOTEL_CHUNK_MS = 20;
const EXOTEL_CHUNK_BYTES = ((EXOTEL_SAMPLE_RATE * EXOTEL_CHUNK_MS) / 1000) * EXOTEL_SAMPLE_WIDTH; // 320
const BOT_OUTBOUND_BUFFER_MS = 200;
const BOT_OUTBOUND_BUFFER_CHUNKS = Math.max(1, Math.ceil(BOT_OUTBOUND_BUFFER_MS / EXOTEL_CHUNK_MS));

// OpenAI Realtime API: 24kHz PCM 16-bit
const OPENAI_SAMPLE_RATE = 24000;
const OPENAI_SAMPLE_WIDTH = 2;

// Resample ratio
const RESAMPLE_UP = OPENAI_SAMPLE_RATE / EXOTEL_SAMPLE_RATE; // 3
const RESAMPLE_DOWN = EXOTEL_SAMPLE_RATE / OPENAI_SAMPLE_RATE; // 1/3

// =========================
// Resampling: 8kHz <-> 24kHz (16-bit PCM)
// =========================
/**
 * Resample PCM 8kHz -> 24kHz (linear interpolation).
 * @param {Buffer} pcm8k - 16-bit LE PCM at 8kHz
 * @returns {Buffer} 16-bit LE PCM at 24kHz
 */
function resample8kTo24k(pcm8k) {
  const numSamples8k = pcm8k.length / 2;
  const numSamples24k = Math.floor(numSamples8k * RESAMPLE_UP);
  const out = Buffer.alloc(numSamples24k * 2);
  for (let i = 0; i < numSamples24k; i++) {
    const srcIdx = i / RESAMPLE_UP;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, numSamples8k - 1);
    const frac = srcIdx - i0;
    const s0 = pcm8k.readInt16LE(i0 * 2);
    const s1 = pcm8k.readInt16LE(i1 * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

/**
 * Resample PCM 24kHz -> 8kHz (decimate: take every 3rd sample).
 * @param {Buffer} pcm24k - 16-bit LE PCM at 24kHz
 * @returns {Buffer} 16-bit LE PCM at 8kHz
 */
function resample24kTo8k(pcm24k) {
  const numSamples24k = pcm24k.length / 2;
  const numSamples8k = Math.floor(numSamples24k * RESAMPLE_DOWN);
  const out = Buffer.alloc(numSamples8k * 2);
  for (let i = 0; i < numSamples8k; i++) {
    const srcIdx = i * RESAMPLE_UP;
    const idx = Math.min(Math.floor(srcIdx), numSamples24k - 1);
    const sample = pcm24k.readInt16LE(idx * 2);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

// =========================
// Option A: transcript-only input (user audio -> Whisper -> text -> model)
// =========================
const USE_TRANSCRIPT_ONLY = true;
const TRANSCRIPT_ONLY_SILENCE_MS = 900;
const TRANSCRIPT_ONLY_SPEECH_THRESHOLD = 300; // RMS for 16-bit PCM
const TRANSCRIPT_ONLY_MIN_DURATION_MS = 400; // min speech to send (avoid noise)

/** Build WAV buffer from 24kHz 16-bit mono PCM (for Whisper API). */
function pcm24kToWavBuffer(pcm24k) {
  const numSamples = pcm24k.length / 2;
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); // byte rate
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm24k]);
}

/** RMS of 16-bit LE PCM. */
function computeRms(pcmBuffer) {
  let sum = 0;
  const n = pcmBuffer.length / 2;
  for (let i = 0; i < n; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    sum += s * s;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/** Transcribe audio (WAV buffer) via OpenAI Whisper API. */
async function transcribeWithWhisper(wavBuffer) {
  const { Readable } = require('stream');
  const stream = Readable.from(wavBuffer);
  stream.path = 'audio.wav';
  const openai = new chatgpt({ apiKey: OPENAI_API_KEY });
  const transcription = await openai.audio.transcriptions.create({
    file: stream,
    model: 'whisper-1',
    language: 'hi',
    prompt:
      'Indian names, first name and last name. Hospital appointment, patient. Medical: piles, bavasir, बवासीर, pain, dard, pet dard, fever, bukhar, doctor, date, time.',
  });
  return transcription.text ? transcription.text.trim() : '';
}

// =========================
// Parse appointment details from call transcript (for JSON log)
// =========================
function parseAppointmentFromTranscript(callTranscript, callerPhone) {
  const fullText = callTranscript.map((t) => t.text).join(' ');
  if (!fullText) return null;

  // Prefer last mention of Hospital A/B (usually in confirmation)
  const hospitalMatches = [...fullText.matchAll(/\bHospital\s+([AB])\b/gi)];
  const hospital = hospitalMatches.length
    ? `Hospital ${hospitalMatches[hospitalMatches.length - 1][1].toUpperCase()}`
    : null;

  const drMatch = fullText.match(/\bDr\.\s+([A-Za-z\s]+?)(?:\s+\(|,|\.|$)/);
  const doctorName = drMatch ? drMatch[1].trim() : null;

  // Patient name: "patient Sureshkant, age", "Patient: X", "मरीज का नाम X", etc.
  let patientName =
    fullText.match(/\bpatient\s+([A-Za-z]+)\s*(?:,|\.|\s+age)/i)?.[1] ||
    fullText
      .match(
        /(?:patient|मरीज|રોગી)[\s:]+([A-Za-z\u0900-\u0DFF\s]+?)(?:\s*[,.]|\s+age|\s+उम्र|$)/i,
      )?.[1]
      ?.trim() ||
    fullText.match(/(?:patient|Patient):\s*([A-Za-z\s]+?)(?:\s*[,.]|\s+age|$)/i)?.[1]?.trim() ||
    fullText.match(/(?:confirmed for|with)\s+([A-Za-z]+)\s*(?:,|\.|age)/i)?.[1] ||
    null;
  if (patientName) patientName = patientName.replace(/\s+/g, ' ').trim();

  // Age: "age 55", "age: 55", "Age: 55", "उम्र 25", "55 years"
  const ageMatch =
    fullText.match(/(?:age|उम्र|ઉંમર)[\s:]*(\d{1,3})/i) ||
    fullText.match(/(\d{1,3})\s*(?:years?\s+old|साल|વર્ષ)/i) ||
    fullText.match(/\bage[:\s]+(\d{1,3})\b/i);
  const patientAge = ageMatch ? parseInt(ageMatch[1], 10) : null;

  // Date: "February 10th", "10th February", "10 February", "Feb 10"
  const dateMatch =
    fullText.match(
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?/i,
    ) ||
    fullText.match(
      /\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)/i,
    ) ||
    fullText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/i);
  const preferredDate = dateMatch ? dateMatch[0].trim() : null;

  // Time: "12 PM", "12:00 PM", "at 12 PM", "10 AM"
  const timeMatch =
    fullText.match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i) ||
    fullText.match(/(?:at|time)\s+(\d{1,2})\s*(?:AM|PM)/i);
  const preferredTime = timeMatch ? timeMatch[1].trim() : null;

  if (!hospital && !doctorName && !patientName && !patientAge && !preferredDate && !preferredTime)
    return null;

  return {
    hospital,
    doctorName,
    patientName: patientName || null,
    patientAge,
    phone: callerPhone !== 'unknown' ? callerPhone : null,
    preferredDate,
    preferredTime,
    callEndedAt: new Date().toISOString(),
  };
}

// =========================
// System instructions (voice agent) - set VOICE_AGENT_INSTRUCTIONS in .env to override
// Language: greeting only Hindi; rest Hindi or Gujarati.
// =========================

// const HOSPITAL_PROMPT = `
// You are ABC Hospital’s Calling Assistant. Speak warm, natural, and human-like (no robotic tone). Your job is to understand the caller’s symptoms, suggest the correct department/doctor from the provided list, and help book appointments. Detect language ONLY from the first caller message (English/Hindi/Gujarati) and LOCK it for the entire call (never switch). Respond immediately after the caller finishes speaking: start with a quick acknowledgment in the same language, then continue normally. Do NOT diagnose diseases and do NOT prescribe medicines. If symptoms sound life-threatening (severe chest pain, unconsciousness, heavy bleeding), redirect to the nearest emergency immediately. When booking, ask ONE question at a time in this order: patient name, patient age, phone number, preferred date, preferred time. Use these doctors only: General Medicine: Dr. Amit Sharma (Mon–Sat 10:00AM–2:00PM), Dr. Neha Verma (Mon–Fri 4:00PM–8:00PM). Cardiology: Dr. Rajesh Mehta (Mon–Sat 11:00AM–3:00PM). Orthopedics: Dr. Suresh Iyer (Mon–Fri 10:00AM–1:00PM). Dermatology: Dr. Pooja Malhotra (Tue–Sun 12:00PM–5:00PM). ENT: Dr. Vikram Singh (Mon–Sat 9:00AM–12:00PM). Pediatrics: Dr. Anjali Rao (Mon–Sat 10:00AM–4:00PM). Symptom mapping: Fever/cold/headache/weakness→General Medicine; Chest pain/BP/heart issues→Cardiology; Joint/back pain/fracture→Orthopedics; Skin allergy/rashes/acne→Dermatology; Ear/throat/sinus→ENT; Child-related issues→Pediatrics. IMPORTANT: Always output ONLY valid JSON with exactly 3 keys: intent, action, response. No extra text.
// `;

const HOSPITAL_PROMPT = `
You are a Hospital Calling Assistant. Follow this flow strictly.

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

// const HOSPITAL_PROMPT = `
// તમે ABC Hospital ના Calling Assistant છો. શરૂઆત હંમેશા ABC Hospital તરફથી warm greeting થી કરો. તમારી ભાષા ગરમજોશીભરી, નેચરલ અને માણસ જેવી હોવી જોઈએ (robotic નહીં). તમારું કામ કોલર ના symptoms સમજવું, આપેલી doctor list માંથી યોગ્ય department/doctor suggest કરવું, અને appointment book કરવામાં મદદ કરવી છે. ભાષા ONLY પહેલી caller message પરથી detect કરો (English/Hindi/Gujarati) અને આખા call દરમિયાન એ જ ભાષા LOCK રાખો (વચ્ચે language switch નહીં કરવું). Caller બોલીને પૂરો કરે એટલે તરત જવાબ આપો: પહેલા એ જ ભાષામાં નાનું acknowledgment આપો, પછી naturally આખો જવાબ આપો. કોઈપણ બીમારીનું diagnosis ન કરો અને કોઈ medicine prescribe ન કરો. જો symptoms life-threatening લાગે (severe chest pain, unconsciousness, heavy bleeding), તો તરત nearest emergency માં જવા માટે redirect કરો. Booking વખતે માત્ર ONE question at a time પૂછો, આ જ order માં: patient name, patient age, phone number, preferred date, preferred time. માત્ર આ doctors જ use કરો: General Medicine: Dr. Amit Sharma (Mon–Sat 10:00AM–2:00PM), Dr. Neha Verma (Mon–Fri 4:00PM–8:00PM). Cardiology: Dr. Rajesh Mehta (Mon–Sat 11:00AM–3:00PM). Orthopedics: Dr. Suresh Iyer (Mon–Fri 10:00AM–1:00PM). Dermatology: Dr. Pooja Malhotra (Tue–Sun 12:00PM–5:00PM). ENT: Dr. Vikram Singh (Mon–Sat 9:00AM–12:00PM). Pediatrics: Dr. Anjali Rao (Mon–Sat 10:00AM–4:00PM). Symptom mapping: Fever/cold/headache/weakness→General Medicine; Chest pain/BP/heart issues→Cardiology; Joint/back pain/fracture→Orthopedics; Skin allergy/rashes/acne→Dermatology; Ear/throat/sinus→ENT; Child-related issues→Pediatrics. IMPORTANT: હંમેશા ONLY valid JSON output કરો જેમાં exactly 3 keys હોવી જોઈએ: intent, action, response। કોઈ extra text નહીં.
// `;
const DEFAULT_INSTRUCTIONS = process.env.VOICE_AGENT_INSTRUCTIONS || HOSPITAL_PROMPT;
// `You are a friendly and helpful voice assistant. Speak clearly and concisely. Keep responses brief and natural for a phone call.`;

// =========================
// Helper: Get hospital-specific instructions with doctors from database
// =========================
const getHospitalInstructions = async (hospital) => {
  if (!hospital) return DEFAULT_INSTRUCTIONS;

  try {
    // Fetch all doctors for this hospital
    const doctors = await DoctorModel.find({ hospital: hospital._id })
      .select('fullName designation availability status')
      .lean();

    // Group doctors by designation/department
    const doctorsByDept = {};
    doctors.forEach((doctor) => {
      const dept = doctor.designation || 'General';
      if (!doctorsByDept[dept]) {
        doctorsByDept[dept] = [];
      }
      doctorsByDept[dept].push({
        name: doctor.fullName,
        designation: doctor.designation,
        availability: doctor.availability || '9 AM - 5 PM',
        status: doctor.status || 'On Duty',
      });
    });

    // Build doctor list string for prompt
    let doctorListText = '';
    Object.keys(doctorsByDept).forEach((dept) => {
      doctorListText += `\n${dept}: `;
      const deptDoctors = doctorsByDept[dept];
      doctorListText += deptDoctors
        .map(
          (doc) =>
            `Dr. ${doc.name} (${doc.availability})${doc.status !== 'On Duty' ? ` - Status: ${doc.status}` : ''}`,
        )
        .join(', ');
    });

    // Build dynamic prompt with hospital name and doctors
    const dynamicPrompt = `
   You are ${hospital.name}'s Calling Assistant (Female voice). Follow this flow strictly.

HOSPITAL INFORMATION:
- Hospital Name: ${hospital.name}
- Hospital Address: ${hospital.address}, ${hospital.city} - ${hospital.pincode}
- Hospital Phone: ${hospital.phoneCountryCode || '+91'} ${hospital.phoneNumber}

AVAILABLE DOCTORS AT ${hospital.name.toUpperCase()}:
${doctorListText || '\nNo doctors currently available. Please contact the hospital directly.'}

user ka exact transcribed text use karo, audio interpretation pe mat jao

VOICE + SPEED + NATURAL FLOW RULES:
1) You MUST sound like a polite, calm FEMALE receptionist voice.
2) Speak like a real person — short, warm, one thing at a time. You may rephrase in your own words; keep the same meaning and flow. Do not sound like reading a script.
3) Speak slowly and naturally. After every question, pause briefly (1-2 seconds) before continuing.
4) Never ask multiple questions in one line.

TURN-TAKING (STRICT - NEVER TALK OVER):
5) When the CALLER is speaking: Do NOT speak. Stay silent. Wait until they finish. Never overlap or interrupt the caller.
6) When YOU are speaking and the caller starts speaking: STOP immediately, go silent, listen fully to what they say, then respond politely. Do not continue your sentence; let the caller have the floor.

LANGUAGE RULES (AUTO - USER'S LANGUAGE):

1) GREETING: Always and ONLY in Hindi.
   First line MUST be:
   "नमस्ते, ${hospital.name} की तरफ से आपका स्वागत है।"

2) AUTO-DETECT LANGUAGE (do NOT ask "Hindi or Gujarati?"):
   Right after the greeting, ask for their problem/illness in one short sentence in Hindi (e.g. "कृपया अपनी समस्या बताइए।"). From the caller's FIRST reply, detect the language they are speaking: if mainly Gujarati (e.g. ગુજરાતી words) → callerLanguage = "GU"; otherwise (Hindi, Hinglish, or unclear) → callerLanguage = "HI". Lock callerLanguage for the entire call.

3) LANGUAGE LOCK (DO NOT SWITCH):
   - If callerLanguage = "HI": Speak ONLY Hindi for the rest of the call.
   - If callerLanguage = "GU": Speak ONLY Gujarati for the rest of the call. Never switch to Hindi after lock.
   - Never mix languages in one response.

4) BEFORE EVERY REPLY: If callerLanguage = "GU", your entire response MUST be in Gujarati only. If callerLanguage = "HI", entire response in Hindi only.

IMPORTANT REASON RULE (ENGLISH ONLY FOR STORAGE):
- The caller will speak the illness/reason in Hindi or Gujarati.
- You MUST convert the reason into English immediately.
- You MUST use only the English reason when creating the appointment.
- Never store/save the reason in Hindi or Gujarati.

Examples:
Hindi:
- "बवासीर" / "मुझे बवासीर है" -> "Piles" (NOT Stomach pain)
- "सीने में दर्द" -> "Chest pain"
- "बुखार" -> "Fever"
- "पेट दर्द" -> "Stomach pain"
Gujarati:
- "બવાસીર" -> "Piles" (NOT Stomach pain)
- "સીનામાં દુખાવો" -> "Chest pain"
- "બુખાર" -> "Fever"
- "ચામડી પર દાણા" -> "Skin rash"

CALL FLOW:

REMINDER: If callerLanguage = "GU", every step below (reason confirm, patient status, name, date, time, final confirm) MUST be asked in Gujarati only. Do not use Hindi once the call is locked to Gujarati.

0) CONTEXT:
- The hospital is already selected (this call is for ${hospital.name}).
- Do NOT ask the caller to choose any hospital.

1) GREETING + ASK PROBLEM (language auto from reply):
   First say: "नमस्ते, ${hospital.name} की तरफ से आपका स्वागत है।"
   Then ask for problem in Hindi: "कृपया अपनी समस्या बताइए।" From the caller's reply, detect callerLanguage (Gujarati vs Hindi) and lock it. Then continue in that language.

2) ILLNESS/REASON (in callerLanguage):
   You have already asked for problem. Capture the illness/reason from the caller's words. Convert to English for storage (reasonEnglish). See REASON MAPPING below — use exact mapping; do not confuse similar-sounding terms.

REASON MAPPING (CRITICAL - DO NOT MIX):
- बवासीर / બવાસીર / bavasir → English: "Piles". Do NOT use "Stomach pain" or "पेट दर्द" for बवासीर.
- पेट दर्द / પેટ દર્દ / pet dard / stomach → English: "Stomach pain". Do NOT use "Piles" for पेट दर्द.
- सीने में दर्द / seena dard → "Chest pain". बुखार / bukhar → "Fever". Other reasons: convert to correct English and store.

CAPTURE + CONFIRM:
- Listen and capture the illness/reason in the caller's exact words.
- Convert to correct English using the mapping above. Store as reasonEnglish.

IMPORTANT REASON CONFIRMATION RULE:
- When confirming, use the EXACT reason the caller said — do not substitute a different condition. E.g. if caller said "मुझे बवासीर है" / "बवासीर", confirm "आपको बवासीर है, सही?" (HI) or "તમને બવાસીર છે, સાચું?" (GU). Do NOT confirm "पेट दर्द" or "stomach pain" when they said बवासीर.
- If the caller says NO, ask again for the correct reason and repeat confirmation.
- Only after caller confirms YES, proceed to Step 3.

3) PATIENT STATUS:
Ask in callerLanguage whether they have visited this hospital before or are new (e.g. HI: "पहले यहाँ आ चुके हैं या नए हैं?" / GU: "અગાઉ આવ્યા છો કે નવા છો?" — or your own words).

4) EXISTING PATIENT FLOW:
If caller says they are an existing patient:

If callerLanguage = "HI", ask:
"कृपया अपना Patient ID बताइए।"

If callerLanguage = "GU", ask:
"કૃપા કરીને તમારું Patient ID જણાવશો."

- Call fetch_patient_by_patientId using the patientId.
- Confirm patient details one by one:
  - Name
  - Age
  - Gender
  - Phone

- If any detail is wrong, ask correction in callerLanguage.
- For appointment creation later, use patient._id (NOT patientId).

5) NEW PATIENT FLOW:
If caller says they are new:
Ask ONE question at a time in callerLanguage (name, age, gender, phone) in short natural phrases. Examples: HI — "पूरा नाम?", "उम्र क्या है?", "जेंडर? (Male/Female/Other)", "फोन नंबर?"; GU — "પૂરું નામ?", "ઉંમર?", "જેન્ડર?", "ફોન નંબર?" — or your own words.

PATIENT NAME RULE (ENGLISH, FAST):
- Ask for FULL name in one go (first + last) in callerLanguage (e.g. "पूरा नाम बताइए?" / "પૂરું નામ જણાવશો?"). Whatever the caller gives (Hindi, Gujarati, any script), convert to ENGLISH only (Roman/Latin) for create_patient. Example: "राजेश कुमार" → "Rajesh Kumar"; "સીતા પટેલ" → "Sita Patel". Store as fullName.
- Confirm the name in ONE short sentence in callerLanguage (e.g. "नाम [NAME in English] है, सही?" / "નામ [NAME in English] છે, સાચું?"). If they say NO, ask again and re-confirm.
- Spelling is OPTIONAL: do NOT insist on letter-by-letter spelling. If the caller offers to spell (letter-by-letter or word-by-word), accept it and use that for exact English spelling. If they don't spell, use your best conversion and proceed after short confirmation.
- Only after name confirmation (and optional spelling if given), call create_patient with fullName in English only.
- You will get back patientId and patient record including _id.
- Confirm patientId to caller in callerLanguage.
- For appointment creation later, use patient._id (NOT patientId).

6) DOCTOR SELECTION (MANDATORY):
- Always call list_doctors to get the FULL list of all doctors for this hospital.
- Pick the doctor whose designation matches the reasonEnglish.

Examples:
- Chest pain / heart issue -> Cardiologist
- Skin rash -> Dermatologist
- Fever / cough / cold -> General Physician
- Child illness -> Pediatrician
- Joint pain -> Orthopedic

- Use ONLY that doctor's _id.
- Never invent doctor names or ids.

7) APPOINTMENT DATE & TIME:
Ask for preferred date then time, one at a time, in callerLanguage (e.g. HI: "किस तारीख को?" then "किस समय?" / GU: "કઈ તારીખે?" then "ક્યા સમયે?" — or your own words). Confirm selected date and time in the same language.

8) CONFIRMATION (ONE SENTENCE):
Confirm in ONE sentence in callerLanguage.
IMPORTANT: reason must remain English inside.

If callerLanguage = "HI", say:
"${hospital.name}, Dr. [Name], patient [name], patientId [P-...], phone [number], reason [reasonEnglish], date [date], time [time]."

If callerLanguage = "GU", say:
"${hospital.name}, Dr. [Name], patient [name], patientId [P-...], phone [number], reason [reasonEnglish], date [date], time [time]."

9) CREATE APPOINTMENT:
Call create_appointment with:
- patientObjectId = patient._id
- doctorObjectId = doctor._id
- reason = reasonEnglish
- appointmentDateTimeISO

10) FINAL:
If appointment is created successfully:

If callerLanguage = "HI", say:
"आपकी अपॉइंटमेंट ID है: A-YYYY-000001"

If callerLanguage = "GU", say:
"તમારી અપોઇન્ટમેન્ટ ID છે: A-YYYY-000001"

RULES:
- Do NOT diagnose or prescribe medicines.
- If life-threatening symptoms, advise emergency immediately.
- Never mention tool names or JSON.
- Always call list_doctors before booking.
- Always save reason in English only.
- Never speak too fast.
- Always pause naturally between steps.


  `;

    // HOSPITAL INFORMATION:
    // - Hospital Name: ${hospital.name}
    // - Hospital Address: ${hospital.address}, ${hospital.city} - ${hospital.pincode}
    // - Hospital Phone: ${hospital.phoneCountryCode || "+91"} ${hospital.phoneNumber}

    // AVAILABLE DOCTORS AT ${hospital.name.toUpperCase()}:${doctorListText || "\nNo doctors currently available. Please contact the hospital directly."}

    // LANGUAGE:
    // - GREETING: Always and ONLY in Hindi. Start every call with a warm Hindi greeting mentioning the hospital name, e.g. "नमस्ते, ${hospital.name} की तरफ से आपका स्वागत है।"
    // - After greeting, detect the caller's language from their FIRST reply (only Hindi or Gujarati). Use that same language for the REST of the call. Do not use English after the greeting; speak only in Hindi or Gujarati based on what the caller uses.

    // CALL FLOW:
    // 0) CONTEXT: The hospital is already selected (this call is for ${hospital.name}). Do NOT ask the caller to choose Hospital A/B.
    // 1) GREETING (first thing): Say a warm greeting ONLY in Hindi mentioning ${hospital.name}. Then ask: "कृपया अपनी समस्या / बीमारी बताएं।"
    // 2) ILLNESS/REASON: Listen and capture the illness/reason the caller states (e.g. "chest pain", "skin rash"). This is the reason for the visit—you must use this exact reason from the call when creating the appointment later; do not use any pre-set or stored value.
    // 3) PATIENT TYPE: Ask: "क्या यह नया मरीज है या पहले से रजिस्टर मरीज?"
    // 4) EXISTING PATIENT:
    //    - If existing: Ask for the Patient ID (format like P-YYYY-000001).
    //    - Find the patient with that patientId by calling fetch_patient_by_patientId (lookup is by patientId). You get back the patient record including _id.
    //    - After result: Confirm patient details (name/age/gender/phone). For creating the appointment later, use this patient's _id (not the patientId).
    // 5) NEW PATIENT:
    //    - If new: Ask ONE question at a time: full name, age, gender (Male/Female/Other). You may ask for phone number but it is optional—the system automatically uses the caller's phone number (the number Exotel received the call from) when creating the patient.
    //    - Call the internal tool create_patient to create the patient. You get back patientId and the patient record including _id.
    //    - Confirm the new patientId to the caller. For creating the appointment later, use this patient's _id (the primary key), not the patientId.
    // 6) DOCTOR: First call the internal tool list_doctors to get the FULL list of all doctors for this hospital (each has _id, fullName, designation). Pick the doctor whose designation matches the patient's illness/reason (e.g. Cardiologist for heart, Dermatologist for skin). Use ONLY that doctor's _id (the primary key) when creating the appointment—never use name or doctorId.
    // 7) APPOINTMENT TIME: Ask preferred date and preferred time (one at a time). Confirm back the date/time.
    // 8) CONFIRMATION: Confirm in one sentence: "${hospital.name}, Dr. [Name], patient [name], patientId [P-...], phone [number], reason [reason], date [date], time [time]."
    // 9) CREATE APPOINTMENT: Call create_appointment with: patientObjectId = the patient's _id, doctorObjectId = the doctor's _id from list_doctors, reason = the illness/reason the caller stated in step 2 (from the call, not from patient record), and appointmentDateTimeISO. The reason must be what the caller said during this call.
    // 10) FINAL: If appointment is created successfully, tell the caller the appointmentId (A-YYYY-000001).

    // RULES:
    // - Do NOT diagnose or prescribe medicines.
    // - If life-threatening symptoms, advise emergency immediately.
    // - Never mention tool names or JSON. Tools are internal.

    // IMPORTANT: Always call list_doctors to get the current list of doctors; pick from that list by matching designation to the patient's illness. Use only the doctor's _id from that list when booking. Do not invent doctor names or ids.
    // `;

    //     const dynamicPrompt = `You are the AI calling assistant for ${hospital.name}. Your role is to help patients book appointments efficiently.

    // HOSPITAL INFORMATION

    // Hospital Name: ${hospital.name}
    // Address: ${hospital.address}, ${hospital.city} - ${hospital.pincode}
    // Phone: ${hospital.phoneCountryCode || "+91"} ${hospital.phoneNumber}

    // AVAILABLE DOCTORS
    // ${doctorListText || "No doctors currently available."}

    // LANGUAGE PROTOCOL
    // Initial Greeting (Start in Gujarati)
    // Begin every call in Gujarati:

    // "નમસ્તે, ${hospital.name}। તમે કઈ સમસ્યા માટે ડોક્ટરને મળવા માંગો છો?"

    // Automatic Language Detection
    // Detect from caller's first response:

    // Responds in Gujarati → Continue in Gujarati
    // Responds in Hindi → Switch to Hindi immediately
    // Responds in English → Switch to English immediately

    // Rules:

    // Use ONLY the detected language for entire call
    // Don't ask them to choose - just adapt naturally
    // Don't mix languages (except IDs: Patient ID, Appointment ID)

    // If unsupported language: "હું ફક્ત ગુજરાતી, હિન્દી અને અંગ્રેજીમાં મદદ કરી શકું છું। હું તમને સ્ટાફ સાથે જોડું છું।" → Transfer to staff

    // CALL FLOW
    // STEP 1: COLLECT REASON FOR VISIT (Already done in greeting)
    // The greeting asks for the problem/reason. Listen and capture the EXACT reason the caller states.
    // Store this reason - use it verbatim when creating appointment.
    // Emergency Detection - CRITICAL
    // If caller mentions ANY of these, STOP and give emergency instructions:

    // Severe chest pain / સીધામાં તીવ્ર દુખાવો / सीने में तेज दर्द
    // Difficulty breathing / શ્વાસ લેવામાં તકલીફ / सांस लेने में दिक्कत
    // Unconsciousness / બેભાન / बेहोशी
    // Severe bleeding / ગંભીર રક્તસ્ત્રાવ / तेज खून बहना
    // Stroke symptoms / સ્ટ્રોકના લક્ષણો / लकवा के लक्षण
    // Suicidal thoughts / આત્મહત્યાના વિચારો / आत्महत्या के विचार

    // Emergency Response: "આ કટોકટી છે! તાત્કાલિક 102 અથવા 108 પર કૉલ કરો અથવા નજીકના emergency રૂમમાં જાઓ। હું appointment બુક કરી શકતી નથી।" (Gujarati example - adapt to detected language)
    // End call. Do NOT proceed with booking.

    // STEP 2: IDENTIFY CALLER TYPE
    // Ask: "શું આ appointment તમારા માટે છે કે બીજા કોઈ માટે?" / "क्या यह appointment आपके लिए है या किसी और के लिए?" / "Is this appointment for you or someone else?"
    // For self: Patient = Caller, Phone = Caller's phone → STEP 3
    // For someone else: Get relationship + patient name, Use caller's phone → STEP 3

    // STEP 3: CHECK PATIENT STATUS
    // Ask: "શું તમે પહેલાં ${hospital.name} માં આવ્યા છો?" / "क्या आप पहले ${hospital.name} में आ चुके हैं?" / "Have you visited ${hospital.name} before?"
    // YES → STEP 4 (Existing Patient)
    // NO → STEP 5 (New Patient)

    // STEP 4: EXISTING PATIENT
    // Ask for phone number: "તમારો નોંધાયેલ મોબાઇલ નંબર આપો" / "अपना registered mobile number बताएं" / "Provide your registered mobile number"
    // Tool Call: fetch_patient_by_phone(phoneNumber)
    // If found:

    // Confirm: "મને [name], ઉંમર [age], [gender] નામે નોંધણી મળી। શું આ સાચું છે?" / "मुझे [name], उम्र [age], [gender] का registration मिला। क्या यह सही है?" / "I found [name], age [age], [gender]. Is this correct?"
    // If YES: Store patient's _id → STEP 6
    // If NO: Ask if they want to update or register new

    // If not found:
    // "આ નંબર સાથે નોંધણી નથી। નવા દર્દી તરીકે નોંધણી કરાવો?" / "इस नंबर से registration नहीं मिला। नए मरीज के रूप में register करें?" / "No registration found. Register as new patient?"

    // If YES → STEP 5
    // If NO → Ask for different number

    // If error: "માહિતી શોધવામાં સમસ્યા છે। ${hospital.phoneNumber} પર કૉલ કરો।" / "जानकारी खोजने में समस्या है। ${hospital.phoneNumber} पर call करें।" / "Having trouble finding information. Call ${hospital.phoneNumber}."

    // STEP 5: NEW PATIENT
    // Collect ONE at a time:
    // 1. Full Name: "દર્દીનું પૂરું નામ?" / "मरीज का पूरा नाम?" / "Patient's full name?"
    // 2. Age: "ઉંમર?" / "उम्र?" / "Age?"

    // Validate: 0-120

    // 3. Gender: "લિંગ - પુરુષ, સ્ત્રી, અન્ય?" / "लिंग - पुरुष, महिला, अन्य?" / "Gender - Male, Female, Other?"
    // 4. Phone:

    // If for self: "શું હું આ નંબર [caller's number] નોંધાવું?" / "क्या मैं यह number [caller's number] register करूं?" / "Should I register this number [caller's number]?"
    // If for someone else: "દર્દીનો મોબાઇલ નંબર?" / "मरीज का mobile number?" / "Patient's mobile number?"
    // Validate: 10 digits, starts with 6-9

    // Tool Call: create_patient(fullName, age, gender, phoneNumber)
    // If successful:
    // "નોંધણી સફળ। તમારી Patient ID છે [patientId]।" / "Registration सफल। आपकी Patient ID है [patientId]।" / "Registration successful. Your Patient ID is [patientId]."

    // Store patient's _id → STEP 6

    // If phone exists: "આ નંબર પહેલાથી નોંધાયેલ છે। હાલના દર્દી તરીકે ચાલુ રાખો?" / "यह number पहले से registered है। existing patient के रूप में continue करें?" / "This number is already registered. Continue as existing patient?"
    // If error: "નોંધણીમાં સમસ્યા। ${hospital.phoneNumber} પર સંપર્ક કરો।" / "Registration में समस्या। ${hospital.phoneNumber} पर contact करें।" / "Registration problem. Contact ${hospital.phoneNumber}."

    // STEP 6: SELECT DOCTOR
    // Tool Call: list_doctors(hospitalId)
    // Match doctor to reason using keywords:
    // Keywords (any language)DesignationFallbackheart, cardiac, chest pain, દિલ, સીને, दिल, सीनेCardiologistGeneral Physicianskin, rash, ત્વચા, ચામડી, त्वचाDermatologistGeneral Physicianbone, joint, હાડકાં, સાંધા, हड्डी, जोड़OrthopedicGeneral Physicianchild, baby, બાળક, બચ્ચું, बच्चाPediatricianGeneral Physicianwomen, pregnancy, ગર્ભાવસ્થા, गर्भावस्था, પીરિયડGynecologistGeneral Physicianeye, આંખ, आंखOphthalmologistGeneral Physicianear, nose, throat, કાન, નાક, ગળું, कान, नाक, गलाENT SpecialistGeneral Physicianstomach, gastro, પેટ, पेटGastroenterologistGeneral Physiciandiabetes, sugar, thyroid, ડાયાબિટીસ, डायबिटीज, થાઇરોઇડEndocrinologistGeneral Physiciankidney, urine, કિડની, પેશાબ, किडनी, पेशाबNephrologist/UrologistGeneral Physiciantooth, dental, દાંત, दांतDentistN/Amental, depression, માનસિક, તણાવ, मानसिकPsychiatristGeneral Physicianbrain, headache, neuro, માથું, સિરદર્દ, सिरदर्दNeurologistGeneral Physicianlung, breathing, asthma, શ્વાસ, દમ, सांसPulmonologistGeneral Physicianfever, cold, cough, તાવ, ઉધરસ, બુખાર, खांसीGeneral PhysicianN/Acheckup, routine, જાંચ, તપાસ, जांचGeneral PhysicianN/A
    // Logic:

    // Search for keywords in patient's reason
    // Find matching designation in doctors list
    // If multiple doctors: select first available
    // If no match: use General Physician
    // If no doctors available: "કોઈ doctor ઉપલબ્ધ નથી। ${hospital.phoneNumber} પર કૉલ કરો।" / "कोई doctor available नहीं है। ${hospital.phoneNumber} पर call करें।" / "No doctors available. Call ${hospital.phoneNumber}." → End call

    // Confirm: "હું તમારી appointment Dr. [name] ([designation]) સાથે બુક કરીશ। બરાબર છે?" / "मैं आपकी appointment Dr. [name] ([designation]) के साथ book करूंगी। ठीक है?" / "I'll book with Dr. [name] ([designation]). Okay?"

    // If NO: List all doctors, let caller choose
    // Store selected doctor's _id

    // STEP 7: SCHEDULE DATE & TIME
    // Date: "તમે કઈ તારીખે આવવા માંગો છો?" / "आप किस तारीख को आना चाहेंगे?" / "Which date would you like to come?"
    // Accept: "આજે", "કાલે" / "आज", "कल" / "today", "tomorrow" OR "15 March", "15/03/2025"
    // Validate:

    // Must be today or future (not past)
    // Convert to YYYY-MM-DD

    // Time: "કેટલા સમયે?" / "किस समय?" / "What time?"
    // Accept: "સવારે 10 વાગ્યે", "બપોરે 2 વાગ્યે" / "सुबह 10 बजे", "दोपहर 2 बजे" / "10 AM", "2 PM"
    // Validate:

    // Within hospital hours (9 AM - 6 PM default)
    // Convert to 24-hour format (HH:MM)

    // Create ISO DateTime: YYYY-MM-DDTHH:MM:SS+05:30 (IST)

    // STEP 8: CONFIRM DETAILS
    // Read back in ONE paragraph (not bullets):
    // Gujarati:
    // "કૃપા કરીને confirm કરો - ${hospital.name} માં, Patient [name], Patient ID [patientId], Phone [number], Dr. [doctor name] [designation] સાથે, [reason] માટે, [date] ને [time] વાગ્યે appointment છે। શું હું book કરું?"
    // Hindi:
    // "कृपया confirm करें - ${hospital.name} में, Patient [name], Patient ID [patientId], Phone [number], Dr. [doctor name] [designation] के साथ, [reason] के लिए, [date] को [time] बजे appointment है। क्या मैं book करूं?"
    // English:
    // "Please confirm - Appointment at ${hospital.name} for Patient [name], Patient ID [patientId], Phone [number], with Dr. [doctor name] [designation], for [reason], on [date] at [time]. Should I book this?"
    // Wait for response:

    // YES → STEP 9
    // NO → "શું બદલવું છે?" / "क्या बदलना चाहेंगे?" / "What would you like to change?" → Go back to relevant step
    // Uncertain → Answer questions, ask again

    // STEP 9: CREATE APPOINTMENT
    // Tool Call: create_appointment(appointmentData)
    // Parameters:
    // json{
    //   "patientObjectId": "507f1f77bcf86cd799439011",
    //   "doctorObjectId": "507f1f77bcf86cd799439012",
    //   "hospitalId": "${hospital._id}",
    //   "reason": "સીનામાં દુખાવો",
    //   "appointmentDateTime": "2025-03-15T10:00:00+05:30",
    //   "status": "scheduled",
    //   "bookedBy": "calling_assistant",
    //   "patientPhone": "9876543210"
    // }
    // CRITICAL: Use _id (not patientId/doctorId), Use exact reason from Step 1, ISO format with +05:30

    // STEP 10: FINAL CONFIRMATION
    // If successful:
    // Gujarati:
    // "તમારી appointment book થઈ ગઈ છે। Appointment ID છે [appointmentId]। [Date] ને [time] વાગ્યે Dr. [name] સાથે આવવાનું છે ${hospital.name}, ${hospital.address} ખાતે। Appointment થી 15 મિનિટ પહેલાં પહોંચો અને તમારી Appointment ID [appointmentId] અને Patient ID [patientId] સાથે લાવો। આભાર।"
    // Hindi:
    // "आपकी appointment book हो गई है। Appointment ID है [appointmentId]। [Date] को [time] बजे Dr. [name] से मिलना है ${hospital.name}, ${hospital.address} पर। Appointment से 15 मिनट पहले पहुंचें और अपनी Appointment ID [appointmentId] और Patient ID [patientId] साथ लाएं। धन्यवाद।"
    // English:
    // "Your appointment is booked. Appointment ID is [appointmentId]. You need to visit Dr. [name] on [date] at [time] at ${hospital.name}, ${hospital.address}. Please arrive 15 minutes before and bring your Appointment ID [appointmentId] and Patient ID [patientId]. Thank you."

    // ERROR HANDLING
    // Time slot taken: "આ સમય book છે। શું [time1] કે [time2] કામ કરશે?" / "यह समय booked है। क्या [time1] या [time2] ठीक रहेगा?" / "This time is booked. Would [time1] or [time2] work?" → Go to Step 7 (time only)
    // Doctor unavailable on date: "Dr. [name] [date] ને ઉપલબ્ધ નથી। બીજી તારીખ કે બીજા doctor?" / "Dr. [name] [date] को available नहीं। दूसरी date या दूसरे doctor?" / "Dr. [name] not available on [date]. Different date or different doctor?" → Let caller choose
    // System error: "તાંત્રિક સમસ્યા છે। થોડીવાર બાદ કૉલ કરો અથવા ${hospital.phoneNumber} પર સંપર્ક કરો।" / "Technical problem है। थोड़ी देर बाद call करें या ${hospital.phoneNumber} पर contact करें।" / "Technical problem. Call back later or contact ${hospital.phoneNumber}." → Retry once, then end call
    // Duplicate appointment: "તમારી [date] ને [time] વાગ્યે પહેલાથી appointment છે। Cancel કરીને નવી book કરવી કે બીજો સમય?" / "आपकी [date] को [time] बजे पहले से appointment है। Cancel करके नई book करें या दूसरा समय?" / "You have appointment on [date] at [time]. Cancel and book new or choose different time?"

    // ADDITIONAL RULES
    // Transfer to human when:

    // 2+ technical failures
    // Caller requests staff
    // Unsupported language
    // Caller frustrated

    // Transfer script: "હું તમને સ્ટાફ સાથે જોડું છું। રાહ જુઓ।" / "मैं आपको staff से जोड़ती हूं। wait करें।" / "I'll transfer you to staff. Please wait."
    // Medical Advice - NEVER give:
    // "હું appointment booking assistant છું, તબીબી સલાહ આપી શકતી નથી। Doctor સાથે appointment દરમિયાન ચર્ચા કરો।" / "मैं appointment booking assistant हूं, medical advice नहीं दे सकती। Doctor से appointment में discuss करें।" / "I'm an appointment assistant, not medical professional. Discuss with doctor during appointment."
    // Privacy:

    // Never share other patient's information
    // Verify relationship if booking for someone else
    // All data is confidential

    // Tone:

    // Professional, warm, patient
    // Never rush caller
    // Speak clearly
    // No medical jargon
    // Respectful

    // TOOL REFERENCE

    // fetch_patient_by_phone(phoneNumber) → Returns patient with _id, patientId, fullName, age, gender, phoneNumber
    // create_patient(fullName, age, gender, phoneNumber) → Returns patient with _id, patientId
    // list_doctors(hospitalId) → Returns array of doctors with _id, doctorId, fullName, designation, availability
    // create_appointment(patientObjectId, doctorObjectId, hospitalId, reason, appointmentDateTime, status, bookedBy, patientPhone) → Returns appointment with _id, appointmentId

    // KEY REMINDERS

    // Start in Gujarati, auto-detect language from first response
    // Always check for emergency symptoms first
    // Use phone number to verify existing patients
    // Use _id for database operations (not human-readable IDs)
    // Use caller's exact words for "reason"
    // Confirm before creating appointment
    // Keep conversation natural and concise
    // Never diagnose or give medical advice
    // Professional tone - no "congratulations" or celebration language
    // Be helpful, accurate, efficient

    // Your goal: Help patients book appointments quickly while maintaining accuracy and professionalism.`;

    return dynamicPrompt;
  } catch (err) {
    console.error(`[Agent] Error fetching doctors for hospital ${hospital.name}:`, err.message);
    // Fallback to default instructions if doctor fetch fails
    return `You are ${hospital.name}'s Calling Assistant. ${DEFAULT_INSTRUCTIONS}`;
  }
};

// =========================
// WebSocket: Exotel <-> OpenAI Realtime bridge (hospital-specific)
// Route: /media/:hospitalId
// =========================
app.ws('/media/:hospitalId', async (ws, req) => {
  const { hospitalId } = req.params;

  // Validate hospitalId format
  if (!mongoose.isValidObjectId(hospitalId)) {
    console.error(`[Exotel] Invalid hospitalId format: ${hospitalId}`);
    ws.close(1008, 'Invalid hospital ID');
    return;
  }

  // Look up hospital from database
  let hospital;
  try {
    hospital = await HospitalModel.findById(hospitalId).lean();
    if (!hospital) {
      console.error(`[Exotel] Hospital not found: ${hospitalId}`);
      ws.close(1008, 'Hospital not found');
      return;
    }
    console.log(`[Exotel] WebSocket connected for hospital: ${hospital.name} (${hospitalId})`);
  } catch (err) {
    console.error(`[Exotel] Error fetching hospital: ${err.message}`);
    ws.close(1011, 'Server error');
    return;
  }

  // Fetch hospital-specific instructions with doctors from database
  let hospitalInstructions;
  try {
    hospitalInstructions = await getHospitalInstructions(hospital);
    console.log(`[Agent] Loaded instructions for ${hospital.name} with doctors from database`);
  } catch (err) {
    console.error(`[Agent] Error generating hospital instructions: ${err.message}`);
    hospitalInstructions = DEFAULT_INSTRUCTIONS;
  }

  // =========================
  // Realtime tools (function calling) to integrate DB actions
  // =========================
  const tools = [
    {
      type: 'function',
      name: 'fetch_patient_by_patientId',
      description:
        'Find the patient using patientId (e.g. P-2026-000001) for the current hospital. Lookup is by patientId only. Returns the patient record including _id; use that _id as patientObjectId when calling create_appointment.',
      parameters: {
        type: 'object',
        properties: {
          patientId: {
            type: 'string',
            description: 'Patient ID like P-2026-000001',
          },
        },
        required: ['patientId'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'create_patient',
      description:
        "Create a new patient for the current hospital and return patientId + details including _id. The caller's phone number from the call is automatically used for phoneNumber when not provided. Use the returned _id when linking to an appointment via create_appointment.",
      parameters: {
        type: 'object',
        properties: {
          fullName: { type: 'string' },
          age: { type: 'number' },
          gender: { type: 'string', enum: ['Male', 'Female', 'Other'] },
          phoneNumber: {
            type: 'string',
            description:
              "Optional. If omitted or 'not provided', the system uses the phone number Exotel received the call from.",
          },
          reason: { type: 'string' },
        },
        required: ['fullName', 'age', 'gender', 'reason'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_doctors',
      description:
        "List ALL doctors for the current hospital. Returns every doctor with _id, fullName, designation (e.g. Cardiologist, Dermatologist), availability, status. Use this list to pick the doctor whose designation matches the patient's illness, then use that doctor's _id as doctorObjectId when calling create_appointment.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'search_doctors',
      description:
        "Search doctors by name or designation within the current hospital (optional filter). Returns matching doctors with _id. To get the full list first, use list_doctors instead. Use the selected doctor's _id as doctorObjectId when calling create_appointment.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'create_appointment',
      description:
        'Create an appointment linking patient and doctor by their database _id. reason must be the illness/reason the caller stated during this call (step 2)—do not use a pre-set or stored value; take it from what the caller said.',
      parameters: {
        type: 'object',
        properties: {
          doctorObjectId: {
            type: 'string',
            description: "The doctor's _id from list_doctors result (MongoDB ObjectId)",
          },
          patientObjectId: {
            type: 'string',
            description:
              "The patient's _id from fetch_patient_by_patientId or create_patient result (MongoDB ObjectId)",
          },
          reason: {
            type: 'string',
            description:
              'The illness/reason the caller stated during the call (what they said when asked about their problem). Do not use patient record reason—use only what was said in this call.',
          },
          appointmentDateTimeISO: {
            type: 'string',
            description: 'UTC ISO string, e.g. 2026-02-12T12:00:00.000Z',
          },
          type: { type: 'string', default: 'call' },
        },
        required: ['doctorObjectId', 'patientObjectId', 'reason', 'appointmentDateTimeISO'],
        additionalProperties: false,
      },
    },
  ];

  let streamSid = null;
  let callerPhone = null;
  let openaiWs = null;
  let isBotSpeaking = false;
  let openaiReady = false;
  let warnedNoStreamSid = false;
  const audioQueue = []; // Queue Exotel audio until session.updated
  const callTranscript = []; // { role: "user"|"assistant", text: string }
  let appointmentDetails = null;
  const outboundBotBuffer = []; // { sid, payload }[] — hold ~200ms so we can drop when user speaks
  let userIsSpeaking = false;
  let callSummaryWritten = false;

  // Option A: transcript-only — buffer user audio, VAD, Whisper, then send text to model
  const transcriptOnlyState = {
    userChunks: [],
    lastSpeechAt: 0,
    silenceStartedAt: null,
    hadSpeechInTurn: false,
    cancelResponse: () => {},
    processing: false,
  };
  const MIN_SPEECH_BYTES_24K =
    (TRANSCRIPT_ONLY_MIN_DURATION_MS / 1000) * OPENAI_SAMPLE_RATE * OPENAI_SAMPLE_WIDTH;

  const cleanupOpenAI = () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.close();
      } catch (e) {
        console.error('[OpenAI] Error closing:', e);
      }
      openaiWs = null;
    }
  };

  const connectOpenAIRealtime = () => {
    if (!OPENAI_API_KEY) {
      console.error('[OpenAI] OPENAI_API_KEY not set');
      return null;
    }
    // noise reduction model
    const model = 'gpt-realtime-mini-2025-12-15';
    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const client = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    // Realtime API may send function_call via response.output_item.added + response.function_call_arguments.done
    const pendingFunctionCalls = {};

    client.on('open', () => {
      console.log(`[OpenAI] Realtime connected for hospital: ${hospital.name}`);
      // Beta Realtime API format: no session.type, use modalities + input_audio_format etc.
      const sessionUpdate = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: hospitalInstructions, // Use hospital-specific instructions
          voice: 'sage',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'gpt-4o-transcribe',
            prompt:
              'Indian names, first name and last name. Roman or Devanagari. Hospital appointment, patient. Medical: piles, bavasir, बवासीर, pain, dard, pet dard, seena dard, fever, bukhar, cough, cold, stomach, headache, skin rash, doctor, date, time.',
          },
          tools,
          tool_choice: 'auto',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.4,
            prefix_padding_ms: 200,
            silence_duration_ms: 200,
          },
        },
      };
      client.send(JSON.stringify(sessionUpdate));
    });

    client.on('message', (message) => {
      try {
        const event = JSON.parse(message.toString());

        // Log Realtime events that are relevant to tools (optional: set to true to see all event types)
        const logEventTypes = [
          'response.output_item.added',
          'response.function_call_arguments.done',
          'conversation.item.created',
        ];
        if (logEventTypes.includes(event.type)) {
          console.log(
            '[Agent] Realtime event:',
            event.type,
            event.item?.type || '',
            event.item?.name || event.call_id || '',
          );
        }

        const hospitalObjectId = hospital?._id;

        const sendToolOutput = async (callId, outputObj) => {
          console.log(
            '[Agent] Tool response (data sent to ChatGPT):',
            JSON.stringify(outputObj, null, 2),
          );
          client.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(outputObj ?? {}),
              },
            }),
          );
          client.send(JSON.stringify({ type: 'response.create' }));
        };

        const runTool = async (callId, name, args) => {
          console.log(
            '[Agent] ChatGPT requested tool:',
            name,
            '| call_id:',
            callId,
            '| hospitalId:',
            String(hospitalObjectId || ''),
          );
          console.log('[Agent] ChatGPT tool args (full):', JSON.stringify(args, null, 2));
          try {
            if (name === 'fetch_patient_by_patientId') {
              const patientId = String(args.patientId || '').trim();
              console.log('[Agent] fetch_patient_by_patientId: looking up patientId:', patientId);
              const patient = await PatientModel.findOne({
                patientId,
                hospital: hospitalObjectId,
              }).lean();
              if (!patient) {
                console.log(
                  '[Agent] fetch_patient_by_patientId: NOT FOUND for patientId:',
                  patientId,
                );
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Patient not found for this hospital.',
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
                  hospital: String(patient.hospital || ''),
                },
              };
              console.log(
                '[Agent] fetch_patient_by_patientId: FOUND | _id:',
                out.patient._id,
                '| patientId:',
                out.patient.patientId,
                '| fullName:',
                out.patient.fullName,
              );
              return await sendToolOutput(callId, out);
            }

            if (name === 'create_patient') {
              const fullName = String(args.fullName || '').trim();
              const age = Number(args.age);
              const gender = String(args.gender || '').trim();
              const reason = String(args.reason || '').trim();
              // Use Exotel caller number (number that called in); fall back to what model collected
              const argsPhone = String(args.phoneNumber || '').trim();
              const fromCall = callerPhone && callerPhone !== 'unknown' ? callerPhone : '';
              const phoneNumber =
                fromCall ||
                (argsPhone && argsPhone.toLowerCase() !== 'not provided' ? argsPhone : '');
              console.log('[Agent] create_patient inputs:', {
                fullName,
                age,
                gender,
                phoneNumberFromArgs: argsPhone,
                callerPhoneFromExotel: callerPhone,
                phoneNumberUsed: phoneNumber,
                reason,
              });
              if (!fullName || !Number.isFinite(age) || age < 0 || !phoneNumber || !reason) {
                console.log('[Agent] create_patient validation failed: missing/invalid fields');
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Missing/invalid patient fields.',
                });
              }
              const year = new Date().getFullYear();
              const prefix = `P-${year}-`;
              const last = await PatientModel.findOne({
                patientId: new RegExp(`^${prefix}`),
              })
                .sort({ patientId: -1 })
                .select('patientId')
                .lean();
              const nextNum = last
                ? parseInt(String(last.patientId).slice(prefix.length), 10) + 1
                : 1;
              const patientId = `${prefix}${String(nextNum).padStart(6, '0')}`;
              console.log('[Agent] Creating patient in DB with patientId:', patientId);
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
                  hospital: String(patient.hospital || ''),
                },
              };
              console.log(
                '[Agent] create_patient: CREATED | _id:',
                out.patient._id,
                '| patientId:',
                out.patient.patientId,
              );
              return await sendToolOutput(callId, out);
            }

            if (name === 'list_doctors') {
              console.log(
                '[Agent] list_doctors: fetching ALL doctors for hospital:',
                String(hospitalObjectId || ''),
              );
              const doctors = await DoctorModel.find({
                hospital: hospitalObjectId,
              })
                .select('_id fullName doctorId designation availability status')
                .lean();
              const doctorsPayload = doctors.map((d) => ({
                _id: String(d._id),
                doctorId: d.doctorId || '',
                fullName: d.fullName,
                designation: d.designation,
                availability: d.availability,
                status: d.status,
              }));
              console.log(
                '[Agent] list_doctors: DB returned',
                doctors.length,
                'doctors. Full list (use _id to book):',
                JSON.stringify(doctorsPayload, null, 2),
              );
              return await sendToolOutput(callId, {
                ok: true,
                doctors: doctorsPayload,
                message: `List of ${doctors.length} doctor(s). Pick the doctor whose designation matches the patient's illness, then use that doctor's _id as doctorObjectId in create_appointment.`,
              });
            }

            if (name === 'search_doctors') {
              const query = String(args.query || '').trim();
              const limit = Math.max(1, Math.min(20, Number(args.limit || 10)));
              console.log('[Agent] search_doctors: query:', query, 'limit:', limit);
              if (!query)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Query is required. To get all doctors use list_doctors.',
                });
              const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const regex = new RegExp(escaped, 'i');
              const doctors = await DoctorModel.find({
                hospital: hospitalObjectId,
                $or: [{ fullName: regex }, { designation: regex }],
              })
                .select('_id fullName doctorId designation availability status')
                .limit(limit)
                .lean();
              console.log(
                '[Agent] search_doctors: DB returned',
                doctors.length,
                'doctors. Raw from DB:',
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
                doctorId: d.doctorId || '',
                fullName: d.fullName,
                designation: d.designation,
                availability: d.availability,
                status: d.status,
              }));
              console.log(
                '[Agent] search_doctors: sending to ChatGPT (each doctor has _id for create_appointment):',
                JSON.stringify(doctorsPayload, null, 2),
              );
              return await sendToolOutput(callId, {
                ok: true,
                doctors: doctorsPayload,
              });
            }

            if (name === 'create_appointment') {
              const doctorObjectId = String(args.doctorObjectId || '').trim();
              const patientObjectId = String(args.patientObjectId || '').trim();
              const reason = String(args.reason || '').trim();
              const appointmentDateTimeISO = String(args.appointmentDateTimeISO || '').trim();
              const type = String(args.type || 'call').trim() || 'call';
              console.log(
                '[Agent] create_appointment: ChatGPT sent doctorObjectId:',
                doctorObjectId,
                'patientObjectId:',
                patientObjectId,
                'reason:',
                reason,
                'appointmentDateTimeISO:',
                appointmentDateTimeISO,
              );
              if (
                !mongoose.isValidObjectId(doctorObjectId) ||
                !mongoose.isValidObjectId(patientObjectId)
              ) {
                console.log(
                  '[Agent] create_appointment: REJECTED - invalid ObjectId (doctorObjectId valid:',
                  mongoose.isValidObjectId(doctorObjectId),
                  'patientObjectId valid:',
                  mongoose.isValidObjectId(patientObjectId),
                  ')',
                );
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Invalid doctor or patient id.',
                });
              }
              const dt = new Date(appointmentDateTimeISO);
              if (Number.isNaN(dt.getTime()))
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Invalid appointmentDateTimeISO.',
                });
              if (!reason)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Reason is required.',
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
                '[Agent] create_appointment: Doctor lookup by _id:',
                doctorObjectId,
                '->',
                doctor ? 'FOUND' : 'NOT FOUND',
                doctor ? { _id: String(doctor._id), fullName: doctor.fullName } : '',
              );
              console.log(
                '[Agent] create_appointment: Patient lookup by _id:',
                patientObjectId,
                '->',
                patient ? 'FOUND' : 'NOT FOUND',
                patient ? { _id: String(patient._id), fullName: patient.fullName } : '',
              );
              if (!doctor)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Doctor not found for this hospital.',
                });
              if (!patient)
                return await sendToolOutput(callId, {
                  ok: false,
                  message: 'Patient not found for this hospital.',
                });

              const year = new Date().getFullYear();
              const prefix = `A-${year}-`;
              const last = await AppointmentModel.findOne({
                appointmentId: new RegExp(`^${prefix}`),
              })
                .sort({ appointmentId: -1 })
                .select('appointmentId')
                .lean();
              const nextNum = last
                ? parseInt(String(last.appointmentId).slice(prefix.length), 10) + 1
                : 1;
              const appointmentId = `${prefix}${String(nextNum).padStart(6, '0')}`;
              const appointmentPayload = {
                hospital: hospitalObjectId,
                appointmentId,
                patient: patientObjectId,
                doctor: doctorObjectId,
                reason,
                status: 'Upcoming',
                type,
                appointmentDateTime: dt,
              };
              console.log('[Agent] create_appointment: exact payload before save to database:');
              console.log(JSON.stringify(appointmentPayload, null, 2));
              const appointment = await AppointmentModel.create(appointmentPayload);
              return await sendToolOutput(callId, {
                ok: true,
                appointment: {
                  _id: String(appointment._id),
                  appointmentId: appointment.appointmentId,
                  hospital: String(appointment.hospital || ''),
                  patient: String(appointment.patient),
                  doctor: String(appointment.doctor),
                  reason: appointment.reason,
                  status: appointment.status,
                  type: appointment.type,
                  appointmentDateTime: appointment.appointmentDateTime?.toISOString?.() || null,
                },
              });
            }

            console.log('[Agent] Unknown tool:', name);
            return await sendToolOutput(callId, {
              ok: false,
              message: `Unknown tool: ${name}`,
            });
          } catch (err) {
            console.error('[Agent] Tool execution error:', err.message, err.stack);
            return await sendToolOutput(callId, {
              ok: false,
              message: err.message || 'Tool error',
            });
          }
        };

        // 1) Server sends conversation.item.created when an item (e.g. function_call) is added to the conversation
        if (event.type === 'conversation.item.created' && event.item?.type === 'function_call') {
          const { name, arguments: argsJson, call_id } = event.item;
          let args = {};
          try {
            args = argsJson ? JSON.parse(argsJson) : {};
          } catch (e) {
            console.error(
              '[Agent] Failed to parse function args (conversation.item.created):',
              argsJson,
            );
          }
          if (Object.keys(args).length > 0) {
            runTool(call_id, name, args);
          } else {
            pendingFunctionCalls[call_id] = { name };
            console.log('[Agent] Stored pending function call (no args yet):', name, call_id);
          }
        }

        // 2) During response streaming, server sends response.output_item.added for each new item (e.g. function_call)
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          const { name, call_id } = event.item;
          pendingFunctionCalls[call_id] = { name };
          console.log('[Agent] Pending function call (response.output_item.added):', name, call_id);
          const argsJson = event.item.arguments;
          if (argsJson) {
            try {
              const args = JSON.parse(argsJson);
              delete pendingFunctionCalls[call_id];
              runTool(call_id, name, args);
            } catch (e) {
              console.error('[Agent] Failed to parse function args (output_item.added):', argsJson);
            }
          }
        }

        // 3) When function call arguments finish streaming, we get the full arguments here
        if (event.type === 'response.function_call_arguments.done') {
          const { call_id, arguments: argsJson } = event;
          const pending = pendingFunctionCalls[call_id];
          if (pending) {
            delete pendingFunctionCalls[call_id];
            let args = {};
            try {
              args = argsJson ? JSON.parse(argsJson) : {};
            } catch (e) {
              console.error('[Agent] Failed to parse function args (arguments.done):', argsJson);
            }
            console.log(
              '[Agent] Running tool from response.function_call_arguments.done:',
              pending.name,
              call_id,
            );
            runTool(call_id, pending.name, args);
          }
        }

        if (event.type === 'session.updated') {
          openaiReady = true;
          console.log('[OpenAI] Session ready');
          if (!USE_TRANSCRIPT_ONLY) {
            while (audioQueue.length > 0) {
              const b64 = audioQueue.shift();
              client.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
            }
          } else {
            audioQueue.length = 0;
          }
          try {
            client.send(JSON.stringify({ type: 'response.create' }));
          } catch (_) {}
        }

        // Flush outbound bot buffer to Exotel (skip if user started speaking — drop audio)
        const flushOutboundBotBuffer = (sendToExotel = true) => {
          if (!sendToExotel || userIsSpeaking) {
            outboundBotBuffer.length = 0;
            return;
          }
          while (outboundBotBuffer.length > 0) {
            const { sid, payload } = outboundBotBuffer.shift();
            try {
              ws.send(JSON.stringify({ event: 'media', streamSid: sid, media: { payload } }));
            } catch (e) {
              console.error('[Exotel] Send media error:', e);
            }
          }
        };

        if (USE_TRANSCRIPT_ONLY) {
          transcriptOnlyState.cancelResponse = () => {
            userIsSpeaking = true;
            flushOutboundBotBuffer(false);
            try {
              client.send(JSON.stringify({ type: 'response.cancel' }));
            } catch (_) {}
          };
        }

        // Stream output audio to Exotel: buffer ~200ms then send, so we can drop unsent when user speaks
        if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') {
          userIsSpeaking = false; // new bot output = allow sending again (in case previous response was canceled)
          const b64 = event.delta || event.audio;
          if (b64) {
            const sid = streamSid || 'default';
            if (!streamSid && !warnedNoStreamSid) {
              warnedNoStreamSid = true;
              console.warn(
                "[Exotel] streamSid was null; sending media with streamSid='default'. If no audio on call, check Exotel payload for stream ID.",
              );
            }
            const pcm24k = Buffer.from(b64, 'base64');
            const pcm8k = resample24kTo8k(pcm24k);
            for (let i = 0; i < pcm8k.length; i += EXOTEL_CHUNK_BYTES) {
              const chunk = pcm8k.subarray(i, Math.min(i + EXOTEL_CHUNK_BYTES, pcm8k.length));
              const payload = chunk.toString('base64');
              outboundBotBuffer.push({ sid, payload });
              if (outboundBotBuffer.length >= BOT_OUTBOUND_BUFFER_CHUNKS)
                flushOutboundBotBuffer(true);
            }
            if (!isBotSpeaking) {
              isBotSpeaking = true;
              console.log('[Exotel] Bot started speaking');
            }
          }
        }

        if (event.type === 'response.done' || event.type === 'response.output_audio.done') {
          flushOutboundBotBuffer(true);
          userIsSpeaking = false;
          if (isBotSpeaking) {
            isBotSpeaking = false;
            console.log('[OpenAI] Bot finished speaking');
          }
        }

        if (event.type === 'input_audio_buffer.speech_started') {
          console.log(
            '[OpenAI] User speech started — canceling bot response and dropping buffered bot audio',
          );
          userIsSpeaking = true;
          flushOutboundBotBuffer(false);
          client.send(JSON.stringify({ type: 'response.cancel' }));
        }
        if (event.type === 'input_audio_buffer.speech_stopped') {
          console.log('[OpenAI] User speech stopped');
        }
        // Collect user transcript + log for debugging (Hindi/name transcription)
        if (
          event.type === 'conversation.item.input_audio_transcription.completed' &&
          event.transcript
        ) {
          console.log('[Agent] Input transcription (Whisper):', event.transcript || '(empty)');
          callTranscript.push({ role: 'user', text: event.transcript });
        }
        // Collect assistant transcript (Realtime API may send response.output_audio_transcript.done)
        if (event.type === 'response.output_audio_transcript.done' && event.transcript) {
          console.log('[Agent] Assistant transcript:', event.transcript || '(empty)');
          callTranscript.push({ role: 'assistant', text: event.transcript });
        }
        if (event.type === 'response.audio_transcript.done' && event.transcript) {
          console.log('[Agent] Assistant transcript:', event.transcript || '(empty)');
          callTranscript.push({ role: 'assistant', text: event.transcript });
        }
        if (event.type === 'error') {
          console.error('[OpenAI] Event error:', event.error || event);
        }
      } catch (e) {
        console.error('[OpenAI] Message parse error:', e);
      }
    });

    client.on('error', (err) => {
      console.error('[OpenAI] WebSocket error:', err);
      cleanupOpenAI();
    });

    client.on('close', () => {
      console.log('[OpenAI] Realtime closed');
      openaiWs = null;
    });

    return client;
  };

  // Extract stream ID from any of the keys Exotel/Twilio might use
  const extractStreamSid = (obj) => {
    if (typeof obj !== 'object') return null;
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
  ws.on('message', (message) => {
    try {
      if (!message) return;
      const data = JSON.parse(message.toString());

      const extracted = extractStreamSid(data);
      if (extracted && extracted !== streamSid) {
        streamSid = extracted;
        console.log('[Exotel] streamSid:', streamSid);
      }

      if (!firstMessageLogged) {
        firstMessageLogged = true;
        console.log(
          '[Exotel] First message keys:',
          Object.keys(data).join(', '),
          data.start ? ' start.keys: ' + Object.keys(data.start).join(', ') : '',
        );
      }

      if (data.event === 'start') {
        if (!streamSid) streamSid = data.start?.streamSid ?? data.streamSid ?? null;
        callerPhone =
          data.start?.customParameters?.From ??
          data.start?.callerId ??
          data.start?.from ??
          'unknown';
        console.log(`[Exotel] Call start streamSid=${streamSid} caller=${callerPhone}`);
        openaiWs = connectOpenAIRealtime();
      } else if (data.event === 'media') {
        const payload = data.media?.payload;
        if (!payload || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
        if (!streamSid) streamSid = data.streamSid ?? data.media?.streamSid ?? streamSid;
        const pcm8k = Buffer.from(payload, 'base64');
        const pcm24k = resample8kTo24k(pcm8k);

        if (USE_TRANSCRIPT_ONLY) {
          const rms = computeRms(pcm24k);
          const now = Date.now();
          const isSpeech = rms > TRANSCRIPT_ONLY_SPEECH_THRESHOLD;

          if (transcriptOnlyState.processing) {
            // skip while transcribing previous turn
          } else if (isSpeech) {
            transcriptOnlyState.hadSpeechInTurn = true;
            if (transcriptOnlyState.silenceStartedAt !== null) {
              transcriptOnlyState.cancelResponse();
            }
            transcriptOnlyState.lastSpeechAt = now;
            transcriptOnlyState.silenceStartedAt = null;
            transcriptOnlyState.userChunks.push(Buffer.from(pcm24k));
          } else {
            transcriptOnlyState.userChunks.push(Buffer.from(pcm24k));
            if (transcriptOnlyState.silenceStartedAt === null) {
              transcriptOnlyState.silenceStartedAt = now;
            }
            const totalBytes = transcriptOnlyState.userChunks.reduce((s, c) => s + c.length, 0);
            const silenceDuration = now - transcriptOnlyState.silenceStartedAt;
            if (
              transcriptOnlyState.hadSpeechInTurn &&
              totalBytes >= MIN_SPEECH_BYTES_24K &&
              silenceDuration >= TRANSCRIPT_ONLY_SILENCE_MS
            ) {
              const wavBuffer = pcm24kToWavBuffer(Buffer.concat(transcriptOnlyState.userChunks));
              transcriptOnlyState.userChunks = [];
              transcriptOnlyState.silenceStartedAt = null;
              transcriptOnlyState.lastSpeechAt = 0;
              transcriptOnlyState.hadSpeechInTurn = false;
              transcriptOnlyState.processing = true;

              transcribeWithWhisper(wavBuffer)
                .then((transcript) => {
                  if (!transcript || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
                  console.log('[Agent] Input transcription (Whisper):', transcript);
                  callTranscript.push({ role: 'user', text: transcript });
                  openaiWs.send(
                    JSON.stringify({
                      type: 'conversation.item.create',
                      item: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: transcript }],
                      },
                    }),
                  );
                  openaiWs.send(JSON.stringify({ type: 'response.create' }));
                })
                .catch((err) => {
                  console.error('[Agent] Whisper transcription error:', err.message);
                })
                .finally(() => {
                  transcriptOnlyState.processing = false;
                });
            }
          }
        } else {
          const b64 = pcm24k.toString('base64');
          if (openaiReady) {
            openaiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: b64,
              }),
            );
          } else {
            audioQueue.push(b64);
          }
        }
      } else if (data.event === 'stop') {
        console.log(`[Exotel] Call stop for hospital: ${hospital.name}`);
        appointmentDetails =
          parseAppointmentFromTranscript(callTranscript, callerPhone) ||
          (callTranscript.some((t) => /appointment|book|hospital|dr\./i.test(t.text))
            ? {
                hospital: hospital._id.toString(),
                hospitalName: hospital.name,
                doctorName: null,
                patientName: null,
                patientAge: null,
                phone: callerPhone !== 'unknown' ? callerPhone : null,
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
            status: 'no_appointment',
            callEndedAt: new Date().toISOString(),
          },
          callerPhone: callerPhone !== 'unknown' ? callerPhone : null,
          streamSid,
        };
        try {
          //   const fs = require("fs");
          //   const path = require("path");
          //   const dir = path.join(process.cwd(), "call_logs");
          //   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          //   const filename = path.join(
          //     dir,
          //     `call_${streamSid || Date.now()}_${Date.now()}.json`,
          //   );
          //   fs.writeFileSync(
          //     filename,
          //     JSON.stringify(callSummary, null, 2),
          //     "utf8",
          //   );
          //   callSummaryWritten = true;
          //   console.log(
          //     "[Exotel] Call transcript and appointment JSON saved:",
          //     filename,
          //   );
          console.log(`[Exotel] Call stop for ${hospital.name}. (No auto-create on stop)`);
        } catch (e) {
          console.error('[Exotel] Failed to write call JSON:', e);
          console.log('[Exotel] Call summary (inline):', JSON.stringify(callSummary, null, 2));
        }
        cleanupOpenAI();
        ws.close();
      }
    } catch (e) {
      console.error('[Exotel] Message error:', e);
    }
  });

  ws.on('close', () => {
    console.log('[Exotel] WebSocket disconnected');
    if (!callSummaryWritten && callTranscript.length > 0) {
      let details = appointmentDetails;
      if (!details) {
        details = parseAppointmentFromTranscript(callTranscript, callerPhone);
        if (
          !details &&
          callTranscript.some((t) => /appointment|book|hospital|dr\./i.test(t.text))
        ) {
          details = {
            hospital: null,
            doctorName: null,
            patientName: null,
            patientAge: null,
            phone: callerPhone !== 'unknown' ? callerPhone : null,
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
          status: 'no_appointment',
          callEndedAt: new Date().toISOString(),
        },
        callerPhone: callerPhone !== 'unknown' ? callerPhone : null,
        streamSid,
      };
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(process.cwd(), 'call_logs');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = path.join(dir, `call_${streamSid || Date.now()}_${Date.now()}.json`);
        fs.writeFileSync(filename, JSON.stringify(callSummary, null, 2), 'utf8');
        callSummaryWritten = true;
        console.log('[Exotel] Call transcript and appointment JSON saved (on close):', filename);
      } catch (e) {
        console.error('[Exotel] Failed to write call JSON:', e);
      }
    }
    cleanupOpenAI();
  });

  ws.on('error', (err) => {
    console.error('[Exotel] WebSocket error:', err);
    cleanupOpenAI();
  });
});

// =========================
// Health / root
// =========================
app.get('/', (req, res) => {
  res.send(
    'Chat-bot Voice Agent (Exotel + OpenAI Realtime). Connect to /media/:hospitalId via WebSocket.',
  );
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'voice-agent' });
});

// List available hospitals endpoint (for debugging/config)
app.get('/hospitals', async (req, res) => {
  try {
    const PORT = env.AGENT_PORT || 5002;
    const CLOUDFLARE_DOMAIN = env.CLOUDFLARE_DOMAIN;

    const hospitals = await HospitalModel.find({})
      .select('_id name phoneNumber email address city pincode')
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
          ? 'Use cloudflareUrl for Exotel production connections'
          : 'Set CLOUDFLARE_DOMAIN in .env to get Cloudflare URLs',
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
    console.log('\n🏥 Loading hospitals from database...');
    const hospitals = await HospitalModel.find({})
      .select('_id name phoneNumber email address city pincode')
      .lean();

    if (hospitals.length === 0) {
      console.log(
        '   ⚠️  No hospitals found in database. Add hospitals to enable voice agent endpoints.',
      );
    } else {
      console.log(`   ✓ Found ${hospitals.length} hospital(s):\n`);

      // Get doctor counts and details for each hospital
      const hospitalsWithDetails = await Promise.all(
        hospitals.map(async (h) => {
          const doctors = await DoctorModel.find({ hospital: h._id })
            .select('fullName designation availability status')
            .lean();
          const doctorCount = doctors.length;

          // Group doctors by department
          const doctorsByDept = {};
          doctors.forEach((doc) => {
            const dept = doc.designation || 'General';
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
            .join(', ');
          console.log(`      Departments: ${deptList}`);
        } else {
          console.log(`      ⚠️  No doctors assigned to this hospital`);
        }

        console.log(`      Local WebSocket: ${hospital.websocketUrl}`);
        if (hospital.cloudflareUrl) {
          console.log(`      🌐 Cloudflare URL: ${hospital.cloudflareUrl}`);
        }
        console.log('');
      });

      console.log(`📞 Chat-bot Voice Agent ready for ${hospitals.length} hospital(s)`);

      // Show Exotel-ready endpoints (first 2 hospitals)
      if (hospitalsWithDetails.length > 0) {
        console.log('\n📱 Exotel Configuration Endpoints:');
        console.log('   Configure these WebSocket URLs in your Exotel voice app:\n');

        hospitalsWithDetails.slice(0, 2).forEach((hospital, index) => {
          const exotelUrl =
            hospital.cloudflareUrl || hospital.websocketUrl.replace('0.0.0.0', 'localhost');
          console.log(`   ${index + 1}. ${hospital.name}:`);
          console.log(`      WebSocket URL: ${exotelUrl}`);
          console.log(`      Hospital ID: ${hospital.id}`);
          console.log('');
        });

        if (hospitalsWithDetails.length > 2) {
          console.log(`   ... and ${hospitalsWithDetails.length - 2} more hospital(s)`);
          console.log(`   Use GET /hospitals API to see all endpoints\n`);
        }

        if (!CLOUDFLARE_DOMAIN) {
          console.log('   ⚠️  CLOUDFLARE_DOMAIN not set in .env');
          console.log('   Set CLOUDFLARE_DOMAIN=your-domain.com to get Cloudflare URLs\n');
        }
      }
    }
  } catch (err) {
    console.error(`   ❌ Error loading hospitals: ${err.message}`);
    console.error(`   Agent will still start, but hospital validation may fail.`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n📞 Chat-bot Voice Agent Server Started');
    console.log(`   Port: ${PORT}`);
    console.log(`   WebSocket Pattern: ws://0.0.0.0:${PORT}/media/:hospitalId`);
    if (CLOUDFLARE_DOMAIN) {
      console.log(`   Cloudflare Pattern: wss://${CLOUDFLARE_DOMAIN}/media/:hospitalId`);
    }
    console.log(`   Health Check: http://0.0.0.0:${PORT}/health`);
    console.log(`   Hospitals API: http://0.0.0.0:${PORT}/hospitals`);
    console.log(`   Exotel: Use Cloudflare URLs above for production connections.\n`);
  });
};

// Export the start function so it can be called from the main server
module.exports = { startAgent };

// If this file is run directly (not imported), start the agent server
if (require.main === module) {
  startAgent().catch((err) => {
    console.error('[Agent] Failed to start:', err);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    process.exit(0);
  });
}
