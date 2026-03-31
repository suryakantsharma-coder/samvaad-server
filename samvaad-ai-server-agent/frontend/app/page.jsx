"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3000/voice";
const TARGET_SAMPLE_RATE = 24000;
const SEND_INTERVAL_MS = 120;
const TTS_PLAYBACK_RATE = 0.85;

// VAD: silence (ms) after speech to consider "user stopped"
const SILENCE_AFTER_SPEECH_MS = 900;
const SPEECH_RMS_THRESHOLD = 0.015;
const INTERRUPT_RMS_THRESHOLD = 0.012;

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
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function computeRms(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return float32.length > 0 ? Math.sqrt(sum / float32.length) : 0;
}

export default function VoicePage() {
  const [status, setStatus] = useState("disconnected");
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [phase, setPhase] = useState("idle"); // idle | listening | processing | speaking
  const [errorMsg, setErrorMsg] = useState(null);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sendIntervalRef = useRef(null);
  const pcmBufferRef = useRef([]);
  const audioChunkBufferRef = useRef([]);
  const audioContextPlayRef = useRef(null);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef(null);
  const pendingPlayRef = useRef(null);
  const hasFlushedOnceRef = useRef(false);
  const greetingPlayTimeoutRef = useRef(null);

  const vadSpeechEndTimeoutRef = useRef(null);
  const vadLastSpeechRef = useRef(0);
  const vadHadSpeechRef = useRef(false);
  const phaseRef = useRef("idle");
  phaseRef.current = phase;

  const addLine = useCallback((role, text) => {
    if (!text?.trim()) return;
    setTranscriptLines((prev) => [...prev, { role, text: text.trim() }]);
  }, []);

  const stopPlayback = useCallback(() => {
    try {
      if (currentSourceRef.current) {
        currentSourceRef.current.stop(0);
        currentSourceRef.current.disconnect();
        currentSourceRef.current = null;
      }
    } catch (e) {}
    isPlayingRef.current = false;
    pendingPlayRef.current = null;
    audioChunkBufferRef.current = [];
  }, []);

  const playPcmBuffer = useCallback((pcm) => {
    const ctx = audioContextPlayRef.current;
    if (!ctx || !pcm || pcm.length === 0) return;
    if (ctx.state === "suspended") ctx.resume();

    const run = () => {
      if (isPlayingRef.current) {
        pendingPlayRef.current = pcm;
        return;
      }
      isPlayingRef.current = true;
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
      const audioBuffer = ctx.createBuffer(1, float32.length, 8000);
      audioBuffer.getChannelData(0).set(float32);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = TTS_PLAYBACK_RATE;
      source.connect(ctx.destination);
      currentSourceRef.current = source;
      source.onended = () => {
        currentSourceRef.current = null;
        isPlayingRef.current = false;
        const next = pendingPlayRef.current;
        pendingPlayRef.current = null;
        if (next) playPcmBuffer(next);
        else setPhase((p) => (p === "speaking" ? "listening" : p));
      };
      source.start(0);
    };
    run();
  }, []);

  const flushAndPlayBuffer = useCallback(() => {
    if (greetingPlayTimeoutRef.current) {
      clearTimeout(greetingPlayTimeoutRef.current);
      greetingPlayTimeoutRef.current = null;
    }
    hasFlushedOnceRef.current = true;
    const chunks = audioChunkBufferRef.current;
    audioChunkBufferRef.current = [];
    if (chunks.length === 0) return;
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    playPcmBuffer(combined);
    setPhase("speaking");
  }, [playPcmBuffer]);

  const pushAudioChunk = useCallback((base64Pcm8k) => {
    const buffer = base64ToArrayBuffer(base64Pcm8k);
    const pcm = new Int16Array(buffer);
    audioChunkBufferRef.current.push(pcm);
    if (!hasFlushedOnceRef.current && greetingPlayTimeoutRef.current == null) {
      greetingPlayTimeoutRef.current = setTimeout(() => {
        greetingPlayTimeoutRef.current = null;
        if (!hasFlushedOnceRef.current && audioChunkBufferRef.current.length > 0) {
          flushAndPlayBuffer();
        }
      }, 1200);
    }
  }, [flushAndPlayBuffer]);

  const startMic = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
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
        const rms = computeRms(input);

        if (phaseRef.current === "speaking" && rms > INTERRUPT_RMS_THRESHOLD) {
          setPhase("listening");
          stopPlayback();
        }

        const isSpeech = rms > SPEECH_RMS_THRESHOLD;
        if (isSpeech) {
          vadLastSpeechRef.current = Date.now();
          vadHadSpeechRef.current = true;
          if (vadSpeechEndTimeoutRef.current) {
            clearTimeout(vadSpeechEndTimeoutRef.current);
            vadSpeechEndTimeoutRef.current = null;
          }
        }

        if (vadHadSpeechRef.current && isSpeech) {
          const pcm24 = resampleTo24k16Bit(input, rate);
          pcmBufferRef.current.push(new Uint8Array(pcm24));
        }

        if (vadHadSpeechRef.current && !isSpeech) {
          if (!vadSpeechEndTimeoutRef.current) {
            vadSpeechEndTimeoutRef.current = setTimeout(() => {
              vadSpeechEndTimeoutRef.current = null;
              vadHadSpeechRef.current = false;
              if (wsRef.current?.readyState === 1) {
                if (pcmBufferRef.current.length > 0) {
                  const chunks = pcmBufferRef.current;
                  pcmBufferRef.current = [];
                  const total = chunks.reduce((acc, c) => acc + c.length, 0);
                  const combined = new Uint8Array(total);
                  let offset = 0;
                  for (const c of chunks) {
                    combined.set(c, offset);
                    offset += c.length;
                  }
                  wsRef.current.send(JSON.stringify({ type: "audio", data: arrayBufferToBase64(combined.buffer) }));
                }
                wsRef.current.send(JSON.stringify({ type: "flush" }));
                setPhase("processing");
              }
            }, SILENCE_AFTER_SPEECH_MS);
          }
        }
      };

      src.connect(processor);
      processor.connect(ctx.destination);
      pcmBufferRef.current = [];
      setPhase("listening");
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
        const base64 = arrayBufferToBase64(combined.buffer);
        wsRef.current?.send(JSON.stringify({ type: "audio", data: base64 }));
      }, SEND_INTERVAL_MS);
    } catch (err) {
      console.error("Mic error:", err);
      setErrorMsg("Microphone access denied or unavailable.");
    }
  }, [phase, stopPlayback]);

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
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setStatus("connected");
    };
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
          case "greeting":
            addLine("system", msg.text);
            break;
          case "audio":
            pushAudioChunk(msg.data);
            break;
          case "transcript":
            audioChunkBufferRef.current = [];
            addLine("user", msg.text);
            setPhase("processing");
            break;
          case "response":
            audioChunkBufferRef.current = [];
            addLine("assistant", msg.text);
            break;
          case "response_end":
            flushAndPlayBuffer();
            setPhase("speaking");
            break;
          case "error":
            setErrorMsg(msg.message || "Error");
            setPhase("listening");
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("Parse message error:", e);
      }
    };

    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [addLine, pushAudioChunk, flushAndPlayBuffer]);

  useEffect(() => {
    if (status === "connected" && phase === "idle") {
      startMic();
    }
  }, [status, phase, startMic]);

  useEffect(() => {
    return () => {
      clearInterval(sendIntervalRef.current);
      if (vadSpeechEndTimeoutRef.current) clearTimeout(vadSpeechEndTimeoutRef.current);
      if (greetingPlayTimeoutRef.current) clearTimeout(greetingPlayTimeoutRef.current);
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
    idle: "Starting…",
    listening: "Listening…",
    processing: "Thinking…",
    speaking: "Speaking",
  }[phase];

  return (
    <main className="container">
      <h1>Voice Agent</h1>
      <span className={`status ${status}`}>
        {status === "connecting" && "Connecting…"}
        {status === "connected" && "Connected"}
        {status === "disconnected" && "Disconnected"}
        {status === "error" && "Error"}
      </span>
      {status === "connected" && (
        <span className="phase">{phaseLabel}</span>
      )}
      {errorMsg && <p className="errorMsg">{errorMsg}</p>}

      <div className="transcript">
        {transcriptLines.length === 0 && (
          <div className="line system">Mic is on. Start talking when you hear the greeting.</div>
        )}
        {transcriptLines.map((line, i) => (
          <div key={i} className={`line ${line.role}`}>
            {line.role === "user" && "You: "}
            {line.role === "assistant" && "Neha: "}
            {line.text}
          </div>
        ))}
      </div>
    </main>
  );
}
