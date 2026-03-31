"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Room, RoomEvent, Track } from "livekit-client";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

function LiveKitVoiceInner() {
  const searchParams = useSearchParams();
  const [hospitalId, setHospitalId] = useState("");

  useEffect(() => {
    const q = (searchParams.get("hospitalId") || "").trim();
    if (q) setHospitalId(q);
  }, [searchParams]);

  const [status, setStatus] = useState("disconnected");
  const [errorMsg, setErrorMsg] = useState(null);
  const [phase, setPhase] = useState("idle");

  const roomRef = useRef(null);
  const audioContainerRef = useRef(null);

  const disconnect = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      try {
        room.disconnect();
      } catch (e) {}
    }
    if (audioContainerRef.current) {
      audioContainerRef.current.replaceChildren();
    }
    setStatus("disconnected");
    setPhase("idle");
  }, []);

  const connect = useCallback(async () => {
    if (!hospitalId) {
      setErrorMsg("Add ?hospitalId=yourMongoHospitalId to the URL.");
      return;
    }
    setErrorMsg(null);
    setStatus("connecting");
    setPhase("connecting");

    const roomName = `hospital-${hospitalId}`;
    let room = roomRef.current;
    if (room) await disconnect();

    try {
      const res = await fetch(
        `${API_BASE}/api/livekit/token?roomName=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(`web-${Date.now()}`)}`,
      );
      const json = await res.json();
      if (!res.ok || !json.success || !json.data?.token || !json.data?.url) {
        throw new Error(json.message || "Failed to get LiveKit token");
      }
      const { url, token } = json.data;

      room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.Disconnected, () => {
        setStatus("disconnected");
        setPhase("idle");
      });

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        if (participant.isLocal) return;
        const el = track.attach();
        el.autoplay = true;
        audioContainerRef.current?.appendChild(el);
        track.on("ended", () => el.remove());
      });

      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);

      setStatus("connected");
      setPhase("connected");
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message || "Connection failed");
      setStatus("error");
      setPhase("idle");
      await disconnect();
    }
  }, [hospitalId, disconnect]);

  useEffect(() => {
    return () => {
      const r = roomRef.current;
      if (r) {
        try {
          r.disconnect();
        } catch (e) {}
        roomRef.current = null;
      }
    };
  }, []);

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
          Sarvam Voice
        </Link>
        <span style={{ color: "#475569" }}>|</span>
        <Link href="/realtime" style={{ color: "#94a3b8", fontSize: "0.875rem" }}>
          OpenAI WS
        </Link>
      </div>
      <h1>LiveKit voice (primary)</h1>
      <p style={{ color: "#94a3b8", fontSize: "0.875rem", maxWidth: "36rem" }}>
        Joins room <code>hospital-{"{"}id{"}"}</code> on your LiveKit project. Ensure the worker
        is running (<code>npm run dev</code> in <code>livekit-agent/</code>) and dispatch is
        configured in LiveKit Cloud.
      </p>

      <label style={{ display: "block", marginTop: "1rem" }}>
        Hospital ID (MongoDB _id)
        <input
          type="text"
          value={hospitalId}
          onChange={(e) => setHospitalId(e.target.value.trim())}
          placeholder="Paste hospital ObjectId"
          style={{
            display: "block",
            marginTop: "0.25rem",
            width: "100%",
            maxWidth: "24rem",
            padding: "0.5rem",
            background: "#0f172a",
            border: "1px solid #334155",
            borderRadius: "6px",
            color: "#e2e8f0",
          }}
        />
      </label>
      {!hospitalId && (
        <p className="errorMsg" style={{ marginTop: "0.5rem" }}>
          Set <code>?hospitalId=...</code> in the URL or paste the id above (from GET /hospitals on
          agent port or admin).
        </p>
      )}

      {errorMsg && <p className="errorMsg">{errorMsg}</p>}

      <span className={`status ${status}`} style={{ marginTop: "1rem", display: "block" }}>
        {status === "connecting" && "Connecting…"}
        {status === "connected" && "Connected"}
        {status === "disconnected" && "Disconnected"}
        {status === "error" && "Error"}
      </span>
      {phase === "connected" && (
        <span className="phase">Mic is on — speak with Neha (LiveKit + OpenAI Realtime)</span>
      )}

      <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.75rem" }}>
        <button
          type="button"
          className="micBtn"
          disabled={!hospitalId || status === "connecting"}
          onClick={status === "connected" ? disconnect : connect}
        >
          {status === "connected" ? "Disconnect" : "Connect & start mic"}
        </button>
      </div>

      <div ref={audioContainerRef} style={{ marginTop: "1rem" }} aria-live="polite" />
    </main>
  );
}

export default function LiveKitVoicePage() {
  return (
    <Suspense
      fallback={
        <main className="container">
          <p>Loading…</p>
        </main>
      }
    >
      <LiveKitVoiceInner />
    </Suspense>
  );
}
