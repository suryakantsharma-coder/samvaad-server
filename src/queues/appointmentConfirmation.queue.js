const { Queue } = require('bullmq');
// Reuse the single Redis connection factory + reachability check used by the
// medicine-reminder queue so all BullMQ queues share one Redis configuration.
const {
  createRedisConnection,
  checkRedisReachable,
} = require('./reminder.queue');

const QUEUE_NAME = 'appointment-confirmations';

let queueSingleton = null;
let publisherConnection = null;

function getAppointmentConfirmationQueue() {
  if (!queueSingleton) {
    publisherConnection = createRedisConnection();
    queueSingleton = new Queue(QUEUE_NAME, {
      connection: publisherConnection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
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

async function closeAppointmentConfirmationQueue() {
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
  getAppointmentConfirmationQueue,
  closeAppointmentConfirmationQueue,
  checkRedisReachable,
};
