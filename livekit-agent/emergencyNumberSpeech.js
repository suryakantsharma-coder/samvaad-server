const DIGIT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

/**
 * @param {string | null | undefined} raw
 * @returns {string[]}
 */
function parseEmergencyDigits(raw) {
  return String(raw || "")
    .replace(/\D/g, "")
    .split("")
    .filter(Boolean);
}

/**
 * @param {string} digit
 */
function digitToEnglishWord(digit) {
  const n = Number.parseInt(String(digit), 10);
  if (Number.isFinite(n) && n >= 0 && n <= 9) return DIGIT_WORDS[n];
  return String(digit);
}

/** Gap between emergency digits (ms). Env: EMERGENCY_DIGIT_GAP_MS (default 1000). */
function getEmergencyDigitGapMs() {
  const v = process.env.EMERGENCY_DIGIT_GAP_MS;
  if (v == null || v === "") return 1000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import('@livekit/agents').voice.SpeechHandle | null | undefined} handle
 */
async function waitForSpeechPlayout(handle) {
  if (handle && typeof handle.waitForPlayout === "function") {
    await handle.waitForPlayout();
  }
}

/**
 * Speak one English digit/word through TTS or Realtime fallback.
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {string} word
 */
async function speakOneEnglishDigit(session, word) {
  if (!session) return;
  try {
    const handle = session.say(word, {
      addToChatCtx: false,
      allowInterruptions: false,
    });
    await waitForSpeechPlayout(handle);
    return;
  } catch (_) {
    /* OpenAI Realtime pipeline has no external TTS — fall back to a one-word reply. */
  }
  const handle = session.generateReply({
    toolChoice: "none",
    allowInterruptions: false,
    instructions:
      `URGENT_ONE_TURN — Speak ONLY the single English word "${word}". One English word, then stop. No Hindi, no Gujarati.`,
  });
  await waitForSpeechPlayout(handle);
}

/**
 * Emergency number only: one English digit at a time with a pause between digits.
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {string | null | undefined} emergencyNumber
 * @param {() => boolean} [shouldContinue] when false, stop digit playback early
 */
async function speakEmergencyNumberDigitByDigit(
  session,
  emergencyNumber,
  shouldContinue,
) {
  const digits = parseEmergencyDigits(emergencyNumber);
  if (!digits.length || !session) return;
  const gapMs = getEmergencyDigitGapMs();
  for (let i = 0; i < digits.length; i++) {
    if (typeof shouldContinue === "function" && !shouldContinue()) return;
    await speakOneEnglishDigit(session, digitToEnglishWord(digits[i]));
    if (i < digits.length - 1 && gapMs > 0) {
      await delay(gapMs);
      if (typeof shouldContinue === "function" && !shouldContinue()) return;
    }
  }
}

module.exports = {
  parseEmergencyDigits,
  digitToEnglishWord,
  getEmergencyDigitGapMs,
  speakEmergencyNumberDigitByDigit,
};
