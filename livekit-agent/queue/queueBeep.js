/**
 * Plays a short hold-tone beep into the LiveKit room so the caller knows
 * they are on hold. Uses a raw sine-wave PCM track published independently
 * from the TTS session — LiveKit mixes both to the SIP participant.
 *
 * ENV:
 *   QUEUE_BEEP_FREQ_HZ      tone frequency in Hz   (default 480 — US hold tone)
 *   QUEUE_BEEP_DURATION_MS  beep duration ms        (default 600)
 *   QUEUE_BEEP_GAIN         amplitude 0.0–1.0       (default 0.45)
 */

const {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} = require('@livekit/rtc-node');

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const FRAME_MS = 20; // 20 ms frames — standard for WebRTC audio

function envNum(key, def) {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) ? v : def;
}

function generateSineWave(freq, durationMs, gain) {
  const totalSamples = Math.floor(SAMPLE_RATE * durationMs / 1_000);
  const amplitude = Math.round(Math.min(1, Math.max(0, gain)) * 32_767);
  const data = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    data[i] = Math.round(amplitude * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE));
  }
  return data;
}

/**
 * Publish a sine-wave beep to the room and wait for it to finish playing.
 * Safe to call concurrently with an active TTS session — both tracks are
 * mixed by the LiveKit server before reaching the SIP participant.
 *
 * @param {import('@livekit/rtc-node').Room} room
 */
async function playBeep(room) {
  const freq = envNum('QUEUE_BEEP_FREQ_HZ', 480);
  const durationMs = envNum('QUEUE_BEEP_DURATION_MS', 600);
  const gain = envNum('QUEUE_BEEP_GAIN', 0.45);

  const pcm = generateSineWave(freq, durationMs, gain);
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('queue-beep', source);

  const opts = new TrackPublishOptions();
  opts.source = TrackSource.SOURCE_MICROPHONE;

  let sid;
  try {
    const pub = await room.localParticipant.publishTrack(track, opts);
    sid = pub && pub.sid ? pub.sid : null;
  } catch (err) {
    console.warn('[Queue Beep] publishTrack failed:', err && err.message ? err.message : err);
    return;
  }

  // Stream PCM in 20 ms frames
  const frameSamples = Math.floor(SAMPLE_RATE * FRAME_MS / 1_000);
  const totalSamples = pcm.length;

  for (let offset = 0; offset < totalSamples; offset += frameSamples) {
    const chunk = pcm.subarray(offset, Math.min(offset + frameSamples, totalSamples));
    try {
      await source.captureFrame(new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, chunk.length));
    } catch (_) {
      break;
    }
  }

  // Small tail to let the last frame finish before unpublishing
  await new Promise((r) => setTimeout(r, 250));

  try {
    if (sid) await room.localParticipant.unpublishTrack(sid);
  } catch (_) {}
}

module.exports = { playBeep };
