/**
 * Queue Flow Test
 * ---------------
 * Simulates multiple callers hitting the hospital agent queue.
 * Only 1 call gets the active slot; the rest wait in the queue.
 *
 * Usage:
 *   node scripts/testQueueFlow.js
 *   QUEUE_MAX_CONCURRENT_CALLS=1 node scripts/testQueueFlow.js
 *
 * QUEUE_MAX_CONCURRENT_CALLS (default 0 — all callers go to queue)
 *   0  → every caller queues immediately (pure queue test)
 *   1  → first caller goes active, rest queue
 *   N  → first N callers go active, rest queue
 *
 * REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Default to 0 so all callers queue — override via env
if (!process.env.QUEUE_MAX_CONCURRENT_CALLS) {
  process.env.QUEUE_MAX_CONCURRENT_CALLS = '0';
}

const Redis = require('ioredis');
const cfg = require('../livekit-agent/queue/queueConfig');

// ── Redis ──────────────────────────────────────────────────────────────────

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
  : new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null,
    });

redis.on('error', (err) => {
  console.error('[Redis]', err.message);
  process.exit(1);
});

// ── Atomic slot-acquire (mirrors queueService.js) ─────────────────────────

const ACQUIRE_SCRIPT = `
local count = redis.call('SCARD', KEYS[1])
if count < tonumber(ARGV[1]) then
  redis.call('SADD', KEYS[1], ARGV[2])
  redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  return 1
end
return 0
`;

async function tryAcquireSlot(roomName) {
  const res = await redis.eval(
    ACQUIRE_SCRIPT,
    2,
    cfg.redis.activeSlotsSet,
    cfg.redis.slotKey(roomName),
    String(cfg.maxConcurrentCalls),
    roomName,
    String(cfg.callMaxTtlSeconds),
  );
  return res === 1;
}

async function releaseSlot(roomName) {
  const p = redis.pipeline();
  p.srem(cfg.redis.activeSlotsSet, roomName);
  p.del(cfg.redis.slotKey(roomName));
  p.lrem(cfg.redis.waitingList, 0, roomName);
  p.del(cfg.redis.waitingMeta(roomName));
  await p.exec();
}

async function enqueueRoom(roomName) {
  const p = redis.pipeline();
  p.rpush(cfg.redis.waitingList, roomName);
  p.setex(cfg.redis.waitingMeta(roomName), 3600, JSON.stringify({ enqueuedAt: Date.now() }));
  await p.exec();
}

async function getStats() {
  const [active, waiting, activeRooms, waitingRooms] = await Promise.all([
    redis.scard(cfg.redis.activeSlotsSet),
    redis.llen(cfg.redis.waitingList),
    redis.smembers(cfg.redis.activeSlotsSet),
    redis.lrange(cfg.redis.waitingList, 0, -1),
  ]);
  return { active, waiting, activeRooms, waitingRooms };
}

// ── Cleanup stale keys from previous runs ─────────────────────────────────

async function cleanupTestKeys(rooms) {
  const p = redis.pipeline();
  for (const r of rooms) {
    p.srem(cfg.redis.activeSlotsSet, r);
    p.del(cfg.redis.slotKey(r));
    p.lrem(cfg.redis.waitingList, 0, r);
    p.del(cfg.redis.waitingMeta(r));
  }
  await p.exec();
}

// ── Pretty print ──────────────────────────────────────────────────────────

function printStatus(label, stats) {
  const bar = (n, max, ch = '█') => ch.repeat(n) + '░'.repeat(Math.max(0, max - n));
  console.log(`\n━━━ ${label} ━━━`);
  console.log(`  Active calls  [${bar(stats.active, cfg.maxConcurrentCalls)}]  ${stats.active}/${cfg.maxConcurrentCalls}`);
  console.log(`  Queue waiting [${bar(stats.waiting, cfg.maxQueueSize)}]  ${stats.waiting}/${cfg.maxQueueSize}`);
  if (stats.activeRooms.length)  console.log(`  Active :`, stats.activeRooms.join(', '));
  if (stats.waitingRooms.length) console.log(`  Waiting:`, stats.waitingRooms.map((r, i) => `#${i + 1} ${r}`).join(' | '));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Simulated callers ─────────────────────────────────────────────────────

const CALLERS = [
  'hospital-room-caller-1',
  'hospital-room-caller-2',
  'hospital-room-caller-3',
  'hospital-room-caller-4',
];

async function simulateCaller(roomName) {
  const gotSlot = await tryAcquireSlot(roomName);

  if (gotSlot) {
    console.log(`  ✅  ${roomName} → ACTIVE CALL (slot acquired, phone-agent dispatched)`);
    return { roomName, status: 'active' };
  }

  // No slot — join waiting queue
  await enqueueRoom(roomName);
  const pos = (await redis.lrange(cfg.redis.waitingList, 0, -1)).indexOf(roomName) + 1;
  console.log(`  ⏳  ${roomName} → QUEUED at position #${pos} (hearing: "आप queue में ${pos} number पर हैं")`);
  return { roomName, status: 'queued', position: pos };
}

// ── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Hospital Agent — Queue Flow Test        ║');
  console.log(`║  Max concurrent calls : ${cfg.maxConcurrentCalls}  ${cfg.maxConcurrentCalls === 0 ? '(all go to queue)' : '(first slot goes active)'}`.padEnd(43) + '║');
  console.log(`║  Simulating ${CALLERS.length} callers                   ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Tip: QUEUE_MAX_CONCURRENT_CALLS=${cfg.maxConcurrentCalls}  — set to 1 (or higher) to let callers go active`);

  await cleanupTestKeys(CALLERS);
  console.log('\n[Setup] Cleared any stale test keys from Redis\n');

  // ── Step 1: All callers arrive at the same time ────────────────────────
  console.log('── Step 1: All callers arrive simultaneously ──');
  const results = await Promise.all(CALLERS.map(simulateCaller));

  printStatus('After all callers arrive', await getStats());

  // ── Step 2: Wait a moment, then show queue status ─────────────────────
  await sleep(2000);
  console.log('\n── Step 2: Poll queue/status endpoint ──');
  const mid = await getStats();
  printStatus('Live queue stats', mid);

  // ── Step 3: Active call finishes (room_finished webhook) ───────────────
  const activeCall = results.find((r) => r.status === 'active');
  if (activeCall) {
    await sleep(3000);
    console.log(`\n── Step 3: Active call ends → room_finished webhook fires ──`);
    console.log(`  📞  ${activeCall.roomName} hung up — releasing slot`);
    await releaseSlot(activeCall.roomName);

    // First in queue should now be able to acquire the slot
    const nextRoom = (await redis.lrange(cfg.redis.waitingList, 0, 0))[0];
    if (nextRoom) {
      const acquired = await tryAcquireSlot(nextRoom);
      if (acquired) {
        await redis.lrem(cfg.redis.waitingList, 1, nextRoom);
        await redis.del(cfg.redis.waitingMeta(nextRoom));
        console.log(`  ✅  ${nextRoom} → Now ACTIVE (heard: "अभी आपको connect कर रहे हैं")`);
      }
    }

    printStatus('After first call finishes', await getStats());
  }

  // ── Step 4: Second active call finishes ────────────────────────────────
  const secondActive = results.find((r) => r.status === 'queued' && r.position === 1);
  if (secondActive) {
    await sleep(3000);
    console.log(`\n── Step 4: Second call ends ──`);
    console.log(`  📞  ${secondActive.roomName} hung up — releasing slot`);
    await releaseSlot(secondActive.roomName);

    const nextRoom = (await redis.lrange(cfg.redis.waitingList, 0, 0))[0];
    if (nextRoom) {
      const acquired = await tryAcquireSlot(nextRoom);
      if (acquired) {
        await redis.lrem(cfg.redis.waitingList, 1, nextRoom);
        await redis.del(cfg.redis.waitingMeta(nextRoom));
        console.log(`  ✅  ${nextRoom} → Now ACTIVE`);
      }
    }

    printStatus('After second call finishes', await getStats());
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  console.log('\n── Cleanup: releasing all remaining test slots ──');
  await cleanupTestKeys(CALLERS);
  printStatus('Final state (should be empty)', await getStats());

  console.log('\n✅  Test complete.\n');
  await redis.quit();
  process.exit(0);
})().catch(async (err) => {
  console.error('\n❌  Test failed:', err.message);
  await redis.quit().catch(() => {});
  process.exit(1);
});
