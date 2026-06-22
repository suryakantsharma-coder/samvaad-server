/**
 * Redis client singleton for the livekit-agent child process.
 * Reads connection info from the same env vars as src/queues/reminder.queue.js.
 */

const Redis = require('ioredis');

const REDIS_OPTS = { maxRetriesPerRequest: null, connectTimeout: 10_000 };

let _client = null;

function getQueueRedisClient() {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (url) {
    _client = new Redis(url, REDIS_OPTS);
  } else {
    _client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      ...REDIS_OPTS,
    });
  }

  _client.on('error', (err) => {
    console.error('[Queue Redis]', err.message);
  });

  return _client;
}

async function closeQueueRedis() {
  if (_client) {
    await _client.quit().catch(() => {});
    _client = null;
  }
}

module.exports = { getQueueRedisClient, closeQueueRedis };
