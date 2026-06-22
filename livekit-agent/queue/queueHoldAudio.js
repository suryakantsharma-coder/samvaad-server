/**
 * Queue Hold Audio
 * ----------------
 * Streams looping background hold music into the LiveKit room while a caller
 * waits in the queue. Uses a separate LocalAudioTrack alongside the TTS
 * session — LiveKit mixes both tracks before delivering to the SIP caller.
 *
 * ENV VARS:
 *   QUEUE_HOLD_AUDIO_ENABLED   set to "false" to disable entirely (default: true)
 *   QUEUE_HOLD_AUDIO_FILE      absolute or cwd-relative path to WAV/OGG/MP3 file
 *                              (default: built-in office-ambience.ogg from @livekit/agents)
 *   QUEUE_HOLD_AUDIO_VOLUME    0.0–1.0 amplitude multiplier (default: 0.25)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { AudioFrame, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } = require('@livekit/rtc-node');
const { loopAudioFramesFromFile } = require('@livekit/agents');

const SAMPLE_RATE = 48_000;
const CHANNELS    = 1;
const BUFFER_MS   = 400; // AudioSource internal buffer — smooths frame delivery

function resolveAudioFile() {
  const custom = (process.env.QUEUE_HOLD_AUDIO_FILE || '').trim();
  if (custom) {
    const abs = path.isAbsolute(custom) ? custom : path.resolve(process.cwd(), custom);
    if (fs.existsSync(abs)) return abs;
    console.warn(`[Queue Hold Audio] QUEUE_HOLD_AUDIO_FILE not found at "${abs}" — using built-in`);
  }
  // Built-in soft office ambience shipped with @livekit/agents
  return path.join(require.resolve('@livekit/agents'), '..', '..', 'resources', 'office-ambience.ogg');
}

function resolveVolume() {
  const v = parseFloat(process.env.QUEUE_HOLD_AUDIO_VOLUME);
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 0.25;
}

/**
 * Multiply PCM Int16 samples by a gain factor in-place (new buffer).
 * frame.data is Int16Array.
 */
function applyVolume(frame, volume) {
  if (volume >= 1) return frame;
  const src = frame.data;           // Int16Array
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = Math.max(-32_768, Math.min(32_767, Math.round(src[i] * volume)));
  }
  return new AudioFrame(out, frame.sampleRate, frame.channels, frame.samplesPerChannel);
}

/**
 * Start looping hold audio in the room.
 *
 * Returns a handle with a single `stop()` method.  Always call stop() when
 * the caller leaves (slot acquired, timeout, or error) — it cleans up the
 * published track and the audio source.
 *
 * @param {import('@livekit/rtc-node').Room} room
 * @returns {Promise<{ stop: () => Promise<void> } | null>}
 */
async function startHoldAudio(room) {
  if (process.env.QUEUE_HOLD_AUDIO_ENABLED === 'false') {
    console.log('[Queue Hold Audio] Disabled (QUEUE_HOLD_AUDIO_ENABLED=false)');
    return null;
  }

  const audioFile = resolveAudioFile();
  const volume    = resolveVolume();

  const source = new AudioSource(SAMPLE_RATE, CHANNELS, BUFFER_MS);
  const track  = LocalAudioTrack.createAudioTrack('queue-hold', source);

  const opts   = new TrackPublishOptions();
  opts.source  = TrackSource.SOURCE_MICROPHONE;

  let publication;
  try {
    publication = await room.localParticipant.publishTrack(track, opts);
  } catch (err) {
    console.warn('[Queue Hold Audio] Failed to publish track:', err && err.message ? err.message : err);
    await source.close().catch(() => {});
    return null;
  }

  console.log(
    `[Queue Hold Audio] Started — file: ${path.basename(audioFile)}, volume: ${volume}`,
  );

  const abortController = new AbortController();
  let stopped = false;

  // Stream audio frames continuously in the background
  const streamPromise = (async () => {
    try {
      for await (const frame of loopAudioFramesFromFile(audioFile, { abortSignal: abortController.signal })) {
        if (stopped) break;
        await source.captureFrame(applyVolume(frame, volume));
      }
    } catch (err) {
      if (!stopped) {
        console.warn('[Queue Hold Audio] Stream error:', err && err.message ? err.message : err);
      }
    }
  })();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      abortController.abort();          // stop generator from producing new frames
      await source.close().catch(() => {}); // unblock any pending captureFrame
      await streamPromise.catch(() => {});  // wait for loop to exit
      try {
        if (publication && publication.sid) {
          await room.localParticipant.unpublishTrack(publication.sid);
        }
      } catch (_) {}
      console.log('[Queue Hold Audio] Stopped');
    },
  };
}

module.exports = { startHoldAudio };
