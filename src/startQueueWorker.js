/**
 * Queue Worker Process Manager
 * ----------------------------
 * Spawns livekit-agent/phoneQueueWorker.js as a child process.
 * Mirrors the pattern in src/startLiveKitWorker.js — the existing file is
 * NOT modified; this is a standalone manager for the queue agent only.
 *
 * Enable by setting LIVEKIT_QUEUE_ENABLED=1 in .env.
 * The queue worker also needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
 */

const { spawn } = require('child_process');
const path = require('path');

let child = null;
let intentionalShutdown = false;
let restartTimer = null;
let restartAttempts = 0;

const MAX_RESTART_ATTEMPTS = 10;
const BASE_RESTART_MS = 1000;
const MAX_RESTART_MS = 30000;

function isConfigured() {
  return !!(
    process.env.LIVEKIT_URL &&
    process.env.LIVEKIT_API_KEY &&
    process.env.LIVEKIT_API_SECRET
  );
}

function isEnabled() {
  return (
    process.env.LIVEKIT_QUEUE_ENABLED === '1' ||
    process.env.LIVEKIT_QUEUE_ENABLED === 'true'
  );
}

function clearRestartTimer() {
  if (restartTimer != null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart(code, signal) {
  if (intentionalShutdown) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(
      `[Samvaad] Queue worker restart limit (${MAX_RESTART_ATTEMPTS}) reached — not restarting`,
    );
    return;
  }

  const delay = Math.min(MAX_RESTART_MS, BASE_RESTART_MS * 2 ** restartAttempts);
  restartAttempts++;
  console.warn(
    `[Samvaad] Queue worker restarting in ${delay}ms (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})` +
      (signal ? ` after signal ${signal}` : code != null ? ` after exit ${code}` : ''),
  );

  clearRestartTimer();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!intentionalShutdown) spawnQueueWorker();
  }, delay);
}

function spawnQueueWorker() {
  const mode = process.env.NODE_ENV === 'production' ? 'start' : 'dev';
  const workerJs = path.join(__dirname, '..', 'livekit-agent', 'phoneQueueWorker.js');

  child = spawn(process.execPath, [workerJs, mode], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error('[Samvaad] Queue worker spawn error:', err.message);
    child = null;
    scheduleRestart(null, null);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (intentionalShutdown) {
      if (signal) console.log(`[Samvaad] Queue worker stopped (${signal})`);
      return;
    }
    if (signal) {
      console.warn(`[Samvaad] Queue worker exited unexpectedly (${signal})`);
      scheduleRestart(code, signal);
      return;
    }
    if (code !== 0 && code !== null) {
      console.error(`[Samvaad] Queue worker exited with code ${code}`);
      scheduleRestart(code, null);
      return;
    }
    restartAttempts = 0;
    console.log(`[Samvaad] Queue worker exited cleanly (${mode})`);
  });

  console.log(`[Samvaad] Queue worker started (${mode})`);
}

function startQueueWorker() {
  if (!isEnabled()) {
    console.log('[Samvaad] Queue worker skipped (LIVEKIT_QUEUE_ENABLED not set to 1)');
    return;
  }

  if (!isConfigured()) {
    console.warn(
      '[Samvaad] Queue worker skipped: set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in .env',
    );
    return;
  }

  intentionalShutdown = false;
  clearRestartTimer();
  restartAttempts = 0;
  spawnQueueWorker();
}

function stopQueueWorker() {
  intentionalShutdown = true;
  clearRestartTimer();
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  child = null;
}

module.exports = { startQueueWorker, stopQueueWorker };
