/**
 * Queue monitor — thin wrapper over queueService for logging and status checks.
 */

const { getQueueStats } = require('./queueService');

async function logQueueStatus(label = '') {
  try {
    const stats = await getQueueStats();
    console.log(
      `[Queue Monitor]${label ? ' ' + label + ':' : ''}`,
      `active=${stats.activeCallCount}/${stats.maxConcurrentCalls}`,
      `waiting=${stats.queueLength}`,
      `available=${stats.availableSlots}`,
    );
  } catch (err) {
    console.warn('[Queue Monitor] Failed to read stats:', err.message);
  }
}

async function getQueueStatus() {
  try {
    return { success: true, data: await getQueueStats() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { logQueueStatus, getQueueStatus };
