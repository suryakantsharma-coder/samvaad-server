/**
 * Phone Queue Worker
 * -----------------
 * A separate LiveKit agent (agentName = QUEUE_AGENT_NAME, default "phone-queue")
 * that acts as a gatekeeper BEFORE every call reaches the real phone-agent.
 *
 * Flow:
 *   Incoming call (dispatched to "phone-queue")
 *     ↓
 *   tryAcquireSlot()
 *     ↓ slot free?
 *   YES → dispatch "phone-agent" directly, return
 *   NO  → ctx.connect() → play waiting messages (Hindi) → poll for slot
 *           → slot acquired → play "Connecting you now" → dispatch "phone-agent"
 *           → timeout → play apology → return
 *
 * The real phone-agent (livekit-agent/main.js) is NEVER modified.
 * All business logic, prompts, tools, and booking flows remain untouched.
 *
 * SETUP:
 *   1. Start this worker alongside the existing phone-agent worker.
 *   2. Configure your LiveKit SIP dispatch to target agent name "phone-queue"
 *      (env QUEUE_AGENT_NAME) instead of "phone-agent".
 *   3. Set QUEUE_MAX_CONCURRENT_CALLS to the max simultaneous calls you want.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.TZ) process.env.TZ = 'Asia/Kolkata';

const { ServerOptions, cli, defineAgent, voice } = require('@livekit/agents');
const openai = require('@livekit/agents-plugin-openai');
const { AgentDispatchClient, RoomServiceClient } = require('livekit-server-sdk');

const queueConfig = require('./queue/queueConfig');
const queueService = require('./queue/queueService');
const queueAudio = require('./queue/queueAudio');
const { startHoldAudio } = require('./queue/queueHoldAudio');
const { closeQueueRedis } = require('./queue/queueRedis');
const { logQueueStatus } = require('./queue/queueMonitor');
const { parseEnvInt, parseEnvMs, parseEnvFloat } = require('./agentEnv');

const QUEUE_AGENT_NAME = queueConfig.queueAgentName;
const PHONE_AGENT_NAME = queueConfig.phoneAgentName;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatch the real phone-agent to the room using the LiveKit AgentDispatch API.
 * The phone-agent's main.js entry runs untouched from this point.
 */
async function dispatchPhoneAgent(roomName, metadata) {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!url || !apiKey || !apiSecret) {
    throw new Error('[Queue Worker] LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET must be set');
  }

  const client = new AgentDispatchClient(url, apiKey, apiSecret);
  await client.createDispatch(roomName, PHONE_AGENT_NAME, {
    metadata: metadata ? JSON.stringify(metadata) : undefined,
  });

  console.log(`[Queue Worker] Dispatched ${PHONE_AGENT_NAME} → room: ${roomName}`);
}

/**
 * Build a minimal TTS-only AgentSession for playing waiting messages.
 * No STT, no LLM conversation — just speaks the text we give it.
 */
function buildWaitingSession() {
  return new voice.AgentSession({
    tts: new openai.TTS({
      voice: process.env.QUEUE_TTS_VOICE || 'nova',
      model: process.env.QUEUE_TTS_MODEL || 'tts-1',
    }),
  });
}

async function saySafe(session, text) {
  try {
    const handle = session.say(text);
    if (handle && typeof handle.waitForPlayout === 'function') {
      await handle.waitForPlayout();
    }
  } catch (err) {
    console.warn('[Queue Worker] TTS say failed:', err && err.message ? err.message : err);
  }
}

// ─── Agent definition ────────────────────────────────────────────────────────

const agentDef = defineAgent({
  entry: async (ctx) => {
    const roomName =
      ctx.job && ctx.job.room && ctx.job.room.name
        ? String(ctx.job.room.name)
        : '';

    if (!roomName) {
      console.error('[Queue Worker] No room name in job context — skipping');
      return;
    }

    const jobMetadata =
      ctx.job && ctx.job.metadata ? ctx.job.metadata : {};

    console.log(`[Queue Worker] Incoming call → room: ${roomName}`);
    await logQueueStatus('before');

    // ── Fast path: slot immediately available ──────────────────────────────
    const immediateSlot = await queueService.tryAcquireSlot(roomName);

    if (immediateSlot) {
      console.log(`[Queue Worker] Slot free — dispatching ${PHONE_AGENT_NAME} immediately`);
      let dispatchOk = false;
      try {
        await dispatchPhoneAgent(roomName, jobMetadata);
        dispatchOk = true;
      } catch (err) {
        console.error('[Queue Worker] Dispatch failed (fast path):', err.message);
      }

      if (dispatchOk) {
        // Stay in the room as a silent observer so we can release the slot
        // the moment the call ends — without depending on the webhook.
        try {
          await ctx.connect();
          await new Promise((resolve) => ctx.room.once('disconnected', resolve));
        } catch (err) {
          console.warn('[Queue Worker] Fast path room monitor error:', err && err.message ? err.message : err);
        }
      }

      // Release slot whether dispatch succeeded or call just ended
      await queueService.releaseSlot(roomName);
      return;
    }

    // ── Queue full: reject caller ──────────────────────────────────────────
    const currentQueueLen = await queueService.getQueueLength();
    if (currentQueueLen >= queueConfig.maxQueueSize) {
      console.warn(
        `[Queue Worker] Queue full (${currentQueueLen}/${queueConfig.maxQueueSize}) — rejecting room: ${roomName}`,
      );
      let rejectSession = null;
      try {
        await ctx.connect();
        const waitAgent = new voice.Agent({ instructions: 'Queue system.' });
        rejectSession = buildWaitingSession();
        await rejectSession.start({
          agent: waitAgent,
          room: ctx.room,
          inputOptions: { audioEnabled: false },
        });
        await saySafe(rejectSession, queueAudio.getQueueFullMessage('hi'));
        await sleep(3500);
      } catch (e) {
        console.warn('[Queue Worker] Reject audio error:', e && e.message ? e.message : e);
      } finally {
        if (rejectSession) {
          try { await rejectSession.close(); } catch (_) {}
        }
      }
      return;
    }

    // ── Waiting path ───────────────────────────────────────────────────────
    console.log(`[Queue Worker] No slot — placing in queue: ${roomName}`);

    let session     = null;
    let holdAudio   = null;
    let slotAcquired = false;

    try {
      await ctx.connect();

      const waitAgent = new voice.Agent({ instructions: 'Queue waiting system.' });
      session = buildWaitingSession();
      await session.start({
        agent: waitAgent,
        room: ctx.room,
        inputOptions: { audioEnabled: false },
      });

      await queueService.enqueueRoom(roomName, jobMetadata);

      // 1. Bilingual welcome — Hindi first, then English
      await saySafe(session, queueAudio.getWelcomeMessage());

      // 2. Start looping hold music so the caller always hears something
      holdAudio = await startHoldAudio(ctx.room);

      // Polling loop — slot check every pollMs, reassurance every reassuranceIntervalMs
      const pollMs               = queueConfig.pollIntervalMs;
      const maxPolls             = Math.floor(queueConfig.queueTimeoutMs / pollMs);
      const reassuranceIntervalMs = queueConfig.reassuranceIntervalMs;
      let pollCount              = 0;
      let lastReassuranceAt      = Date.now();

      while (!slotAcquired && pollCount < maxPolls) {
        await sleep(pollMs);
        pollCount++;

        slotAcquired = await queueService.tryAcquireSlot(roomName);

        // Reassurance message overlays hold music (low volume music + clear voice)
        if (!slotAcquired && Date.now() - lastReassuranceAt >= reassuranceIntervalMs) {
          lastReassuranceAt = Date.now();
          await saySafe(session, queueAudio.getReassuranceMessage());
        }
      }

      await queueService.removeFromWaiting(roomName);

      // ── Timed out ────────────────────────────────────────────────────────
      if (!slotAcquired) {
        console.warn(`[Queue Worker] Wait timeout for room: ${roomName}`);
        if (holdAudio) { await holdAudio.stop(); holdAudio = null; }
        await saySafe(session, queueAudio.getTimeoutMessage('hi'));
        await sleep(3500);
        await session.close();
        session = null;
        return;
      }

      // ── Slot acquired after wait ─────────────────────────────────────────
      console.log(`[Queue Worker] Slot acquired after wait — dispatching ${PHONE_AGENT_NAME} → room: ${roomName}`);
      // Stop hold music before playing connecting message so it's crystal clear
      if (holdAudio) { await holdAudio.stop(); holdAudio = null; }
      await saySafe(session, queueAudio.getConnectingMessage('hi'));
      await sleep(1500);

      // Dispatch first — THEN close the session and release slot on disconnect.
      // Closing the session before dispatch races the room teardown.
      let dispatchOk = false;
      try {
        await dispatchPhoneAgent(roomName, jobMetadata);
        dispatchOk = true;
      } catch (err) {
        console.error('[Queue Worker] Dispatch failed (wait path):', err.message);
      }

      if (dispatchOk) {
        // Stay connected (session audio already stopped) and release slot
        // the instant the call ends — ctx.room fires 'disconnected' when the
        // room closes after all participants leave.
        try {
          await new Promise((resolve) => ctx.room.once('disconnected', resolve));
        } catch (err) {
          console.warn('[Queue Worker] Wait path room monitor error:', err && err.message ? err.message : err);
        }
      }

      await queueService.releaseSlot(roomName);
      if (session) {
        try { await session.close(); } catch (_) {}
        session = null;
      }
    } catch (err) {
      console.error('[Queue Worker] Entry error:', err && err.message ? err.message : err);
      await queueService.removeFromWaiting(roomName);
      if (slotAcquired) await queueService.releaseSlot(roomName);
      if (holdAudio) { await holdAudio.stop().catch(() => {}); }
      if (session) {
        try { await session.close(); } catch (_) {}
      }
      throw err;
    }
  },
});

module.exports = agentDef;

// ─── Startup ─────────────────────────────────────────────────────────────────

// ─── Stale-slot sweeper ───────────────────────────────────────────────────────
// Safety net: every 30 s, cross-reference active Redis slots against LiveKit.
// Any room no longer visible in LiveKit (call already ended but slot not freed)
// is released immediately.  This covers webhook failures and agent crashes.

async function sweepStaleSlots() {
  const url       = process.env.LIVEKIT_URL;
  const apiKey    = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return;

  try {
    const rooms = await queueService.getActiveRooms();
    if (rooms.length === 0) return;

    const client = new RoomServiceClient(url, apiKey, apiSecret);
    const existing = await client.listRooms(rooms);
    const existingSet = new Set(existing.map((r) => r.name));

    for (const room of rooms) {
      if (!existingSet.has(room)) {
        console.log(`[Queue Worker] Sweeper: stale slot detected — ${room}`);
        await queueService.releaseSlot(room);
      }
    }
  } catch (err) {
    console.warn('[Queue Worker] Sweeper error:', err && err.message ? err.message : err);
  }
}

const SWEEP_INTERVAL_MS = parseInt(process.env.QUEUE_STALE_SLOT_SWEEP_MS || '30000', 10);
const sweepTimer = setInterval(() => sweepStaleSlots().catch(() => {}), SWEEP_INTERVAL_MS);
sweepTimer.unref(); // Do not prevent process exit

process.on('SIGTERM', async () => {
  clearInterval(sweepTimer);
  await closeQueueRedis();
});

console.log('[Queue Worker] Starting — agent name:', QUEUE_AGENT_NAME);
console.log(
  `[Queue Worker] Limits: max_concurrent=${queueConfig.maxConcurrentCalls}`,
  `max_queue=${queueConfig.maxQueueSize}`,
  `poll=${queueConfig.pollIntervalMs}ms`,
  `wait_msg=${queueConfig.waitMessageIntervalMs}ms`,
  `timeout=${queueConfig.queueTimeoutMs}ms`,
);
console.log(
  `[Queue Worker] Dispatches to: ${PHONE_AGENT_NAME}`,
  '| Env: QUEUE_AGENT_NAME, PHONE_AGENT_NAME, QUEUE_MAX_CONCURRENT_CALLS,',
  'QUEUE_MAX_SIZE, QUEUE_TIMEOUT_MS, QUEUE_TTS_VOICE, QUEUE_TTS_MODEL',
);

cli.runApp(
  new ServerOptions({
    agent: __filename,
    agentName: QUEUE_AGENT_NAME,
    numIdleProcesses: parseEnvInt('QUEUE_NUM_IDLE_PROCESSES', 5),
    initializeProcessTimeout: parseEnvMs('LIVEKIT_INIT_PROCESS_TIMEOUT_MS', 20000),
    loadThreshold: parseEnvFloat('LIVEKIT_LOAD_THRESHOLD', 0.75),
  }),
);
