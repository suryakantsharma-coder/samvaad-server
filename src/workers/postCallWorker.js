/**
 * Post-call processing worker.
 *
 * Consumes jobs from the `post-call-processing` BullMQ queue.
 * Each job carries the call transcript (already extracted from the LiveKit session)
 * plus hospital / caller metadata.  The worker:
 *   1. Translates the transcript to English (if needed).
 *   2. Persists the transcript to the caller-numbers/ filesystem store.
 *   3. Calls GPT to extract structured appointment intent.
 *   4. Creates the patient (if new) and appointment in MongoDB.
 *   5. Fires WhatsApp booking notification.
 *
 * Multiple calls are handled in parallel because BullMQ workers process jobs
 * concurrently (controlled by `concurrency`).
 */
const { Worker } = require('bullmq');
const { POST_CALL_QUEUE_NAME } = require('../queues/postCallQueue');
const { createRedisConnection } = require('../queues/reminder.queue');
const {
  runPostCallPipelineFromTranscript,
} = require('../../livekit-agent/postCallPipeline');

// How many post-call jobs to process in parallel (each is independent).
const CONCURRENCY = parseInt(process.env.POST_CALL_WORKER_CONCURRENCY || '10', 10);

let workerInstance = null;
let workerConnection = null;

async function handlePostCallJob(job) {
  const { originalLanguageTranscript, hospitalId, hospitalName, callerPhone, roomName } =
    job.data || {};

  console.log(
    `[PostCallWorker] Processing job ${job.id} — room: ${roomName}, hospital: ${hospitalName} (${hospitalId}), caller: ${callerPhone || 'unknown'}, turns: ${Array.isArray(originalLanguageTranscript) ? originalLanguageTranscript.length : 0}`,
  );

  if (!hospitalId) {
    console.warn(`[PostCallWorker] Job ${job.id} missing hospitalId — skipping.`);
    return;
  }

  const hospital = { _id: hospitalId, name: hospitalName || 'Unknown Hospital' };

  await runPostCallPipelineFromTranscript({
    originalLanguageTranscript: originalLanguageTranscript || [],
    hospital,
    callerPhone: callerPhone || null,
    roomName: roomName || '',
  });

  console.log(`[PostCallWorker] Job ${job.id} completed.`);
}

/**
 * Start the post-call worker (called from index.js alongside other workers).
 * Safe to call multiple times — only starts once.
 */
async function startPostCallWorker() {
  if (workerInstance) return;

  workerConnection = createRedisConnection();

  workerInstance = new Worker(POST_CALL_QUEUE_NAME, handlePostCallJob, {
    connection: workerConnection,
    concurrency: CONCURRENCY,
  });

  workerInstance.on('completed', (job) => {
    console.log(`[PostCallWorker] ✓ Job ${job.id} done.`);
  });

  workerInstance.on('failed', (job, err) => {
    console.error(
      `[PostCallWorker] ✗ Job ${job && job.id} failed (attempt ${job && job.attemptsMade}):`,
      err && err.message ? err.message : err,
    );
  });

  workerInstance.on('error', (err) => {
    console.error('[PostCallWorker] Worker error:', err && err.message ? err.message : err);
  });

  console.log(
    `[PostCallWorker] Started — queue: ${POST_CALL_QUEUE_NAME}, concurrency: ${CONCURRENCY}`,
  );
}

async function stopPostCallWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
  if (workerConnection) {
    await workerConnection.quit();
    workerConnection = null;
  }
}

module.exports = { startPostCallWorker, stopPostCallWorker };
