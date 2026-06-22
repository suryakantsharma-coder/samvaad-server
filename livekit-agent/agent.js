const { voice, llm } = require("@livekit/agents");
const { getRealtimeTools } = require("../src/agent/realtimeTools");
const { runHospitalTool } = require("../src/agent/realtimeToolHandlers");
const {
  normalizeShortYesNoInPlace,
  getPlainTranscript,
} = require("./userTranscriptNormalize");
const { buildBookingTurnInstructions } = require("./bookingTurnInstructions");
const { applyTranscriptToBookingSlots } = require("./bookingSlotCapture");
const {
  inferHospitalCallerLanguage,
  detectExplicitHospitalLanguageSwitch,
  getEmptyInputRepromptInstructions,
  getThankYouLine,
} = require("./preferredLanguage");
const {
  createCallBookingSlots,
  updateSlotsFromToolArgs,
  mergeToolArgsWithSlots,
  maybeCaptureCaseTypeFromTranscript,
  maybeCaptureVisitReasonFromTranscript,
  isEmergencyFlowActive,
  isMongoObjectIdString,
} = require("./callBookingSlots");
const {
  isAutoEndAfterBookingEnabled,
  scheduleAutoEndAfterBookingConfirmed,
} = require("./endPhoneCall");
const {
  maybeScheduleEmergencyEndFromCallerNoted,
} = require("./emergencyCallEnd");

const SLOT_MERGE_TOOLS = new Set(["create_patient", "create_appointment"]);

const EN_BOOKING_WAIT_LINE =
  "I'm booking that for you now — one moment, please stay on the line.";
const HI_BOOKING_WAIT_LINE = "मैं अभी बुक कर रही हूँ — एक मिनट लाइन पर रहिएगा।";

/**
 * Exact confirmation text spoken after a successful booking.
 * Bilingual (Hindi first, then English) so ALL callers hear confirmation
 * regardless of detected language.
 */
const BOOKING_CONFIRMATION_HI =
  "आपकी अपॉइंटमेंट सफलतापूर्वक बुक हो गई है। आपकी अपॉइंटमेंट की पूरी जानकारी आपको जल्द ही WhatsApp पर मिल जाएगी। यदि आपको समय बदलना हो, तो आप आसानी से WhatsApp के माध्यम से इसे बदल सकते हैं। धन्यवाद।";
const BOOKING_CONFIRMATION_EN =
  "Your appointment has been successfully booked. All details will be sent to your WhatsApp shortly. If you need to change the timing, you can easily reschedule it via WhatsApp. Thank you.";

/**
 * Build the exact text the agent must speak as its post-tool reply for a
 * create_appointment result. The OpenAI Realtime model has no separate TTS, so
 * the only reliable way to deliver a scripted confirmation is to put the verbatim
 * text into the function-call output `message`: the framework generates a reply
 * from that output (agent_activity executeTools -> realtime reply), so the model
 * reads it aloud. We instruct it to speak word-for-word with nothing added.
 * @param {{ ok?: boolean, appointmentUpdated?: boolean, message?: string, messageHindi?: string, messageGujarati?: string, messageEnglish?: string }} result
 * @param {'hi'|'en'} lang
 * @returns {string}
 */
function buildCreateAppointmentSpokenMessage(result, lang, hospitalName) {
  const isEn = lang === "en";
  const DEV = /[\u0900-\u097F]/;
  // Closing thank-you spoken as the FINAL sentence, e.g.
  // "Thank you for calling <Hospital>." / "<Hospital> ko call karne ke liye dhanyavaad."
  const thankYou = getThankYouLine(isEn ? "en" : "hi", hospitalName);

  if (result.ok && !result.appointmentUpdated) {
    // Speak the slot-aware success line built by the booking tool
    // (buildBookingSuccessVoiceMessages: appointment number, doctor, slot,
    // WhatsApp confirmation + reschedule note). Fall back to the generic
    // scripted line only if the tool did not provide one.
    const body = isEn
      ? result.messageEnglish && !DEV.test(result.messageEnglish)
        ? result.messageEnglish
        : BOOKING_CONFIRMATION_EN
      : result.messageHindi || BOOKING_CONFIRMATION_HI;
    const text = thankYou ? `${body} ${thankYou}` : body;
    return (
      "BOOKING SUCCESSFUL. The appointment is confirmed in the system. " +
      "Speak the text below to the caller as your ENTIRE reply -- word for word, " +
      "no additions, no omissions, no rephrasing, and nothing before or after it. " +
      "The thank-you line at the end must be your FINAL sentence; say nothing after it:\n\n" +
      text
    );
  }

  if (result.ok && result.appointmentUpdated) {
    // Speak the slot-aware update line built by the booking tool; generic line is fallback.
    const updEn =
      "Your appointment has been successfully updated. All details will be sent to your WhatsApp shortly. If you need to change the timing again, you can easily reschedule it via WhatsApp. Thank you.";
    const updHi =
      "आपकी अपॉइंटमेंट सफलतापूर्वक अपडेट हो गई है। आपकी अपॉइंटमेंट की पूरी जानकारी आपको जल्द ही WhatsApp पर मिल जाएगी। यदि आपको दोबारा समय बदलना हो, तो आप आसानी से WhatsApp के माध्यम से इसे बदल सकते हैं। धन्यवाद।";
    const body = isEn
      ? result.messageEnglish && !DEV.test(result.messageEnglish)
        ? result.messageEnglish
        : updEn
      : result.messageHindi || updHi;
    const text = thankYou ? `${body} ${thankYou}` : body;
    return (
      "APPOINTMENT UPDATED. Speak the text below to the caller as your ENTIRE reply -- " +
      "word for word, no additions, no omissions, and nothing before or after it. " +
      "The thank-you line at the end must be your FINAL sentence; say nothing after it:\n\n" +
      text
    );
  }

  // Failure
  let primary;
  if (isEn) {
    primary =
      result.messageEnglish && !DEV.test(result.messageEnglish)
        ? result.messageEnglish
        : "We could not complete the booking right now. Please try again in a moment, or our team will reach out to you on WhatsApp.";
  } else {
    primary =
      result.messageHindi ||
      result.messageGujarati ||
      "माफ़ कीजिए, अभी बुकिंग पूरी नहीं हो सकी। कृपया थोड़ी देर बाद दोबारा प्रयास करें, या हमारी टीम आपसे WhatsApp पर संपर्क करेगी।";
  }
  return (
    "BOOKING FAILED. Calmly tell the caller in " +
    (isEn ? "English" : "Hindi") +
    " exactly the line below and reassure them about next steps. " +
    "Do NOT read any technical or internal text:\n" +
    primary
  );
}

/**
 * Shape Realtime tool results so the model reads the right thing aloud.
 * For create_appointment we replace `message` with the exact scripted confirmation
 * (see buildCreateAppointmentSpokenMessage). For other tools we strip Hindi/Gujarati
 * copy on English calls so the model does not read it aloud.
 * @param {Record<string, unknown> | null | undefined} result
 * @param {'hi'|'gu'|'en'} lang
 * @param {string} toolName
 */
function sanitizeToolResultForCallerLanguage(result, lang, toolName, hospitalName) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result };
  delete out.messageHindi;
  delete out.messageGujarati;

  if (toolName === "create_appointment") {
    // The confirmation/failure line the agent speaks is built here and delivered
    // via the framework's post-tool reply. Drop raw localized copy so the model
    // only sees the single scripted instruction below.
    delete out.messageEnglish;
    out.message = buildCreateAppointmentSpokenMessage(
      result,
      lang === "en" ? "en" : "hi",
      hospitalName,
    );
    return out;
  }

  if (lang !== "en") return out;

  if (out.messageEnglish) {
    out.message = out.messageEnglish;
  } else if (
    typeof out.message === "string" &&
    /[\u0900-\u097F]/.test(out.message)
  ) {
    out.message =
      "Respond to the caller in English only. Do not read Hindi tool fields aloud.";
  }

  if (out.ok === false && out.messageEnglish) {
    out.message = out.messageEnglish;
  }

  return out;
}

/** Per-tool args allow-list for logs — keeps file readable without dumping sensitive blobs. */
function redactToolArgsForLog(name, args) {
  if (!args || typeof args !== "object") return {};
  const a = { ...args };
  if (a.phoneNumber)
    a.phoneNumber = String(a.phoneNumber).replace(/\d(?=\d{4})/g, "*");
  return a;
}

/**
 * @param {HospitalVoiceAgent} agent
 * @param {{ ok?: boolean, message?: string, messageHindi?: string, messageGujarati?: string, messageEnglish?: string, appointmentUpdated?: boolean }} result
 */
async function speakCreateAppointmentResult(agent, result) {
  if (!agent || !result || !agent.session) return;

  // For success cases, use the exact required bilingual confirmation message.
  // This avoids relying on tool-result messageHindi (which varies) and prevents
  // the LLM from skipping the booking status and only reading the closing line.
  if (result.ok && !result.appointmentUpdated) {
    const logger =
      typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
    const lang = agent.preferredLanguage === "en" ? "en" : "hi";
    const confirmationText =
      lang === "en"
        ? BOOKING_CONFIRMATION_EN
        : BOOKING_CONFIRMATION_HI + " " + BOOKING_CONFIRMATION_EN;
    const instructions =
      "Appointment booked successfully. Speak WORD FOR WORD the confirmation below. " +
      "Do NOT add anything before or after it. Do NOT say 'thank you for calling' or any extra closing. " +
      "Do NOT skip any part. Do NOT rephrase.\n\n" +
      confirmationText;
    if (logger) {
      logger.log("generate_reply", { purpose: "post_booking_status", lang });
    }
    try {
      const handle = agent.session.generateReply({
        toolChoice: "none",
        instructions,
      });
      if (handle && typeof handle.waitForPlayout === "function") {
        await handle.waitForPlayout();
      } else if (handle && typeof handle.then === "function") {
        await handle;
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("[Agent] post-booking generateReply error:", msg);
      if (logger) {
        logger.log("generate_reply_error", {
          purpose: "post_booking_status",
          errorMessage: msg,
        });
      }
    }
    return;
  }

  const lang = agent.preferredLanguage === "en" ? "en" : "hi";

  // Updated appointment path
  if (result.ok && result.appointmentUpdated) {
    let primary =
      lang === "en"
        ? result.messageEnglish ||
          "Your appointment has been updated. Details will be sent to your WhatsApp."
        : result.messageHindi ||
          result.messageGujarati ||
          result.messageEnglish ||
          result.message;
    if (!primary) return;
    const hospitalName =
      agent._hospital && agent._hospital.name
        ? String(agent._hospital.name)
        : "";
    const thankYou = getThankYouLine(lang, hospitalName);
    const langLabel = lang === "en" ? "English" : "Hindi";
    const instructions =
      "The appointment was updated. Speak EXACTLY the status line below in " +
      langLabel +
      ", then the thank-you closing line. Do NOT change wording.\nStatus: " +
      primary +
      "\nThank-you: " +
      thankYou;
    const logger =
      typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
    if (logger) {
      logger.log("generate_reply", { purpose: "post_update_status", lang });
    }
    try {
      const handle = agent.session.generateReply({
        toolChoice: "none",
        instructions,
      });
      if (handle && typeof handle.waitForPlayout === "function") {
        await handle.waitForPlayout();
      } else if (handle && typeof handle.then === "function") {
        await handle;
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("[Agent] post-update generateReply error:", msg);
      if (logger) {
        logger.log("generate_reply_error", {
          purpose: "post_update_status",
          errorMessage: msg,
        });
      }
    }
    return;
  }

  // Failure path — tell caller what went wrong
  let primary;
  if (lang === "en") {
    primary = result.messageEnglish || null;
    if (!primary || /[\u0900-\u097F]/.test(primary)) {
      primary =
        "We were unable to complete the booking. Please try again or contact the hospital.";
    }
  } else {
    primary =
      result.messageHindi ||
      result.messageGujarati ||
      result.messageEnglish ||
      result.message;
  }
  if (!primary) return;

  const langLabel = lang === "en" ? "English" : "Hindi";
  const instructions =
    "Booking failed (ok: false). Speak EXACTLY the line below in " +
    langLabel +
    ". Explain calmly what they can do next. Do not read raw technical English.\nFailure line: " +
    primary;
  const logger =
    typeof agent.getCallLogger === "function" ? agent.getCallLogger() : null;
  if (logger) {
    logger.log("generate_reply", { purpose: "post_booking_failure", lang });
  }
  try {
    const handle = agent.session.generateReply({
      toolChoice: "none",
      instructions,
    });
    if (handle && typeof handle.waitForPlayout === "function") {
      await handle.waitForPlayout();
    } else if (handle && typeof handle.then === "function") {
      await handle;
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error("[Agent] post-booking-failure generateReply error:", msg);
    if (logger) {
      logger.log("generate_reply_error", {
        purpose: "post_booking_failure",
        errorMessage: msg,
      });
    }
  }
}
/**
 * Build LiveKit function tools from OpenAI-style definitions, backed by runHospitalTool.
 */
function buildHospitalTools(hospitalObjectId, callerPhone, agentRef) {
  const defs = getRealtimeTools();
  const tools = {};
  for (const def of defs) {
    const name = def.name;
    if (!name) continue;
    tools[name] = llm.tool({
      description: def.description || "",
      parameters: def.parameters,
      execute: async (args) => {
        const agent = agentRef && agentRef.current;
        const logger =
          agent && typeof agent.getCallLogger === "function"
            ? agent.getCallLogger()
            : null;
        const rawArgs = args && typeof args === "object" ? args : {};
        const mergedArgs =
          agent && SLOT_MERGE_TOOLS.has(name)
            ? mergeToolArgsWithSlots(agent.callBookingSlots, rawArgs)
            : rawArgs;

        const toolStart = Date.now();
        if (logger) {
          logger.log("tool_start", {
            name,
            args: redactToolArgsForLog(name, mergedArgs),
          });
        }

        const isAppointmentBook = name === "create_appointment";
        if (
          agent &&
          (isEmergencyFlowActive(agent.callBookingSlots) ||
            agent._emergencyFlowArmed) &&
          (name === "create_patient" || name === "create_appointment")
        ) {
          if (logger) {
            logger.log("tool_end", {
              name,
              ok: false,
              durationMs: Date.now() - toolStart,
              code: "EMERGENCY_NO_BOOKING",
            });
          }
          return {
            ok: false,
            code: "EMERGENCY_NO_BOOKING",
            message:
              "Emergency path — appointment booking is not allowed on this call.",
          };
        }

        if (agent && isAppointmentBook) {
          agent.appointmentBookingInFlight = true;
        }

        try {
          let result;
          try {
            result = await runHospitalTool(hospitalObjectId, name, mergedArgs, {
              callerPhone: callerPhone || null,
              callBookingSlots: agent ? agent.callBookingSlots : null,
            });
          } catch (toolErr) {
            const msg =
              toolErr && toolErr.message ? toolErr.message : String(toolErr);
            console.error(`[Agent] tool ${name} threw:`, msg);
            if (logger) {
              logger.log("tool_end", {
                name,
                ok: false,
                durationMs: Date.now() - toolStart,
                code: "TOOL_THREW",
                errorMessage: msg,
              });
            }
            return { ok: false, code: "TOOL_THREW", message: msg };
          }

          if (logger) {
            logger.log("tool_end", {
              name,
              ok: Boolean(result && result.ok),
              durationMs: Date.now() - toolStart,
              code: result && result.code ? String(result.code) : null,
              errorMessage:
                result && !result.ok && result.message
                  ? String(result.message)
                  : null,
              hasMessageHindi: Boolean(result && result.messageHindi),
              hasMessageGujarati: Boolean(result && result.messageGujarati),
              appointmentId:
                result && result.appointment
                  ? result.appointment.appointmentId
                  : null,
            });
          }

          if (agent) {
            if (
              name === "create_patient" &&
              result &&
              result.ok &&
              result.patient &&
              result.patient._id
            ) {
              agent.callBookingSlots.patientObjectId = String(
                result.patient._id,
              );
            }
            if (
              (name === "list_doctors" || name === "search_doctors") &&
              result &&
              result.ok &&
              Array.isArray(result.doctors) &&
              result.doctors.length === 1 &&
              result.doctors[0]._id
            ) {
              agent.callBookingSlots.doctorObjectId = String(
                result.doctors[0]._id,
              );
            }
            updateSlotsFromToolArgs(agent.callBookingSlots, mergedArgs);

            if (
              name === "create_appointment" &&
              result &&
              !result.ok &&
              result.code === "INVALID_DOCTOR_REF"
            ) {
              if (agent.callBookingSlots) {
                delete agent.callBookingSlots.doctorObjectId;
              }
            }

            if (
              name === "create_appointment" &&
              result &&
              result.ok &&
              result.appointment &&
              result.appointment.doctor &&
              isMongoObjectIdString(String(result.appointment.doctor))
            ) {
              agent.callBookingSlots.doctorObjectId = String(
                result.appointment.doctor,
              );
            }
          }

          if (name === "create_appointment" && result) {
            if (
              agent &&
              result.ok &&
              result.appointment &&
              result.appointment._id
            ) {
              agent.callBookingSlots.appointmentObjectId = String(
                result.appointment._id,
              );
            }
            // The spoken confirmation is delivered by the framework's post-tool
            // reply, which reads the scripted text we put in the tool `message`
            // (see sanitizeToolResultForCallerLanguage). We must NOT call
            // generateReply here: at this point the function-call output has not
            // been submitted to the Realtime session yet, so a manual reply races
            // with — and is dropped in favour of — the framework reply, leaving
            // the caller with no confirmation. For a successful booking we only
            // arm the auto-hangup, which waits for that confirmation reply to
            // finish playing before deleting the room.
            if (
              agent &&
              result.ok &&
              isAutoEndAfterBookingEnabled() &&
              !agent.autoEndCallStarted
            ) {
              agent.autoEndCallStarted = true;
              scheduleAutoEndAfterBookingConfirmed({ agent });
            }
          }

          if (agent && result) {
            result = sanitizeToolResultForCallerLanguage(
              result,
              agent.preferredLanguage,
              name,
              agent._hospital && agent._hospital.name
                ? String(agent._hospital.name)
                : "",
            );
          }

          return result;
        } finally {
          if (agent && isAppointmentBook) {
            agent.appointmentBookingInFlight = false;
          }
        }
      },
    });
  }
  return tools;
}

class HospitalVoiceAgent extends voice.Agent {
  constructor({
    instructions,
    hospitalObjectId,
    callerPhone,
    /** When true, user speech is transcribed by Sarvam and sent as text into OpenAI Realtime (see main.js). */
    routeUserTextThroughRealtime = false,
    /** Optional getter so this agent can pull the per-call logger lazily from main.js. */
    getCallLogger = null,
  }) {
    const agentRef = { current: null };
    super({
      instructions,
      tools: buildHospitalTools(hospitalObjectId, callerPhone, agentRef),
    });
    agentRef.current = this;
    this._routeUserTextThroughRealtime = routeUserTextThroughRealtime;
    this._getCallLogger =
      typeof getCallLogger === "function" ? getCallLogger : null;
    /** @type {'hi' | 'en'} */
    this.preferredLanguage = "hi";
    /** After first confident hi/en detection (or explicit switch), STT heuristics must not flip language mid-call. */
    this.preferredLanguageLocked = false;
    this.callBookingSlots = createCallBookingSlots();
    this.appointmentBookingInFlight = false;
    this.postBookingClosingInFlight = false;
    this.autoEndCallStarted = false;
    this._emergencyFlowArmed = false;
    /** @type {string|null} */
    this._callRoomName = null;
    /** @type {null | { name?: string }} */
    this._hospital = null;
  }

  shouldSuppressNoInputReprompt() {
    const slots = this.callBookingSlots || {};
    return (
      this.appointmentBookingInFlight ||
      this.postBookingClosingInFlight ||
      this.autoEndCallStarted ||
      Boolean(slots.appointmentObjectId) ||
      Boolean(slots.emergencyNotedConfirmed) ||
      isEmergencyFlowActive(slots)
    );
  }

  /** Returns the per-call logger if main.js wired one up; null otherwise. */
  getCallLogger() {
    if (!this._getCallLogger) return null;
    try {
      return this._getCallLogger();
    } catch (_) {
      return null;
    }
  }

  /**
   * Sync preferred language from user text (Sarvam STT). Locked after first inference so English
   * or mixed snippets do not override the chosen language; use detectExplicitHospitalLanguageSwitch when locked.
   * @param {string} text
   */
  updateLanguageFromTranscript(text) {
    const raw = String(text || "").trim();
    if (!raw) return;
    const wasLocked = this.preferredLanguageLocked;
    const next = wasLocked
      ? detectExplicitHospitalLanguageSwitch(raw)
      : inferHospitalCallerLanguage(raw);
    if (!next) return;
    const prev = this.preferredLanguage;
    this.preferredLanguage = next;
    if (!this.preferredLanguageLocked) this.preferredLanguageLocked = true;
    if (prev !== next) {
      const logger = this.getCallLogger();
      if (logger) {
        logger.log("language_detected", {
          lang: next,
          previous: prev,
          locked: this.preferredLanguageLocked,
          from: raw.slice(0, 80),
        });
      }
    }
  }

  /** Internal: small summary of captured slots (booleans only) for log lines. */
  _slotsSummaryForLog() {
    const s = this.callBookingSlots || {};
    return (
      [
        s.caseType ? `case:${s.caseType}` : null,
        s.fullName ? "name" : null,
        s.age != null ? "age" : null,
        s.gender ? "gender" : null,
        s.reason ? "reason" : null,
        s.doctorObjectId ? "doctor" : null,
        s.appointmentDateTimeISO ? "datetime" : null,
        s.patientObjectId ? "patient" : null,
        s.appointmentObjectId ? "appointment" : null,
        s.emergencyNotedConfirmed ? "emergencyNoted" : null,
      ]
        .filter(Boolean)
        .join(",") || "(none)"
    );
  }

  /**
   * STT side-channel: capture case type, booking slots, emergency-noted, etc.
   * Called from onUserTurnCompleted and from main.js Sarvam STT hook.
   * @param {string} rawText
   */
  applyCallerTranscriptSideEffects(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return;

    try {
      maybeCaptureCaseTypeFromTranscript(this.callBookingSlots, text);
    } catch (err) {
      console.warn(
        "[Agent] maybeCaptureCaseTypeFromTranscript failed:",
        err && err.message ? err.message : err,
      );
    }

    if (!isEmergencyFlowActive(this.callBookingSlots)) {
      try {
        applyTranscriptToBookingSlots(this.callBookingSlots, text);
      } catch (err) {
        console.warn(
          "[Agent] applyTranscriptToBookingSlots failed:",
          err && err.message ? err.message : err,
        );
      }

      try {
        maybeCaptureVisitReasonFromTranscript(this.callBookingSlots, text);
      } catch (err) {
        console.warn(
          "[Agent] maybeCaptureVisitReasonFromTranscript failed:",
          err && err.message ? err.message : err,
        );
      }
    }

    maybeScheduleEmergencyEndFromCallerNoted(this, text);
  }

  /**
   * LiveKit clears STT output for RealtimeModel before generateReply; we inject Sarvam text here instead.
   */
  async onUserTurnCompleted(_chatCtx, newMessage) {
    const rawBefore = getPlainTranscript(newMessage);
    try {
      normalizeShortYesNoInPlace(newMessage);
    } catch (err) {
      console.warn(
        "[Agent] normalizeShortYesNoInPlace failed:",
        err && err.message ? err.message : err,
      );
    }
    const textAfter = getPlainTranscript(newMessage);

    if (
      this._routeUserTextThroughRealtime &&
      process.env.SARVAM_STT_DEBUG !== "0"
    ) {
      const preview = rawBefore
        ? `"${rawBefore.slice(0, 200)}${rawBefore.length > 200 ? "…" : ""}"`
        : "(empty — reprompting caller)";
      console.log("[Sarvam STT] onUserTurnCompleted user text:", preview);
    }

    try {
      this.updateLanguageFromTranscript(rawBefore || textAfter);
    } catch (err) {
      console.warn(
        "[Agent] updateLanguageFromTranscript failed:",
        err && err.message ? err.message : err,
      );
    }

    try {
      this.applyCallerTranscriptSideEffects(rawBefore);
    } catch (err) {
      console.warn(
        "[Agent] applyCallerTranscriptSideEffects failed:",
        err && err.message ? err.message : err,
      );
    }

    if (!this._routeUserTextThroughRealtime) return;

    const logger = this.getCallLogger();

    if (!rawBefore.trim()) {
      if (logger) {
        logger.log("reprompt", {
          reason: "empty_stt",
          lang: this.preferredLanguage,
        });
      }
      try {
        this.session.generateReply({
          toolChoice: "none",
          instructions: getEmptyInputRepromptInstructions(
            this.preferredLanguage,
          ),
        });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn("[Agent] empty STT reprompt error:", msg);
        if (logger) {
          logger.log("generate_reply_error", {
            purpose: "empty_stt_reprompt",
            errorMessage: msg,
          });
        }
      }
      if (logger) {
        logger.log("stop_response", { reason: "empty_stt" });
      }
      throw new voice.StopResponse();
    }

    let bookingIx;
    try {
      bookingIx = buildBookingTurnInstructions({
        slots: this.callBookingSlots,
        rawUser: rawBefore,
        normalizedUser: textAfter,
        preferredLanguage: this.preferredLanguage,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("[Agent] buildBookingTurnInstructions failed:", msg);
      if (logger) {
        logger.log("generate_reply_error", {
          purpose: "build_booking_instructions",
          errorMessage: msg,
        });
      }
      bookingIx =
        this.preferredLanguage === "en"
          ? "Reply in English only as Neha, the female receptionist."
          : this.preferredLanguage === "gu"
            ? "Reply in Gujarati only as Neha, the female receptionist."
            : "Reply in Hindi only as Neha, the female receptionist.";
    }

    if (logger) {
      logger.log("generate_reply", {
        purpose: "user_turn",
        lang: this.preferredLanguage,
        slotsSummary: this._slotsSummaryForLog(),
        userText:
          rawBefore.length > 200 ? `${rawBefore.slice(0, 200)}…` : rawBefore,
      });
    }

    try {
      this.session.generateReply({
        userMessage: newMessage,
        instructions: bookingIx,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("[Agent] generateReply (user_turn) failed:", msg);
      if (logger) {
        logger.log("generate_reply_error", {
          purpose: "user_turn",
          errorMessage: msg,
        });
      }
      /* Fallback: ask the caller to repeat in their language so the call does not go silent. */
      try {
        this.session.generateReply({
          toolChoice: "none",
          instructions: getEmptyInputRepromptInstructions(
            this.preferredLanguage,
          ),
        });
      } catch (fallbackErr) {
        console.warn(
          "[Agent] fallback reprompt also failed:",
          fallbackErr && fallbackErr.message
            ? fallbackErr.message
            : fallbackErr,
        );
      }
    }

    if (logger) {
      logger.log("stop_response", { reason: "user_turn_dispatched" });
    }
    throw new voice.StopResponse();
  }
}

module.exports = {
  HospitalVoiceAgent,
  buildHospitalTools,
  speakCreateAppointmentResult,
};
