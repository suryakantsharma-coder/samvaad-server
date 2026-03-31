"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

const REALTIME_WS_URL =
  process.env.NEXT_PUBLIC_REALTIME_WS_URL ||
  "ws://localhost:3000/realtime-voice/698db7d0747cdef3ecafbf2e";
const TARGET_SAMPLE_RATE = 24000;
const SEND_INTERVAL_MS = 120;

function resampleTo24k16Bit(float32, sourceSampleRate) {
  const ratio = TARGET_SAMPLE_RATE / sourceSampleRate;
  const outLength = Math.floor(float32.length * ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i / ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = srcIdx - i0;
    const s = float32[i0] + frac * (float32[i1] - float32[i0]);
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    out[i] = v;
  }
  return out.buffer;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export default function RealtimeVoicePage() {
  const [status, setStatus] = useState("disconnected");
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [errorMsg, setErrorMsg] = useState(null);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sendIntervalRef = useRef(null);
  const pcmBufferRef = useRef([]);
  const audioQueueRef = useRef([]);
  const audioContextPlayRef = useRef(null);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef(null);
  const phaseRef = useRef("idle");
  phaseRef.current = phase;

  const addLine = useCallback((role, text) => {
    if (!text?.trim()) return;
    setTranscriptLines((prev) => [...prev, { role, text: text.trim() }]);
  }, []);

  const playPcm24k = useCallback((pcm) => {
    const ctx = audioContextPlayRef.current;
    if (!ctx || !pcm || pcm.length === 0) return;
    if (ctx.state === "suspended") ctx.resume();
    if (isPlayingRef.current) {
      audioQueueRef.current.push(pcm);
      return;
    }
    isPlayingRef.current = true;
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
    const audioBuffer = ctx.createBuffer(1, float32.length, TARGET_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    currentSourceRef.current = source;
    source.onended = () => {
      currentSourceRef.current = null;
      isPlayingRef.current = false;
      const next = audioQueueRef.current.shift();
      if (next) playPcm24k(next);
      else setPhase((p) => (p === "speaking" ? "idle" : p));
    };
    source.start(0);
  }, []);

  const stopMic = useCallback(() => {
    clearInterval(sendIntervalRef.current);
    sendIntervalRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (processorRef.current && audioContextRef.current) {
      try {
        processorRef.current.disconnect();
        audioContextRef.current.close();
      } catch (e) {}
      processorRef.current = null;
      audioContextRef.current = null;
    }
    setPhase((p) => (p === "recording" ? "idle" : p));
  }, []);

  const startMic = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    if (phaseRef.current === "recording") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const rate = ctx.sampleRate;
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const pcm24 = resampleTo24k16Bit(input, rate);
        pcmBufferRef.current.push(new Uint8Array(pcm24));
      };

      src.connect(processor);
      processor.connect(ctx.destination);
      pcmBufferRef.current = [];
      setPhase("recording");
      setErrorMsg(null);

      sendIntervalRef.current = setInterval(() => {
        if (pcmBufferRef.current.length === 0) return;
        const chunks = pcmBufferRef.current;
        pcmBufferRef.current = [];
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          combined.set(c, offset);
          offset += c.length;
        }
        wsRef.current?.send(
          JSON.stringify({
            type: "audio",
            data: arrayBufferToBase64(combined.buffer),
          }),
        );
      }, SEND_INTERVAL_MS);
    } catch (err) {
      console.error("Mic error:", err);
      setErrorMsg("Microphone access denied or unavailable.");
    }
  }, []);

  const toggleMic = useCallback(() => {
    if (phaseRef.current === "recording") {
      stopMic();
      return;
    }
    startMic();
  }, [stopMic, startMic]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioContextPlayRef.current = ctx;
    return () => {
      ctx.close();
      audioContextPlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    setStatus("connecting");
    setErrorMsg(null);
    const ws = new WebSocket(REALTIME_WS_URL);
    ws.onopen = () => setStatus("connected");
    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => {
      setStatus("error");
      setErrorMsg("WebSocket error. Is the backend running on port 3000?");
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "ready":
            break;
          case "audio": {
            const ctx = audioContextPlayRef.current;
            if (ctx?.state === "suspended") ctx.resume();
            const buffer = base64ToArrayBuffer(msg.data);
            const pcm = new Int16Array(buffer);
            setPhase("speaking");
            playPcm24k(pcm);
            break;
          }
          case "transcript":
            addLine(msg.role || "assistant", msg.text);
            break;
          case "error":
            setErrorMsg(msg.message || "Error");
            setPhase("idle");
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("Parse error:", e);
      }
    };
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [addLine, playPcm24k]);

  useEffect(() => {
    return () => {
      clearInterval(sendIntervalRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (processorRef.current && audioContextRef.current) {
        try {
          processorRef.current.disconnect();
          audioContextRef.current.close();
        } catch (e) {}
      }
    };
  }, []);

  const phaseLabel = {
    idle: "Tap to start talking",
    recording: "Listening… tap to stop and send",
    processing: "Thinking…",
    speaking: "Speaking",
  }[phase];

  return (
    <main className="container">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <Link href="/" style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
          ← Sarvam Voice
        </Link>
        <span style={{ color: "#475569" }}>|</span>
        <Link href="/livekit" style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
          LiveKit →
        </Link>
      </div>
      <h1>Realtime Voice (OpenAI)</h1>
      <span className={`status ${status}`}>
        {status === "connecting" && "Connecting…"}
        {status === "connected" && "Connected"}
        {status === "disconnected" && "Disconnected"}
        {status === "error" && "Error"}
      </span>
      {status === "connected" && <span className="phase">{phaseLabel}</span>}
      {errorMsg && <p className="errorMsg">{errorMsg}</p>}
      <div className="transcript">
        {transcriptLines.length === 0 && (
          <div className="line system">
            Tap mic to start talking, tap again to stop and send. Like ChatGPT
            voice.
          </div>
        )}
        {transcriptLines.map((line, i) => (
          <div key={i} className={`line ${line.role}`}>
            {line.role === "user" && "You: "}
            {line.role === "assistant" && "Assistant: "}
            {line.text}
          </div>
        ))}
      </div>
      {status === "connected" && (
        <div className="micWrap">
          <button
            type="button"
            className={`micBtn ${phase === "recording" ? "recording" : ""} ${phase === "processing" ? "processing" : ""}`}
            disabled={phase === "processing"}
            onClick={toggleMic}
            aria-label={
              phase === "recording"
                ? "Tap to stop and send"
                : "Tap to start talking"
            }
          >
            <MicIcon />
          </button>
          <span className="hint">
            {phase === "recording" && "Tap again to stop and send"}
            {phase !== "recording" &&
              phase !== "processing" &&
              "Tap to start talking"}
            {phase === "processing" && "Thinking…"}
          </span>
        </div>
      )}
    </main>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z" />
      <path d="M19 11v1a7 7 0 0 1-14 0v-1h2v1a5 5 0 0 0 10 0v-1h2Z" />
      <path d="M12 16a2 2 0 0 0 2-2v-1H10v1a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
