# LiveKit Cloud dispatch (agent worker)

For the browser UI to talk to **Neha**, your worker must receive a job when a participant joins a room.

1. **Worker**
   - From repo root: `cd livekit-agent && npm install` (LiveKit npm deps; Mongo uses root `mongoose`).
   - **Default:** the worker also starts when you run **`npm run dev`** or **`npm start`** at the repo root (see `src/agent/startLiveKitWorker.js`). Set **`DISABLE_LIVEKIT_WORKER=1`** in `.env` to skip it, or run `node livekit-agent/main.js dev` alone if you prefer.
   - Same `.env` as the main app: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `MONGODB_URI`.
   - Optional: `AGENT_NAME` (default `phone-agent`) must match the agent you register in LiveKit.

2. **Room naming**
   - Web UI connects to `hospital-{mongoObjectId}` (MongoDB `_id` of the hospital).
   - The worker loads that hospital, applies [`getHospitalInstructions`](../src/agent/hospitalPrompt.js), and registers tools backed by [`runHospitalTool`](../src/agent/realtimeToolHandlers.js).

3. **Dispatch rule (LiveKit Cloud dashboard)**
   - Create or edit an **agent dispatch** so that when a room is created or a participant joins:
     - The agent named **`phone-agent`** (or your `AGENT_NAME`) is assigned to the room, **or**
     - Rooms matching a prefix / pattern (e.g. `hospital-*`) trigger the worker.
   - Exact steps vary by LiveKit UI version; see [LiveKit agent dispatch](https://docs.livekit.io/agents/worker/dispatch.md).

4. **Verify**
   - Join a room from [`/livekit`](../frontend/app/livekit/page.jsx) with a valid `hospitalId`.
   - Worker logs should show `JOB RECEIVED`, hospital name, and tool calls when booking.

5. **Hospitals list HTTP (optional)**
   - `resolveHospitalName` still calls `HOSPITALS_API_URL` (default `http://localhost:5002/hospitals`) for fallback naming; the primary path is MongoDB via `HospitalModel`.
