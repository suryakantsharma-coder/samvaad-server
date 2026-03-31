/**
 * Realtime Voice Agent — OpenAI Realtime API over WebSocket.
 * Uses the same hospital prompt and API as index.js (Exotel agent).
 *
 * Routes:
 * - /realtime-voice/:hospitalId — Hospital flow: Neha receptionist, list_doctors, create_patient, create_appointment, etc.
 * - /realtime-voice — Generic voice assistant (no tools, no hospital).
 *
 * Protocol (JSON over WebSocket):
 * - Client → Server: { type: 'audio', data: base64 } (24kHz 16-bit mono PCM)
 * - Server → Client: { type: 'ready' }, { type: 'audio', data }, { type: 'transcript', role, text }, { type: 'error', message }
 */

const WebSocket = require("ws");
const mongoose = require("mongoose");
const HospitalModel = require("../models/hospital.model");
const { getHospitalInstructions } = require("./hospitalPrompt");
const { getRealtimeTools } = require("./realtimeTools");
const { runHospitalTool } = require("./realtimeToolHandlers");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = "gpt-realtime-mini-2025-12-15";

const DEFAULT_INSTRUCTIONS = `You are a helpful, friendly voice assistant. Speak clearly and concisely. 
Respond in the same language the user uses (Hindi, English, or Gujarati).`;

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error("[RealtimeVoice] send error:", e.message);
    }
  }
}

async function handleConnection(clientWs, req = {}) {
  const params = req.params || {};
  const hospitalId = params.hospitalId;
  const id = `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (!OPENAI_API_KEY) {
    send(clientWs, { type: "error", message: "OPENAI_API_KEY not set" });
    return;
  }

  let instructions = DEFAULT_INSTRUCTIONS;
  let tools = [];
  let tool_choice = null;
  let hospital = null;

  if (hospitalId) {
    if (!mongoose.isValidObjectId(hospitalId)) {
      send(clientWs, { type: "error", message: "Invalid hospital ID" });
      return;
    }
    try {
      hospital = await HospitalModel.findById(hospitalId).lean();
      if (!hospital) {
        send(clientWs, { type: "error", message: "Hospital not found" });
        return;
      }
      instructions = await getHospitalInstructions(hospital, null);
      tools = getRealtimeTools();
      tool_choice = "auto";
      console.log(`[RealtimeVoice] ${id} hospital mode: ${hospital.name} (${hospitalId})`);
    } catch (err) {
      console.error("[RealtimeVoice] Hospital load error:", err.message);
      send(clientWs, { type: "error", message: err.message || "Failed to load hospital" });
      return;
    }
  } else {
    console.log(`[RealtimeVoice] ${id} frontend connected (generic mode)`);
  }

  const url = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
  let openaiWs = null;
  const pendingFunctionCalls = {};

  try {
    openaiWs = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
  } catch (err) {
    console.error("[RealtimeVoice] OpenAI WS create error:", err.message);
    send(clientWs, { type: "error", message: err.message });
    return;
  }

  const hospitalObjectId = hospital ? hospital._id : null;

  const sendToolOutput = (callId, outputObj) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    try {
      openaiWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(outputObj ?? {}),
          },
        }),
      );
      openaiWs.send(JSON.stringify({ type: "response.create" }));
    } catch (e) {
      console.error("[RealtimeVoice] sendToolOutput error:", e.message);
    }
  };

  const runTool = async (callId, name, args) => {
    console.log(`[RealtimeVoice] ${id} tool: ${name} | hospitalId: ${String(hospitalObjectId || "")}`);
    const outputObj = await runHospitalTool(hospitalObjectId, name, args, { callerPhone: null });
    sendToolOutput(callId, outputObj);
  };

  openaiWs.on("open", () => {
    console.log(`[RealtimeVoice] ${id} OpenAI Realtime connected`);
    send(clientWs, { type: "ready" });
    const session = {
      modalities: ["text", "audio"],
      instructions,
      voice: "alloy",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    };
    if (tools.length > 0) {
      session.tools = tools;
      session.tool_choice = tool_choice;
    }
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session,
      }),
    );
  });

  openaiWs.on("message", (message) => {
    try {
      const event = JSON.parse(message.toString());

      if (
        event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta"
      ) {
        const b64 = event.delta ?? event.audio;
        if (b64) send(clientWs, { type: "audio", data: b64 });
        return;
      }

      if (
        event.type === "conversation.item.created" &&
        event.item?.type === "function_call"
      ) {
        const { name, arguments: argsJson, call_id } = event.item;
        let args = {};
        try {
          args = argsJson ? JSON.parse(argsJson) : {};
        } catch (e) {
          console.error("[RealtimeVoice] Failed to parse function args:", argsJson);
        }
        if (Object.keys(args).length > 0) {
          runTool(call_id, name, args);
        } else {
          pendingFunctionCalls[call_id] = { name };
        }
        return;
      }

      if (
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        const { name, call_id } = event.item;
        pendingFunctionCalls[call_id] = { name };
        const argsJson = event.item.arguments;
        if (argsJson) {
          try {
            const args = JSON.parse(argsJson);
            delete pendingFunctionCalls[call_id];
            runTool(call_id, name, args);
          } catch (e) {
            console.error("[RealtimeVoice] Failed to parse function args (output_item.added):", argsJson);
          }
        }
        return;
      }

      if (event.type === "response.function_call_arguments.done") {
        const { call_id, arguments: argsJson } = event;
        const pending = pendingFunctionCalls[call_id];
        if (pending) {
          delete pendingFunctionCalls[call_id];
          let args = {};
          try {
            args = argsJson ? JSON.parse(argsJson) : {};
          } catch (e) {
            console.error("[RealtimeVoice] Failed to parse function args (arguments.done):", argsJson);
          }
          runTool(call_id, pending.name, args);
        }
        return;
      }

      if (
        event.type === "conversation.item.input_audio_transcription.completed" &&
        event.transcript
      ) {
        send(clientWs, { type: "transcript", role: "user", text: event.transcript });
        return;
      }

      if (
        event.type === "response.output_audio_transcript.done" ||
        event.type === "response.audio_transcript.done"
      ) {
        if (event.transcript) {
          send(clientWs, { type: "transcript", role: "assistant", text: event.transcript });
        }
        return;
      }

      if (event.type === "error") {
        console.error("[RealtimeVoice] OpenAI event error:", event);
        send(clientWs, { type: "error", message: event.error?.message || "OpenAI error" });
      }
    } catch (e) {
      console.error("[RealtimeVoice] OpenAI message parse error:", e.message);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("[RealtimeVoice] OpenAI WS error:", err.message);
    send(clientWs, { type: "error", message: err.message });
  });

  openaiWs.on("close", () => {
    console.log(`[RealtimeVoice] ${id} OpenAI closed`);
  });

  clientWs.on("message", (raw) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "audio" && msg.data) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.data,
          }),
        );
      }
    } catch (e) {
      console.error("[RealtimeVoice] Client message parse error:", e.message);
    }
  });

  clientWs.on("close", () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.close();
      } catch (e) {}
    }
    console.log(`[RealtimeVoice] ${id} frontend disconnected`);
  });

  clientWs.on("error", (err) => {
    console.error("[RealtimeVoice] Client WS error:", err.message);
  });
}

function mountRealtimeVoice(app) {
  if (typeof app.ws !== "function") {
    console.warn("[RealtimeVoice] app.ws not available. Add express-ws first.");
    return;
  }
  app.ws("/realtime-voice/:hospitalId", (ws, req) => handleConnection(ws, req));
  app.ws("/realtime-voice", (ws, req) => handleConnection(ws, req));
  console.log("[RealtimeVoice] WebSocket mounted at /realtime-voice and /realtime-voice/:hospitalId");
}

module.exports = { mountRealtimeVoice, handleConnection };
