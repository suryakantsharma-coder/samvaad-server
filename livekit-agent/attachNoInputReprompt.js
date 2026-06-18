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
 *   getPreferredLanguage?: () => ('hi'|'gu'|'en'|null|undefined),
 *   getNoInputTopic?: () => (string|null|undefined),
 *   onReprompt?: (info: { lang: 'hi'|'gu'|'en', missingTopic: string|null }) => void,
 *   shouldSuppressReprompt?: () => boolean,
 * }} [opts]
 * @returns {() => void} detach listeners and clear timer
 */
function attachNoInputReprompt(session, opts = {}) {
  const ms = opts.ms ?? 4000;
  const logTag = opts.logTag ?? "[NoInputReprompt]";
  const getPreferredLanguage = opts.getPreferredLanguage;
  const getNoInputTopic = opts.getNoInputTopic;
  const onReprompt = opts.onReprompt;
  const shouldSuppressReprompt = opts.shouldSuppressReprompt;
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

  const isRepromptSuppressed = () => {
    if (typeof shouldSuppressReprompt !== "function") return false;
    try {
      return Boolean(shouldSuppressReprompt());
    } catch (e) {
      console.warn(
        logTag,
        "shouldSuppressReprompt:",
        e && e.message ? e.message : e,
      );
      return false;
    }
  };

  const armIfBothListening = () => {
    clearTimer();
    if (session.closing) return;
    if (isRepromptSuppressed()) return;
    if (session.agentState !== "listening" || session.userState !== "listening")
      return;
    const gen = ++armGeneration;
    timer = setTimeout(() => {
      if (gen !== armGeneration) return;
      if (session.closing) return;
      if (isRepromptSuppressed()) return;
      if (session.agentState !== "listening" || session.userState !== "listening")
        return;
      try {
        const lang =
          typeof getPreferredLanguage === "function"
            ? getPreferredLanguage()
            : null;
        const missingTopic =
          typeof getNoInputTopic === "function" ? getNoInputTopic() : null;
        if (typeof onReprompt === "function") {
          try {
            onReprompt({
              lang:
                lang === "gu" ? "gu" : lang === "en" ? "en" : "hi",
              missingTopic: missingTopic || null,
            });
          } catch (cbErr) {
            console.warn(
              logTag,
              "onReprompt callback:",
              cbErr && cbErr.message ? cbErr.message : cbErr,
            );
          }
        }
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
    if (!ev) return;
    /**
     * Any state other than `listening` means the agent has work in flight —
     * `thinking` or `speaking`. Clear the timer so the reprompt does NOT race
     * an already-pending response (which would otherwise inject a sorry-line
     * mid-turn, e.g. "माफ़ कीजिए," appearing inside a Gujarati answer).
     */
    if (ev.newState === "listening" && session.userState === "listening") {
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
    /** Cancel the timer on any STT activity, not only final transcripts —
     * we don't want to reprompt a caller who has started talking. */
    if (ev) clearTimer();
  };

  /**
   * A `SpeechCreated` event fires the moment a reply is queued, *before*
   * `agentState` flips to `thinking`/`speaking`. Without this clearTimer the
   * reprompt fires concurrently with the pending response.
   */
  const onSpeechCreated = () => {
    clearTimer();
  };

  const onClose = () => {
    clearTimer();
  };

  session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
  session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
  session.on(AgentSessionEventTypes.UserInputTranscribed, onUserInputTranscribed);
  session.on(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
  session.once(AgentSessionEventTypes.Close, onClose);

  return () => {
    clearTimer();
    session.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
    session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
    session.off(
      AgentSessionEventTypes.UserInputTranscribed,
      onUserInputTranscribed,
    );
    session.off(AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    session.off(AgentSessionEventTypes.Close, onClose);
  };
}

module.exports = { attachNoInputReprompt, getNoInputRepromptInstructions };
