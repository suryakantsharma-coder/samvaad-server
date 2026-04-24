/**
 * If the caller is silent while the agent is listening, nudge once after a timeout
 * (Hindi / Gujarati per call language in instructions).
 */
const { AgentSessionEventTypes } = require("@livekit/agents").voice;

const NO_INPUT_INSTRUCTIONS = `URGENT_ONE_TURN — no user response was detected after your last question.

Say exactly ONE short utterance in the language this call is using (Hindi OR Gujarati only — never both):
- **Hindi:** "माफ़ कीजिए, मुझे कोई इनपुट साफ़ नहीं मिला। कृपया फिर से बोलिए।" Then repeat only your **immediate last question** in one short Hindi line.
- **Gujarati:** "માફ કરજો, મને કોઈ ઇનપુટ સાફ મળ્યો નહીં। કૃપા કરીને ફરી કહો." Then repeat only your **immediate last question** in one short Gujarati line.

Do NOT call tools. Pick only Hindi or Gujarati based on what the caller already chose for this call.`;

/**
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {{ ms?: number, logTag?: string }} [opts]
 * @returns {() => void} detach listeners and clear timer
 */
function attachNoInputReprompt(session, opts = {}) {
  const ms = opts.ms ?? 4000;
  const logTag = opts.logTag ?? "[NoInputReprompt]";
  if (!ms || ms <= 0 || !session) {
    return () => {};
  }

  let timer = null;
  let armGeneration = 0;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armIfBothListening = () => {
    clearTimer();
    if (session.closing) return;
    if (session.agentState !== "listening" || session.userState !== "listening")
      return;
    const gen = ++armGeneration;
    timer = setTimeout(() => {
      if (gen !== armGeneration) return;
      if (session.closing) return;
      if (session.agentState !== "listening" || session.userState !== "listening")
        return;
      try {
        session.generateReply({
          toolChoice: "none",
          instructions: NO_INPUT_INSTRUCTIONS,
        });
      } catch (e) {
        console.warn(logTag, e && e.message ? e.message : e);
      }
    }, ms);
  };

  const onAgentStateChanged = (ev) => {
    if (ev && ev.newState === "listening" && session.userState === "listening") {
      armIfBothListening();
    } else {
      clearTimer();
    }
  };

  const onUserStateChanged = (ev) => {
    if (ev && ev.newState === "speaking") clearTimer();
    if (
      ev &&
      ev.newState === "listening" &&
      session.agentState === "listening"
    ) {
      armIfBothListening();
    }
  };

  const onUserInputTranscribed = (ev) => {
    if (ev && ev.isFinal) clearTimer();
  };

  const onClose = () => {
    clearTimer();
  };

  session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
  session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
  session.on(AgentSessionEventTypes.UserInputTranscribed, onUserInputTranscribed);
  session.once(AgentSessionEventTypes.Close, onClose);

  return () => {
    clearTimer();
    session.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
    session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
    session.off(
      AgentSessionEventTypes.UserInputTranscribed,
      onUserInputTranscribed,
    );
    session.off(AgentSessionEventTypes.Close, onClose);
  };
}

module.exports = { attachNoInputReprompt, NO_INPUT_INSTRUCTIONS };
