/**
 * If the caller is silent while the agent is listening, nudge once after a timeout
 * (Hindi / Gujarati per call language in instructions).
 */
const { AgentSessionEventTypes } = require("@livekit/agents").voice;
const { getNoInputRepromptInstructions } = require("./preferredLanguage");

/**
 * @param {import('@livekit/agents').voice.AgentSession} session
 * @param {{
 *   ms?: number,
 *   logTag?: string,
 *   getPreferredLanguage?: () => ('hi'|'gu'|null|undefined),
 *   getNoInputTopic?: () => (string|null|undefined),
 * }} [opts]
 * @returns {() => void} detach listeners and clear timer
 */
function attachNoInputReprompt(session, opts = {}) {
  const ms = opts.ms ?? 4000;
  const logTag = opts.logTag ?? "[NoInputReprompt]";
  const getPreferredLanguage = opts.getPreferredLanguage;
  const getNoInputTopic = opts.getNoInputTopic;
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
        const lang =
          typeof getPreferredLanguage === "function"
            ? getPreferredLanguage()
            : null;
        const missingTopic =
          typeof getNoInputTopic === "function" ? getNoInputTopic() : null;
        session.generateReply({
          toolChoice: "none",
          instructions: getNoInputRepromptInstructions(lang, {
            missingTopic: missingTopic || null,
          }),
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

module.exports = { attachNoInputReprompt, getNoInputRepromptInstructions };
