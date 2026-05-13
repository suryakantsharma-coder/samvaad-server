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
  inferCallerLanguage,
  detectExplicitLanguageSwitch,
  getEmptyInputRepromptInstructions,
  HANG_UP_GU,
  HANG_UP_HI,
} = require("./preferredLanguage");
const {
  createCallBookingSlots,
  updateSlotsFromToolArgs,
  mergeToolArgsWithSlots,
  maybeCaptureVisitReasonFromTranscript,
} = require("./callBookingSlots");

const SLOT_MERGE_TOOLS = new Set(["create_patient", "create_appointment"]);

/**
 * @param {HospitalVoiceAgent} agent
 * @param {{ ok?: boolean, messageHindi?: string, messageGujarati?: string, appointmentUpdated?: boolean }} result
 */
async function speakCreateAppointmentResult(agent, result) {
  if (!agent || !result || !agent.session) return;

  const lang = agent.preferredLanguage === "gu" ? "gu" : "hi";
  const primary =
    lang === "gu"
      ? result.messageGujarati || result.messageHindi
      : result.messageHindi || result.messageGujarati;
  if (!primary) return;

  const hangUp = lang === "gu" ? HANG_UP_GU : HANG_UP_HI;
  const instructions = result.ok
    ? (result.appointmentUpdated
        ? "The appointment was updated (ok: true). Speak EXACTLY the status line below in " +
          (lang === "gu" ? "Gujarati" : "Hindi") +
          ", then the hang-up line. Do NOT say the update failed. Do NOT read English. Do NOT change wording.\n" +
          `Status: ${primary}\n` +
          `Hang-up: ${hangUp}`
        : "The appointment is booked (ok: true). Speak EXACTLY the booking status line below in " +
          (lang === "gu" ? "Gujarati" : "Hindi") +
          ", then the hang-up line. Do NOT say booking failed. Do NOT read English. Do NOT change wording.\n" +
          `Booking status: ${primary}\n` +
          `Hang-up: ${hangUp}`)
    : "Booking failed (ok: false). Speak EXACTLY the line below in " +
      (lang === "gu" ? "Gujarati" : "Hindi") +
      ". Explain calmly what they can do next. Never read English.\n" +
      `Failure line: ${primary}`;

  try {
    const handle = agent.session.generateReply({
      toolChoice: "none",
      instructions,
    });
    if (handle && typeof handle.waitForPlayout === "function") {
      await handle.waitForPlayout();
    }
  } catch (err) {
    console.error(
      "[Agent] post-booking generateReply error:",
      err && err.message ? err.message : err,
    );
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
        const rawArgs = args && typeof args === "object" ? args : {};
        const mergedArgs =
          agent && SLOT_MERGE_TOOLS.has(name)
            ? mergeToolArgsWithSlots(agent.callBookingSlots, rawArgs)
            : rawArgs;

        const result = await runHospitalTool(
          hospitalObjectId,
          name,
          mergedArgs,
          {
            callerPhone: callerPhone || null,
            callBookingSlots: agent ? agent.callBookingSlots : null,
          },
        );

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
  }) {
    const agentRef = { current: null };
    super({
      instructions,
      tools: buildHospitalTools(hospitalObjectId, callerPhone, agentRef),
    });
    agentRef.current = this;
    this._routeUserTextThroughRealtime = routeUserTextThroughRealtime;
    /** @type {'hi' | 'gu'} */
    this.preferredLanguage = "hi";
    /** After first confident hi/gu detection (or explicit switch), STT heuristics must not flip language mid-call. */
    this.preferredLanguageLocked = false;
    this.callBookingSlots = createCallBookingSlots();
  }

  /**
   * Sync preferred language from user text (Sarvam STT). Locked after first inference so English
   * or mixed snippets do not override Hindi/Gujarati choice; use detectExplicitLanguageSwitch when locked.
   * @param {string} text
   */
  updateLanguageFromTranscript(text) {
    const raw = String(text || "").trim();
    if (!raw) return;
    const next = this.preferredLanguageLocked
      ? detectExplicitLanguageSwitch(raw)
      : inferCallerLanguage(raw);
    if (!next) return;
    this.preferredLanguage = next;
    if (!this.preferredLanguageLocked) this.preferredLanguageLocked = true;
  }

  /**
   * LiveKit clears STT output for RealtimeModel before generateReply; we inject Sarvam text here instead.
   */
  async onUserTurnCompleted(_chatCtx, newMessage) {
    const rawBefore = getPlainTranscript(newMessage);
    normalizeShortYesNoInPlace(newMessage);
    const textAfter = getPlainTranscript(newMessage);

    if (this._routeUserTextThroughRealtime && process.env.SARVAM_STT_DEBUG !== "0") {
      const preview = rawBefore
        ? `"${rawBefore.slice(0, 200)}${rawBefore.length > 200 ? "…" : ""}"`
        : "(empty — reprompting caller)";
      console.log("[Sarvam STT] onUserTurnCompleted user text:", preview);
    }

    this.updateLanguageFromTranscript(rawBefore || textAfter);

    applyTranscriptToBookingSlots(this.callBookingSlots, rawBefore);
    maybeCaptureVisitReasonFromTranscript(this.callBookingSlots, rawBefore);

    if (!this._routeUserTextThroughRealtime) return;

    if (!rawBefore.trim()) {
      try {
        this.session.generateReply({
          toolChoice: "none",
          instructions: getEmptyInputRepromptInstructions(this.preferredLanguage),
        });
      } catch (err) {
        console.warn(
          "[Agent] empty STT reprompt error:",
          err && err.message ? err.message : err,
        );
      }
      throw new voice.StopResponse();
    }

    const bookingIx = buildBookingTurnInstructions({
      slots: this.callBookingSlots,
      rawUser: rawBefore,
      normalizedUser: textAfter,
      preferredLanguage: this.preferredLanguage,
    });

    this.session.generateReply({
      userMessage: newMessage,
      instructions: bookingIx,
    });
    throw new voice.StopResponse();
  }
}

module.exports = { HospitalVoiceAgent, buildHospitalTools, speakCreateAppointmentResult };
