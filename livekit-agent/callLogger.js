const fs = require("fs");
const path = require("path");
const {
  CALLER_NUMBERS_ROOT,
  normalizeCallerKey,
} = require("../src/services/callTranscriptStore");
const { AgentSessionEventTypes } = require("@livekit/agents").voice;

/**
 * Per-call JSONL conversation log.
 *
 * One file per call, written at:
 *   caller-numbers/<callerKey>/conversations/<iso-ts>__<short-room>.jsonl
 *
 * Each line is a single JSON event with shape:
 *   { ts: ISO, type: string, ...payload }
 *
 * Events captured (so silent / blank turns are easy to diagnose later):
 *   - session_start              (room, hospital, caller, voice pipeline)
 *   - greeting                   (the initial agent prompt sent on connect)
 *   - user_transcript            (user STT, isFinal flag)
 *   - agent_message              (assistant text from ConversationItemAdded)
 *   - user_message               (user text from ConversationItemAdded)
 *   - speech_created             (source: say | generate_reply | tool_response)
 *   - agent_state                (idle / listening / thinking / speaking)
 *   - user_state                 (speaking / listening / away)
 *   - tool_start / tool_end      (handler-side)
 *   - language_detected          (hi | gu)
 *   - reprompt                   (empty_stt | no_input)
 *   - generate_reply             (manual generateReply triggered from agent.js)
 *   - generate_reply_error
 *   - stop_response              (StopResponse thrown to suppress auto-reply)
 *   - session_error              (LiveKit Error event)
 *   - session_close              (close reason)
 *   - note                       (manual structured note added by callers)
 */

function isoNow() {
  return new Date().toISOString();
}

function sanitizeForFilename(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

/**
 * Tokens we never want the agent to say aloud. If any of these appear in an
 * `agent_message` text, we emit an extra `speech_leak_detected` event so the
 * problem is obvious when scanning the JSONL / terminal output afterwards.
 *
 * The list intentionally avoids matching legitimate appointment numbers like
 * "A-2026-…" or "P-2026-…" — those are caller-facing.
 */
const BANNED_SPEECH_PATTERNS = [
  /\bMongoDB\b/i,
  /\bMongo\b/i,
  /\bObjectId\b/i,
  /\b_id\b/i,
  /\bcreate_patient\b/i,
  /\bcreate_appointment\b/i,
  /\bfetch_patient(?:_by_patientId|_by_phone)?\b/i,
  /\blist_doctors\b/i,
  /\bsearch_doctors\b/i,
  /\bset_calling_phone\b/i,
  /\bpatientObjectId\b/i,
  /\bdoctorObjectId\b/i,
  /\bappointmentObjectId\b/i,
  /\bexistingAppointmentObjectId\b/i,
  /\bappointmentDateTimeISO\b/i,
  /\bBOOKING_STATE\b/i,
  /\bTOOL_NOW\b/i,
  /\bNEXT_TURN\b/i,
  /\bok\s*:\s*(?:true|false)\b/i,
  /\bJSON\b/,
];

function findBannedTermsInSpeech(text) {
  if (!text || typeof text !== "string") return [];
  const hits = [];
  for (const re of BANNED_SPEECH_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/**
 * @param {string} text
 * @param {number} [max=400]
 */
function truncate(text, max = 400) {
  const s = String(text == null ? "" : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(${s.length} chars total)`;
}

/** Compact preview for terminal lines so a call is readable end-to-end. */
function shortPreview(text, max = 160) {
  if (text == null) return "(empty)";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  if (!oneLine) return "(empty)";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

/**
 * Lift the assistant / user text out of a LiveKit ChatMessage item.
 * Returns null if the item is not a text message (e.g. tool call).
 */
function extractItemText(item) {
  if (!item) return null;
  if (item.type !== "message") return null;
  if (item.role !== "user" && item.role !== "assistant") return null;
  if (typeof item.textContent === "string" && item.textContent.trim()) {
    return item.textContent.trim();
  }
  const c = item.content;
  if (!Array.isArray(c)) return null;
  const parts = [];
  for (const part of c) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object") {
      const t = part.text ?? part.transcript;
      if (typeof t === "string") parts.push(t);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

/**
 * Attach a JSONL conversation logger to an AgentSession.
 *
 * @param {{
 *   session: import('@livekit/agents').voice.AgentSession,
 *   hospital: { _id: unknown, name?: string } | null | undefined,
 *   callerPhone: string | null | undefined,
 *   roomName: string,
 *   voicePipeline?: string,
 *   logTag?: string,
 * }} opts
 * @returns {{
 *   filePath: string,
 *   log: (type: string, payload?: Record<string, unknown>) => void,
 *   detach: () => void,
 * }}
 */
function attachCallLogger(opts) {
  const { session, hospital, callerPhone, roomName, voicePipeline, logTag } =
    opts;

  const callerKey = normalizeCallerKey(callerPhone);
  const startIso = isoNow();
  const tag =
    logTag || `[CallLog ${sanitizeForFilename(roomName).slice(0, 24)}]`;

  let filePath = null;
  let stream = null;
  let detached = false;
  let lastUserState = "listening";
  let lastAgentState = "initializing";
  let messageCounter = 0;
  let agentMessageCounter = 0;
  let userMessageCounter = 0;
  let toolCounter = 0;
  let lastUserMessageText = "";
  let lastUserMessageAt = 0;

  try {
    const dir = path.join(CALLER_NUMBERS_ROOT, callerKey, "conversations");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${startIso.replace(/[:.]/g, "-")}__${sanitizeForFilename(roomName)}.jsonl`;
    filePath = path.join(dir, filename);
    stream = fs.createWriteStream(filePath, { flags: "a" });
    stream.on("error", (err) => {
      console.warn(
        tag,
        "stream error:",
        err && err.message ? err.message : err,
      );
    });
  } catch (err) {
    console.warn(
      tag,
      "could not open log file:",
      err && err.message ? err.message : err,
    );
    stream = null;
  }

  const writeLine = (obj) => {
    if (!stream) return;
    try {
      stream.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      console.warn(tag, "write fail:", err && err.message ? err.message : err);
    }
  };

  /** Append one event to file and (selectively) mirror to terminal. */
  const log = (type, payload) => {
    const entry = {
      ts: isoNow(),
      type: String(type || "note"),
      ...(payload && typeof payload === "object" ? payload : {}),
    };
    writeLine(entry);

    /* Console mirror — keep terminal readable; do not print huge blobs. */
    switch (entry.type) {
      case "agent_message":
        console.log(
          tag,
          `AGENT #${entry.idx != null ? entry.idx : agentMessageCounter} (${entry.lang || "?"}):`,
          shortPreview(entry.text),
        );
        if (Array.isArray(entry.leakedTerms) && entry.leakedTerms.length) {
          console.warn(
            tag,
            `!! SPEECH LEAK in AGENT #${entry.idx} — banned tokens spoken aloud: ${entry.leakedTerms.join(", ")}`,
          );
        }
        break;
      case "speech_leak_detected":
        console.warn(
          tag,
          `!! SPEECH LEAK on AGENT #${entry.agentIdx}: ${entry.leakedTerms ? entry.leakedTerms.join(", ") : "?"}`,
        );
        break;
      case "user_message":
        console.log(
          tag,
          `USER  #${entry.idx != null ? entry.idx : userMessageCounter} (${entry.lang || "?"}):`,
          shortPreview(entry.text),
        );
        break;
      case "user_transcript":
        if (entry.isFinal) {
          console.log(
            tag,
            `STT final (${entry.lang || "?"}):`,
            shortPreview(entry.text),
          );
        }
        break;
      case "tool_start":
        console.log(
          tag,
          `TOOL ${entry.name} start args=${truncate(JSON.stringify(entry.args || {}), 220)}`,
        );
        break;
      case "tool_end":
        console.log(
          tag,
          `TOOL ${entry.name} ${entry.ok ? "ok" : "FAIL"} (${entry.durationMs}ms)${entry.code ? " code=" + entry.code : ""}${entry.errorMessage ? " err=" + shortPreview(entry.errorMessage, 120) : ""}`,
        );
        break;
      case "reprompt":
        console.log(
          tag,
          `REPROMPT (${entry.reason}) lang=${entry.lang}${entry.missingTopic ? " topic=" + entry.missingTopic : ""}`,
        );
        break;
      case "generate_reply":
        console.log(
          tag,
          `generateReply ${entry.purpose || ""} lang=${entry.lang || "?"} slots=${truncate(entry.slotsSummary || "", 200)}`,
        );
        break;
      case "generate_reply_error":
        console.error(
          tag,
          `generateReply ERROR (${entry.purpose || ""}):`,
          entry.errorMessage,
        );
        break;
      case "stop_response":
        console.log(tag, `StopResponse (${entry.reason || ""})`);
        break;
      case "session_error":
        console.error(
          tag,
          `SESSION ERROR source=${entry.source}:`,
          entry.errorMessage,
        );
        break;
      case "language_detected":
        console.log(
          tag,
          `Language → ${entry.lang}${entry.locked ? " (locked)" : ""} from "${shortPreview(entry.from, 60)}"`,
        );
        break;
      case "greeting":
        console.log(tag, "Initial greeting sent");
        break;
      case "emergency_transfer_start":
        console.log(
          tag,
          `Emergency transfer start → ${entry.emergencyNumber || "?"} via=${entry.transferMethod || "?"}`,
        );
        break;
      case "emergency_transfer_end":
        console.log(
          tag,
          `Emergency transfer ${entry.ok ? "ok" : "failed"} via=${entry.transferMethod || "?"} ${entry.error || ""}`.trim(),
        );
        break;
      case "session_start":
        console.log(
          tag,
          `Call started — file=${filePath} pipeline=${entry.voicePipeline || "?"}`,
        );
        break;
      case "session_close":
        console.log(
          tag,
          `Call closed — reason=${entry.reason || "?"} duration=${entry.durationMs}ms turns=${entry.agentTurns}/${entry.userTurns}`,
        );
        break;
      case "speech_created":
        if (entry.source !== "generate_reply") {
          console.log(
            tag,
            `speech_created source=${entry.source} userInitiated=${entry.userInitiated}`,
          );
        }
        break;
      default:
        break;
    }
  };

  log("session_start", {
    roomName: String(roomName || ""),
    hospitalId: hospital && hospital._id ? String(hospital._id) : null,
    hospitalName: hospital && hospital.name ? String(hospital.name) : null,
    callerKey,
    callerPhone: callerPhone || null,
    voicePipeline: voicePipeline || null,
    pid: process.pid,
  });

  /* Event wiring ---------------------------------------------------------- */
  const onUserInputTranscribed = (ev) => {
    if (!ev) return;
    const text = String(ev.transcript || "");
    log("user_transcript", {
      text: truncate(text, 600),
      isFinal: Boolean(ev.isFinal),
      lang: ev.language || null,
    });
    /**
     * In the Sarvam-STT → OpenAI Realtime pipeline, `ConversationItemAdded`
     * never fires for the user side (the model takes the STT text directly).
     * Synthesise a `user_message` here so the JSONL has symmetric turns —
     * otherwise the conversation log reads agent-only.
     */
    if (ev.isFinal && text.trim()) {
      userMessageCounter += 1;
      lastUserMessageText = text.trim();
      lastUserMessageAt = Date.now();
      log("user_message", {
        idx: userMessageCounter,
        text: truncate(text, 1200),
        lang: ev.language || null,
        source: "stt_final",
      });
    }
  };

  const onConversationItemAdded = (ev) => {
    if (!ev || !ev.item) return;
    const text = extractItemText(ev.item);
    if (!text) return;
    messageCounter += 1;
    if (ev.item.role === "assistant") {
      agentMessageCounter += 1;
      const leaked = findBannedTermsInSpeech(text);
      log("agent_message", {
        idx: agentMessageCounter,
        text: truncate(text, 1200),
        leakedTerms: leaked.length ? leaked : undefined,
      });
      if (leaked.length) {
        log("speech_leak_detected", {
          agentIdx: agentMessageCounter,
          leakedTerms: leaked,
          textPreview: shortPreview(text, 200),
        });
      }
    } else if (ev.item.role === "user") {
      const trimmed = text.trim();
      /**
       * Dedupe: if `user_input_transcribed` already synthesised this exact
       * line moments ago (samvaad-llm path runs both events), skip the
       * duplicate so the JSONL is not noisy.
       */
      const isDup =
        trimmed &&
        trimmed === lastUserMessageText &&
        Date.now() - lastUserMessageAt < 5000;
      if (!isDup) {
        userMessageCounter += 1;
        lastUserMessageText = trimmed;
        lastUserMessageAt = Date.now();
        log("user_message", {
          idx: userMessageCounter,
          text: truncate(text, 1200),
          source: "conversation_item",
        });
      }
    }
  };

  const onAgentStateChanged = (ev) => {
    if (!ev) return;
    lastAgentState = ev.newState;
    log("agent_state", { from: ev.oldState, to: ev.newState });
  };

  const onUserStateChanged = (ev) => {
    if (!ev) return;
    lastUserState = ev.newState;
    log("user_state", { from: ev.oldState, to: ev.newState });
  };

  const onSpeechCreated = (ev) => {
    if (!ev) return;
    log("speech_created", {
      source: ev.source,
      userInitiated: Boolean(ev.userInitiated),
    });
  };

  const onError = (ev) => {
    if (!ev) return;
    const err = ev.error;
    log("session_error", {
      source:
        typeof ev.source === "string"
          ? ev.source
          : ev.source && ev.source.constructor
            ? ev.source.constructor.name
            : "unknown",
      errorMessage:
        err && err.message
          ? String(err.message)
          : typeof err === "string"
            ? err
            : truncate(JSON.stringify(err || null), 400),
    });
  };

  const startMs = Date.now();
  const onClose = (ev) => {
    log("session_close", {
      reason: (ev && ev.reason) || "unknown",
      errorMessage:
        ev && ev.error && ev.error.message ? String(ev.error.message) : null,
      durationMs: Date.now() - startMs,
      agentTurns: agentMessageCounter,
      userTurns: userMessageCounter,
      lastAgentState,
      lastUserState,
    });
    detach();
  };

  try {
    session.on(
      AgentSessionEventTypes.UserInputTranscribed,
      onUserInputTranscribed,
    );
    session.on(
      AgentSessionEventTypes.ConversationItemAdded,
      onConversationItemAdded,
    );
    session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
    session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
    session.on(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    session.on(AgentSessionEventTypes.Error, onError);
    session.once(AgentSessionEventTypes.Close, onClose);
  } catch (err) {
    console.warn(
      tag,
      "event wiring failed:",
      err && err.message ? err.message : err,
    );
  }

  function detach() {
    if (detached) return;
    detached = true;
    try {
      session.off(
        AgentSessionEventTypes.UserInputTranscribed,
        onUserInputTranscribed,
      );
      session.off(
        AgentSessionEventTypes.ConversationItemAdded,
        onConversationItemAdded,
      );
      session.off(
        AgentSessionEventTypes.AgentStateChanged,
        onAgentStateChanged,
      );
      session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
      session.off(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
      session.off(AgentSessionEventTypes.Error, onError);
    } catch (_) {
      /* ignore */
    }
    if (stream) {
      try {
        stream.end();
      } catch (_) {
        /* ignore */
      }
      stream = null;
    }
  }

  return {
    filePath: filePath || "",
    log,
    detach,
    /** convenience: bump tool counter so multiple tool calls can be paired */
    nextToolId: () => {
      toolCounter += 1;
      return toolCounter;
    },
  };
}

module.exports = {
  attachCallLogger,
};
