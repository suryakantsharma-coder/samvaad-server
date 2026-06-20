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
const { maybeScheduleEmergencyEndFromCallerNoted } = require("./emergencyCallEnd");

const SLOT_MERGE_TOOLS = new Set(["create_patient", "create_appointment"]);

/** Per-tool args allow-list for logs — keeps file readable without dumping sensitive blobs. */
function redactToolArgsForLog(name, args) {
  if (!args || typeof args !== "object") return {};
  const a = { ...args };
  if (a.phoneNumber) a.phoneNumber = String(a.phoneNumber).replace(/\d(?=\d{4})/g, "*");
  return a;
}

/**
 * @param {HospitalVoiceAgent} agent
 * @param {{ ok?: boolean, message?: string, messageHindi?: string, messageGujarati?: string, messageEnglish?: string, appointmentUpdated?: boolean }} result
 */
async function speakCreateAppointmentResult(agent, result) {
  if (!agent || !result || !agent.session) return;

  const lang = agent.preferredLanguage === "gu" ? "gu" : agent.preferredLanguage === "en" ? "en" : "hi";

  let primary;
  if (lang === "en") {
    primary =
      result.messageEnglish ||
      result.message ||
      result.messageHindi ||
      result.messageGujarati;
  } else if (lang === "gu") {
    primary = result.messageGujarati || result.messageHindi;
  } else {
    primary = result.messageHindi || result.messageGujarati || result.message;
  }

  if (!primary) return;

  const hospitalName =
    agent._hospital && agent._hospital.name ? String(agent._hospital.name) : "";
  const thankYou = getThankYouLine(lang, hospitalName);
  const langLabel =
    lang === "gu" ? "Gujarati" : lang === "en" ? "English" : "Hindi";

  const instructions = result.ok
    ? (result.appointmentUpdated
        ? "The appointment was updated (ok: true). Speak EXACTLY the status line below in " +
          langLabel +
          ", then the thank-you closing line. Do NOT say the update failed. Do NOT ask the caller to hang up or cut the call. Do NOT read internal English instructions. Do NOT change wording.\n" +
          `Status: ${primary}\n` +
          `Thank-you: ${thankYou}`
        : "The appointment is booked (ok: true). Speak EXACTLY the booking status line below in " +
          langLabel +
          ", then the thank-you closing line. Do NOT say booking failed. Do NOT ask the caller to hang up or cut the call. Do NOT read internal English instructions. Do NOT change wording.\n" +
          `Booking status: ${primary}\n` +
          `Thank-you: ${thankYou}\n` +
          "Speak the thank-you line as your FINAL sentence — do NOT ask if they need anything else afterward. Do NOT offer further help after the thank-you.")
    : "Booking failed (ok: false). Speak EXACTLY the line below in " +
      langLabel +
      ". Explain calmly what they can do next. Do not read raw technical English.\n" +
      `Failure line: ${primary}`;

  const logger =
    agent && typeof agent.getCallLogger === "function"
      ? agent.getCallLogger()
      : null;
  if (logger) {
    logger.log("generate_reply", {
      purpose: result.ok
        ? result.appointmentUpdated
          ? "post_update_status"
          : "post_booking_status"
        : "post_booking_failure",
      lang,
    });
  }
  try {
    const handle = agent.session.generateReply({
      toolChoice: "none",
      instructions,
    });
    if (handle && typeof handle.waitForPlayout === "function") {
      await handle.waitForPlayout();
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
            message: "Emergency path — appointment booking is not allowed on this call.",
          };
        }

        if (agent && isAppointmentBook) {
          agent.appointmentBookingInFlight = true;
        }

        try {
          let result;
          try {
            result = await runHospitalTool(
              hospitalObjectId,
              name,
              mergedArgs,
              {
                callerPhone: callerPhone || null,
                callBookingSlots: agent ? agent.callBookingSlots : null,
              },
            );
          } catch (toolErr) {
            const msg = toolErr && toolErr.message ? toolErr.message : String(toolErr);
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
                result && !result.ok && result.message ? String(result.message) : null,
              hasMessageHindi: Boolean(result && result.messageHindi),
              hasMessageGujarati: Boolean(result && result.messageGujarati),
              appointmentId:
                result && result.appointment ? result.appointment.appointmentId : null,
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
              agent.callBookingSlots.patientObjectId = String(result.patient._id);
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
            if (agent && result.ok && result.appointment && result.appointment._id) {
              agent.callBookingSlots.appointmentObjectId = String(
                result.appointment._id,
              );
            }
            if (agent) {
              await speakCreateAppointmentResult(agent, result);
              if (
                result.ok &&
                isAutoEndAfterBookingEnabled() &&
                !agent.autoEndCallStarted
              ) {
                agent.autoEndCallStarted = true;
                scheduleAutoEndAfterBookingConfirmed({ agent });
              }
            }
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
    this._getCallLogger = typeof getCallLogger === "function" ? getCallLogger : null;
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
    return [
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
      .join(",") || "(none)";
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

    if (this._routeUserTextThroughRealtime && process.env.SARVAM_STT_DEBUG !== "0") {
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
          instructions: getEmptyInputRepromptInstructions(this.preferredLanguage),
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
        userText: rawBefore.length > 200
          ? `${rawBefore.slice(0, 200)}…`
          : rawBefore,
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
          instructions: getEmptyInputRepromptInstructions(this.preferredLanguage),
        });
      } catch (fallbackErr) {
        console.warn(
          "[Agent] fallback reprompt also failed:",
          fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr,
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
