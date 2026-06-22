/**
 * Queue configuration — all values are environment-variable-driven.
 *
 * ENV VARS:
 *   QUEUE_MAX_CONCURRENT_CALLS      max simultaneous active calls handled by phone-agent (default 3)
 *   QUEUE_MAX_SIZE                  max callers allowed to wait in queue (default 10)
 *   QUEUE_CALL_MAX_TTL_SECONDS      Redis TTL on slot key; guards against orphaned slots (default 3600)
 *   QUEUE_SLOT_POLL_MS              how often a waiting entry checks for a free slot (default 2000)
 *   QUEUE_WAIT_MESSAGE_INTERVAL_MS  how often the waiting audio message replays (default 15000)
 *   QUEUE_TIMEOUT_MS                max time a caller waits before giving up (default 600000 = 10 min)
 *   QUEUE_AGENT_NAME                agentName the queue worker registers as (default "phone-queue")
 *   PHONE_AGENT_NAME                agentName the real phone-agent registers as (default "phone-agent")
 *   QUEUE_HOSPITAL_NAME                  hospital name spoken in the hold greeting (default "our hospital")
 *   QUEUE_HOLD_AUDIO_ENABLED             set "false" to disable hold music        (default true)
 *   QUEUE_HOLD_AUDIO_FILE                path to WAV/OGG/MP3 hold music file      (default: built-in office-ambience.ogg)
 *   QUEUE_HOLD_AUDIO_VOLUME              volume 0.0–1.0                           (default 0.25)
 *   QUEUE_REASSURANCE_INTERVAL_SECONDS   seconds between reassurance TTS messages (default 60)
 */

function envInt(key, def) {
  const v = process.env[key];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

const config = {
  maxConcurrentCalls: envInt('QUEUE_MAX_CONCURRENT_CALLS', 3),
  maxQueueSize: envInt('QUEUE_MAX_SIZE', 10),
  callMaxTtlSeconds: envInt('QUEUE_CALL_MAX_TTL_SECONDS', 3600),
  pollIntervalMs: envInt('QUEUE_SLOT_POLL_MS', 2000),
  waitMessageIntervalMs: envInt('QUEUE_WAIT_MESSAGE_INTERVAL_MS', 15000),
  queueTimeoutMs: envInt('QUEUE_TIMEOUT_MS', 600000),
  reassuranceIntervalMs: envInt('QUEUE_REASSURANCE_INTERVAL_SECONDS', 60) * 1000,
  queueAgentName: process.env.QUEUE_AGENT_NAME || 'phone-queue',
  phoneAgentName: process.env.PHONE_AGENT_NAME || 'phone-agent',

  redis: {
    /** Redis SET of room names currently in an active call */
    activeSlotsSet: 'samvaad:queue:active_slots',
    /** Per-room slot key with TTL — auto-expires orphaned slots */
    slotKey: (roomName) => `samvaad:queue:slot:${roomName}`,
    /** Redis LIST (FIFO) of room names waiting for a slot */
    waitingList: 'samvaad:queue:waiting_rooms',
    /** Metadata hash for each waiting room */
    waitingMeta: (roomName) => `samvaad:queue:waiting:${roomName}`,
  },
};

module.exports = config;
