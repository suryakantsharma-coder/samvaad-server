/**
 * Server-side queue service
 * -------------------------
 * Runs inside the main Express process (NOT the livekit-agent process).
 * Uses the same Redis keys as livekit-agent/queue/queueService.js so both
 * sides share a single source of truth.
 *
 * Used by:
 *   - callSlotWebhook.js → releaseSlot() when LiveKit fires room_finished
 *   - queueRoutes.js    → getQueueStats() for the monitoring API
 */

const Redis = require('ioredis');
const env = require('../config/env');
const queueConfig = require('../../livekit-agent/queue/queueConfig');

const REDIS_OPTS = { maxRetriesPerRequest: null, connectTimeout: 10_000 };

let _client = null;

function getRedis() {
  if (_client) return _client;

  if (env.REDIS_URL) {
    _client = new Redis(env.REDIS_URL, REDIS_OPTS);
  } else {
    _client = new Redis({
      host: env.REDIS_HOST || '127.0.0.1',
      port: env.REDIS_PORT || 6379,
      password: env.REDIS_PASSWORD || undefined,
      ...REDIS_OPTS,
    });
  }

  _client.on('error', (err) => {
    console.error('[Server Queue Redis]', err.message);
  });

  return _client;
}

/**
 * Release the active-call slot for a room.
 * Called by the LiveKit room_finished webhook so slots are freed immediately
 * without waiting for the Redis TTL to expire.
 * @param {string} roomName
 */
async function releaseSlot(roomName) {
  const r = getRedis();
  const pipeline = r.pipeline();
  pipeline.srem(queueConfig.redis.activeSlotsSet, roomName);
  pipeline.del(queueConfig.redis.slotKey(roomName));
  pipeline.lrem(queueConfig.redis.waitingList, 0, roomName);
  pipeline.del(queueConfig.redis.waitingMeta(roomName));
  await pipeline.exec();
  console.log(`[Server Queue] Slot released for room: ${roomName}`);
}

/**
 * Queue stats snapshot for the monitoring API.
 */
async function getQueueStats() {
  const r = getRedis();
  const [activeCount, queueLength, activeRooms, waitingRooms] = await Promise.all([
    r.scard(queueConfig.redis.activeSlotsSet),
    r.llen(queueConfig.redis.waitingList),
    r.smembers(queueConfig.redis.activeSlotsSet),
    r.lrange(queueConfig.redis.waitingList, 0, -1),
  ]);
  return {
    maxConcurrentCalls: queueConfig.maxConcurrentCalls,
    maxQueueSize: queueConfig.maxQueueSize,
    activeCallCount: activeCount,
    queueLength,
    availableSlots: Math.max(0, queueConfig.maxConcurrentCalls - activeCount),
    activeRooms,
    waitingRooms,
    timestamp: new Date().toISOString(),
  };
}

async function closeServerQueueRedis() {
  if (_client) {
    await _client.quit().catch(() => {});
    _client = null;
  }
}

module.exports = { releaseSlot, getQueueStats, closeServerQueueRedis };
