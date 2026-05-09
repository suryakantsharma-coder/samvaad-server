const { Queue } = require('bullmq');
const { createRedisConnection } = require('./reminder.queue');

const POST_CALL_QUEUE_NAME = 'post-call-processing';

let queueSingleton = null;
let publisherConnection = null;

function getPostCallQueue() {
  if (!queueSingleton) {
    publisherConnection = createRedisConnection();
    queueSingleton = new Queue(POST_CALL_QUEUE_NAME, {
      connection: publisherConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 7 * 24 * 3600,
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

/**
 * Enqueue a post-call transcript processing job.
 *
 * @param {{
 *   originalLanguageTranscript: Array<{role: string, text: string}>,
 *   hospitalId: string,
 *   hospitalName: string,
 *   callerPhone: string | null,
 *   roomName: string,
 * }} data
 * @returns {Promise<string>} job id
 */
async function enqueuePostCallJob(data) {
  const queue = getPostCallQueue();
  // Use roomName + timestamp for a unique, traceable job id.
  const jobId = `postcall-${data.roomName || 'unknown'}-${Date.now()}`;
  const job = await queue.add('process-appointment', data, { jobId });
  return job.id;
}

async function closePostCallQueue() {
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
  POST_CALL_QUEUE_NAME,
  getPostCallQueue,
  enqueuePostCallJob,
  closePostCallQueue,
};
