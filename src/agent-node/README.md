# Voice Agent (Node.js)

Same Neha / HealthFirst Hospital appointment agent – **pure Node.js** (no Python). Uses LiveKit Agents with Sarvam LLM and inference STT/TTS.

## Setup

```bash
cd voice-agent-node/agent-node
npm install
cp .env.example .env
# Edit .env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, SARVAM_API_KEY
```

Optional: copy from backend: `cp ../backend/.env .env`

## Download model files (first time)

Silero VAD and turn-detection models:

```bash
npm run build
npm run download-files
```

## Run

```bash
npm run dev
```

Keeps running and connects to LiveKit. When a user joins the room from the frontend, the agent joins and talks (Neha, Hindi/Gujarati from LLM; STT/TTS use inference models for now).

## Note

- **LLM**: Sarvam (sarvam-m) via OpenAI-compatible API.
- **STT/TTS**: Uses LiveKit inference (Deepgram, Cartesia). For best Hindi/Gujarati voice quality you can still use the Python agent (`agent/`), which uses Sarvam STT/TTS.
