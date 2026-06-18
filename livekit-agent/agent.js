const { voice, llm } = require("@livekit/agents");
const { getRealtimeTools } = require("../src/agent/realtimeTools");
const { runHospitalTool } = require("../src/agent/realtimeToolHandlers");
const {
  normalizeShortYesNoInPlace,
  getPlainTranscript,
} = require("./userTranscriptNormalize");
const { buildBookingTurnInstructions } = require("./bookingTurnInstructions");
const { applyTranscriptToBookingSlots } = require("./bookingSlotCapture");
const { handleEmergencyUserTurn } = require("./emergencyCallFlow");
const {
  inferHospitalCallerLanguage,
  detectExplicitHospitalLanguageSwitch,
  getEmptyInputRepromptInstructions,
  HANG_UP_GU,
  HANG_UP_HI,
  HANG_UP_EN,
} = require("./preferredLanguage");
const {
  createCallBookingSlots,
  updateSlotsFromToolArgs,
  mergeToolArgsWithSlots,
  maybeCaptureVisitReasonFromTranscript,
  isMongoObjectIdString,
} = require("./callBookingSlots");

const SLOT_MERGE_TOOLS = new Set(["create_patient", "create_appointment"]);
const BOOKING_TOOLS_BLOCKED_IN_EMERGENCY = new Set([
  "create_patient",
  "create_appointment",
  "list_doctors",
  "search_doctors",
  "fetch_patient_by_patientId",
  "fetch_patient_by_phone",
]);

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

  const hangUp =
    lang === "gu" ? HANG_UP_GU : lang === "en" ? HANG_UP_EN : HANG_UP_HI;
  const langLabel =
    lang === "gu" ? "Gujarati" : lang === "en" ? "English" : "Hindi";

  const instructions = result.ok
    ? (result.appointmentUpdated
        ? "The appointment was updated (ok: true). Speak EXACTLY the status line below in " +
          langLabel +
          ", then the hang-up line. Do NOT say the update failed. Do NOT read internal English instructions. Do NOT change wording.\n" +
          `Status: ${primary}\n` +
          `Hang-up: ${hangUp}`
        : "The appointment is booked (ok: true). Speak EXACTLY the booking status line below in " +
          langLabel +
          ", then the hang-up line. Do NOT say booking failed. Do NOT read internal English instructions. Do NOT change wording.\n" +
          `Booking status: ${primary}\n` +
          `Hang-up: ${hangUp}\n` +
          "That status line is the ONLY full booking recap for this call — if the caller says hello / thank you later, give only one short warm line in the SAME language; never repeat the entire booking block unless they explicitly ask for the number again.")
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
        if (
          agent &&
          agent.callBookingSlots &&
          agent.callBookingSlots.caseType === "emergency" &&
          BOOKING_TOOLS_BLOCKED_IN_EMERGENCY.has(name)
        ) {
          if (logger) {
            logger.log("tool_end", {
              name,
              ok: false,
              durationMs: 0,
              code: "EMERGENCY_CALL",
            });
          }
          return {
            ok: false,
            code: "EMERGENCY_CALL",
            message:
              "Appointment booking is not available during an emergency call.",
          };
        }
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
          /** Surface as a structured failure so the model recovers naturally. */
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

          /**
           * If create_appointment failed because the chosen doctor reference was wrong,
           * DROP any stale slot doctor id — otherwise mergeToolArgsWithSlots silently
           * re-attaches Yugen on the NEXT call when the model omits doctorObjectId
           * (common after narration). Without this fix the agent can verbally pivot to
           * "Dr Asha Patel" yet still POST book with stale Dr Yugen's id from slots.
           */
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
            /** Sync slot doctor reference to whoever was actually booked. */
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
          }
        }

        return result;
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
    /** @type {'hi' | 'gu'} */
    this.preferredLanguage = "hi";
    /** After first confident hi/gu detection (or explicit switch), STT heuristics must not flip language mid-call. */
    this.preferredLanguageLocked = false;
    this.callBookingSlots = createCallBookingSlots();
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
   * Sync preferred language from user text (Sarvam STT). Locked after first inference so mixed
   * snippets do not override the chosen language; use detectExplicitHospitalLanguageSwitch when locked.
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
    ]
      .filter(Boolean)
      .join(",") || "(none)";
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
      applyTranscriptToBookingSlots(this.callBookingSlots, rawBefore);
    } catch (err) {
      console.warn(
        "[Agent] applyTranscriptToBookingSlots failed:",
        err && err.message ? err.message : err,
      );
    }
    if (this.callBookingSlots.caseType !== "emergency") {
      try {
        maybeCaptureVisitReasonFromTranscript(this.callBookingSlots, rawBefore);
      } catch (err) {
        console.warn(
          "[Agent] maybeCaptureVisitReasonFromTranscript failed:",
          err && err.message ? err.message : err,
        );
      }
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

    const slots = this.callBookingSlots;

    if (slots.caseType === "emergency") {
      if (logger) {
        logger.log("generate_reply", {
          purpose: "user_turn_emergency",
          lang: this.preferredLanguage,
          slotsSummary: this._slotsSummaryForLog(),
          userText: rawBefore.length > 200
            ? `${rawBefore.slice(0, 200)}…`
            : rawBefore,
        });
      }
      try {
        await handleEmergencyUserTurn({
          agent: this,
          session: this.session,
          slots,
          rawBefore,
          textAfter,
          preferredLanguage: this.preferredLanguage,
          logger,
        });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error("[Agent] handleEmergencyUserTurn failed:", msg);
        if (logger) {
          logger.log("generate_reply_error", {
            purpose: "emergency_flow",
            errorMessage: msg,
          });
        }
      }
      if (logger) {
        logger.log("stop_response", { reason: "emergency_flow_dispatched" });
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
        preferredLanguageLocked: this.preferredLanguageLocked,
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
        this.preferredLanguage === "gu"
          ? "Reply in Gujarati only as Neha, the female receptionist. Never offer English — Hindi and Gujarati only."
          : "Reply in Hindi only as Neha, the female receptionist. Never offer English — Hindi and Gujarati only.";
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
      const handle = this.session.generateReply({
        userMessage: newMessage,
        instructions: bookingIx,
      });
      if (handle && typeof handle.waitForPlayout === "function") {
        await handle.waitForPlayout();
      }
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

module.exports = { HospitalVoiceAgent, buildHospitalTools, speakCreateAppointmentResult };
