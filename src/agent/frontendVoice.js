/**
 * Frontend Voice Agent — same flow as Exotel agent (mic → STT → LLM → TTS) but for browser.
 * No Exotel. Use from frontend: connect to WebSocket, send audio, receive TTS audio.
 *
 * Protocol (JSON over WebSocket):
 * - Client → Server: { type: 'audio', data: base64 } (24kHz 16-bit mono PCM), { type: 'flush' } to end turn
 * - Server → Client: { type: 'ready' }, { type: 'greeting', text }, { type: 'audio', data: base64 } (8kHz PCM),
 *   { type: 'transcript', text }, { type: 'response', text }, { type: 'audio', data: base64 }, { type: 'response_end' }, { type: 'error', message }
 *
 * Run: mounted on main app at /voice when npm run dev starts (see src/app.js).
 *
 * Frontend usage (same origin or allow ws in CORS):
 *   const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/voice');
 *   ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.type === 'audio') playBase64PCM(msg.data); };
 *   // Send mic: ws.send(JSON.stringify({ type: 'audio', data: base64PCM24k })); when done: ws.send(JSON.stringify({ type: 'flush' }));
 */

const WebSocket = require("ws");
const OpenAI = require("openai").default;
const { resample24kTo8k, pcm24kToWavBuffer } = require("./audioUtils");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;

const SARVAM_WS_STT = "wss://api.sarvam.ai/speech-to-text/ws";
const SARVAM_WS_TTS = "wss://api.sarvam.ai/text-to-speech/ws";

const SAMPLE_RATE_24K = 24000;
const SAMPLE_WIDTH = 2;
const MIN_PCM_BYTES = (SAMPLE_RATE_24K * SAMPLE_WIDTH * 200) / 1000; // 200ms min to transcribe

const SYSTEM_PROMPT = `You are Neha, a polite female AI hospital receptionist. Speak only in Hindi or Gujarati based on the user's language.
Help users with appointment booking: greet, ask language (Hindi/Gujarati), then collect name, age, phone, preferred date/time and doctor.
Keep replies short and natural. Do not diagnose or prescribe.`;

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.error("[FrontendVoice] send error:", e.message);
    }
  }
}

function transcribeWithSarvamRest(wavBuffer) {
  if (!SARVAM_API_KEY) return Promise.resolve("");
  const { SarvamAIClient } = require("sarvamai");
  const client = new SarvamAIClient({
    apiSubscriptionKey: SARVAM_API_KEY,
  });
  return client.speechToText
    .transcribe({ file: wavBuffer })
    .then((res) => {
      const body = res?.data ?? res;
      const text =
        (body && (body.transcript ?? body.text ?? body.transcription)) || "";
      return String(text).trim();
    })
    .catch((err) => {
      console.error("[FrontendVoice] Sarvam STT error:", err.message);
      return "";
    });
}

function connectSarvamTtsForFrontend(onAudioChunk, onReady) {
  if (!SARVAM_API_KEY) {
    onReady(null);
    return null;
  }
  const url = `${SARVAM_WS_TTS}?model=bulbul:v3-beta`;
  const ttsWs = new WebSocket(url, {
    headers: { "Api-Subscription-Key": SARVAM_API_KEY },
  });
  ttsWs.on("open", () => {
    ttsWs.send(
      JSON.stringify({
        type: "config",
        data: {
          target_language_code: "hi-IN",
          speaker: "pooja",
          model: "bulbul:v3-beta",
          speech_sample_rate: "8000",
          output_audio_codec: "linear16",
          max_chunk_length: 500,
          pace: 1.1,
        },
      }),
    );
    onReady(ttsWs);
  });
  ttsWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "audio" && msg.data && msg.data.audio) {
        let pcm = Buffer.from(msg.data.audio, "base64");
        if (pcm.length >= 44 && pcm[0] === 0x52 && pcm[1] === 0x49) {
          pcm = pcm.subarray(44);
        }
        const rate = Number(msg.data.speech_sample_rate) || 8000;
        const is24k = rate === 24000;
        const pcm8k = is24k ? resample24kTo8k(pcm) : pcm;
        onAudioChunk(pcm8k.toString("base64"));
      }
    } catch (e) {
      console.error("[FrontendVoice] TTS parse error:", e.message);
    }
  });
  ttsWs.on("error", (err) => {
    console.error("[FrontendVoice] TTS WS error:", err.message);
  });
  return ttsWs;
}

function handleConnection(ws) {
  const id = `fv-${Date.now()}`;
  console.log(`[FrontendVoice] ${id} connected`);

  let pcmBuffer = Buffer.alloc(0);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  let ttsWs = null;
  let openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
  let processing = false;

  let replyResponseEndTimer = null;
  let expectingReplyTts = false;

  const scheduleResponseEnd = () => {
    if (replyResponseEndTimer) clearTimeout(replyResponseEndTimer);
    replyResponseEndTimer = setTimeout(() => {
      replyResponseEndTimer = null;
      expectingReplyTts = false;
      send(ws, { type: "response_end" });
    }, 950);
  };

  const onTtsAudioChunk = (base64) => {
    send(ws, { type: "audio", data: base64 });
    if (expectingReplyTts) scheduleResponseEnd();
  };

  send(ws, { type: "ready" });

  const greetingText =
    "नमस्ते, मैं नेहा बोल रही हूँ। आप हिंदी में बात करना चाहेंगे या गुजराती में?";
  send(ws, { type: "greeting", text: greetingText });

  connectSarvamTtsForFrontend(onTtsAudioChunk, (wsRef) => {
    ttsWs = wsRef;
    if (ttsWs && greetingText) {
      ttsWs.send(
        JSON.stringify({
          type: "text",
          data: { text: greetingText },
        }),
      );
      ttsWs.send(JSON.stringify({ type: "flush" }));
    }
  });

  ws.on("message", async (raw) => {
    if (processing) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }
    if (msg.type === "audio" && msg.data) {
      const chunk = Buffer.from(msg.data, "base64");
      if (chunk.length > 0) {
        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
      }
      return;
    }
    if (msg.type === "flush") {
      if (pcmBuffer.length < MIN_PCM_BYTES) {
        pcmBuffer = Buffer.alloc(0);
        return;
      }
      const wav = pcm24kToWavBuffer(pcmBuffer);
      pcmBuffer = Buffer.alloc(0);
      processing = true;
      try {
        const transcript = await transcribeWithSarvamRest(wav);
        if (!transcript) {
          processing = false;
          return;
        }
        send(ws, { type: "transcript", text: transcript });
        messages.push({ role: "user", content: transcript });

        if (!openai) {
          send(ws, {
            type: "error",
            message: "OPENAI_API_KEY not set",
          });
          processing = false;
          return;
        }

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 300,
        });
        const reply = completion?.choices?.[0]?.message?.content?.trim() || "";
        if (!reply) {
          processing = false;
          return;
        }
        messages.push({ role: "assistant", content: reply });
        send(ws, { type: "response", text: reply });

        if (ttsWs && ttsWs.readyState === WebSocket.OPEN) {
          expectingReplyTts = true;
          if (replyResponseEndTimer) clearTimeout(replyResponseEndTimer);
          replyResponseEndTimer = setTimeout(() => {
            replyResponseEndTimer = null;
            expectingReplyTts = false;
            send(ws, { type: "response_end" });
          }, 12000);
          ttsWs.send(JSON.stringify({ type: "text", data: { text: reply } }));
          ttsWs.send(JSON.stringify({ type: "flush" }));
        } else {
          send(ws, { type: "response_end" });
        }
      } catch (err) {
        console.error("[FrontendVoice] Error:", err.message);
        send(ws, {
          type: "error",
          message: err.message || "Processing failed",
        });
      }
      processing = false;
    }
  });

  ws.on("close", () => {
    if (ttsWs && ttsWs.readyState === WebSocket.OPEN) {
      try {
        ttsWs.close();
      } catch (e) {}
    }
    console.log(`[FrontendVoice] ${id} disconnected`);
  });

  ws.on("error", (err) => {
    console.error("[FrontendVoice] WS error:", err.message);
  });
}

/**
 * Mount the frontend voice WebSocket on the Express app.
 * Call this after express-ws is applied: app.ws('/voice', ...)
 *
 * @param {import('express').Application} app - Express app with express-ws
 */
function mountFrontendVoice(app) {
  if (typeof app.ws !== "function") {
    console.warn(
      "[FrontendVoice] app.ws is not available. Add express-ws to the app first.",
    );
    return;
  }
  app.ws("/voice", (ws) => {
    handleConnection(ws);
  });
  console.log(
    "[FrontendVoice] WebSocket mounted at /voice (use same origin, e.g. ws://localhost:3000/voice)",
  );
}

module.exports = { mountFrontendVoice, handleConnection };
