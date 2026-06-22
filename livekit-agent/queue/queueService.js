/**
 * Core queue service — all slot operations use atomic Lua scripts so
 * concurrent queue workers racing for the same slot are safe.
 */

const cfg = require('./queueConfig');
const { getQueueRedisClient } = require('./queueRedis');

/**
 * Atomically acquire a slot for roomName if active count < maxConcurrentCalls.
 *
 * KEYS[1] = activeSlotsSet
 * KEYS[2] = slotKey(roomName)
 * ARGV[1] = maxConcurrentCalls
 * ARGV[2] = roomName
 * ARGV[3] = callMaxTtlSeconds
 *
 * Returns 1 on success, 0 if no slot available.
 */
const ACQUIRE_SLOT_SCRIPT = `
local count = redis.call('SCARD', KEYS[1])
if count < tonumber(ARGV[1]) then
  redis.call('SADD', KEYS[1], ARGV[2])
  redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  return 1
end
return 0
`;

/**
 * Try to acquire an active-call slot for the given room.
 * @param {string} roomName
 * @returns {Promise<boolean>} true if slot was acquired
 */
async function tryAcquireSlot(roomName) {
  const r = getQueueRedisClient();
  const result = await r.eval(
    ACQUIRE_SLOT_SCRIPT,
    2,
    cfg.redis.activeSlotsSet,
    cfg.redis.slotKey(roomName),
    String(cfg.maxConcurrentCalls),
    roomName,
    String(cfg.callMaxTtlSeconds),
  );
  return result === 1;
}

/**
 * Release an active-call slot (called by webhook when room_finished fires,
 * or on error cleanup).
 * @param {string} roomName
 */
async function releaseSlot(roomName) {
  const r = getQueueRedisClient();
  const pipeline = r.pipeline();
  pipeline.srem(cfg.redis.activeSlotsSet, roomName);
  pipeline.del(cfg.redis.slotKey(roomName));
  pipeline.lrem(cfg.redis.waitingList, 0, roomName);
  pipeline.del(cfg.redis.waitingMeta(roomName));
  await pipeline.exec();
  console.log(`[Queue Service] Slot released for room: ${roomName}`);
}

/**
 * Add a room to the end of the FIFO waiting list.
 * @param {string} roomName
 * @param {object} meta
 */
async function enqueueRoom(roomName, meta = {}) {
  const r = getQueueRedisClient();
  const pipeline = r.pipeline();
  pipeline.rpush(cfg.redis.waitingList, roomName);
  pipeline.setex(
    cfg.redis.waitingMeta(roomName),
    3600,
    JSON.stringify({ ...meta, enqueuedAt: Date.now() }),
  );
  await pipeline.exec();
}

/**
 * Remove a room from the waiting list (called once it acquires a slot or times out).
 * @param {string} roomName
 */
async function removeFromWaiting(roomName) {
  const r = getQueueRedisClient();
  const pipeline = r.pipeline();
  pipeline.lrem(cfg.redis.waitingList, 0, roomName);
  pipeline.del(cfg.redis.waitingMeta(roomName));
  await pipeline.exec();
}

/**
 * 1-based position of roomName in the waiting list, or null if not found.
 * @param {string} roomName
 * @returns {Promise<number|null>}
 */
async function getQueuePosition(roomName) {
  const r = getQueueRedisClient();
  const list = await r.lrange(cfg.redis.waitingList, 0, -1);
  const idx = list.indexOf(roomName);
  return idx === -1 ? null : idx + 1;
}

/** @returns {Promise<number>} */
async function getActiveCallCount() {
  return getQueueRedisClient().scard(cfg.redis.activeSlotsSet);
}

/** @returns {Promise<number>} */
async function getQueueLength() {
  return getQueueRedisClient().llen(cfg.redis.waitingList);
}

/**
 * Full stats snapshot for monitoring/API.
 */
async function getQueueStats() {
  const r = getQueueRedisClient();
  const [activeCount, queueLength, activeRooms, waitingRooms] = await Promise.all([
    r.scard(cfg.redis.activeSlotsSet),
    r.llen(cfg.redis.waitingList),
    r.smembers(cfg.redis.activeSlotsSet),
    r.lrange(cfg.redis.waitingList, 0, -1),
  ]);
  return {
    maxConcurrentCalls: cfg.maxConcurrentCalls,
    maxQueueSize: cfg.maxQueueSize,
    activeCallCount: activeCount,
    queueLength,
    availableSlots: Math.max(0, cfg.maxConcurrentCalls - activeCount),
    activeRooms,
    waitingRooms,
    timestamp: new Date().toISOString(),
  };
}

/** @returns {Promise<string[]>} all room names currently holding an active slot */
async function getActiveRooms() {
  return getQueueRedisClient().smembers(cfg.redis.activeSlotsSet);
}

module.exports = {
  tryAcquireSlot,
  releaseSlot,
  enqueueRoom,
  removeFromWaiting,
  getQueuePosition,
  getActiveCallCount,
  getQueueLength,
  getActiveRooms,
  getQueueStats,
};
