const { Queue } = require('bullmq');
const Redis = require('ioredis');
const env = require('../config/env');

const QUEUE_NAME = 'doctor-holidays';

const REDIS_OPTS = {
  maxRetriesPerRequest: null,
  connectTimeout: 10_000,
};

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

function getDoctorHolidayQueue() {
  if (!queueSingleton) {
    publisherConnection = createRedisConnection();
    queueSingleton = new Queue(QUEUE_NAME, {
      connection: publisherConnection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: {
          age: 30 * 24 * 3600,
          count: 2000,
        },
        removeOnFail: {
          age: 30 * 24 * 3600,
        },
      },
    });
  }
  return queueSingleton;
}

async function closeDoctorHolidayQueue() {
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
  getDoctorHolidayQueue,
  createRedisConnection,
  checkRedisReachable,
  closeDoctorHolidayQueue,
};
