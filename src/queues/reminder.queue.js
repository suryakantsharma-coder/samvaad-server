const { Queue } = require('bullmq');
const Redis = require('ioredis');
const env = require('../config/env');

const QUEUE_NAME = 'medicine-reminders';

const REDIS_OPTS = {
  maxRetriesPerRequest: null,
  connectTimeout: 10_000,
};

/** BullMQ requires maxRetriesPerRequest: null on ioredis. */
function createRedisConnection() {
  if (env.REDIS_URL) {
    return new Redis(env.REDIS_URL, { ...REDIS_OPTS });
  }
  return new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    ...REDIS_OPTS,
  });
}

/**
 * Quick connectivity check (dedicated client; closed after ping).
 * @returns {Promise<boolean>}
 */
async function checkRedisReachable() {
  let client;
  try {
    client = createRedisConnection();
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis ping timeout')), 4000);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (client) {
      await client.quit().catch(() => {});
    }
  }
}

let queueSingleton = null;
let publisherConnection = null;

function getReminderQueue() {
  if (!queueSingleton) {
    publisherConnection = createRedisConnection();
    queueSingleton = new Queue(QUEUE_NAME, {
      connection: publisherConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 7 * 24 * 3600,
          count: 5000,
        },
        removeOnFail: {
          age: 30 * 24 * 3600,
        },
      },
      limiter: {
        max: 100,
        duration: 1000,
      },
    });
  }
  return queueSingleton;
}

/**
 * @returns {Promise<void>}
 */
async function closeReminderQueue() {
  if (queueSingleton) {
    await queueSingleton.close();
    queueSingleton = null;
  }
  if (publisherConnection) {
    await publisherConnection.quit();
    publisherConnection = null;
  }
}

module.exports = {
  QUEUE_NAME,
  getReminderQueue,
  createRedisConnection,
  checkRedisReachable,
  closeReminderQueue,
};
