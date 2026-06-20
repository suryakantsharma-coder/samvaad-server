let patched = false;

/**
 * Prevent unhandled WebSocket "error" events (e.g. OpenAI Realtime teardown
 * during concurrent jobs) from crashing the whole worker process.
 */
function attachWebSocketErrorGuard() {
  if (patched) return;
  patched = true;

  try {
    const wsMod = require("ws");
    const WebSocket = wsMod.WebSocket || wsMod;
    if (!WebSocket || !WebSocket.prototype) return;

    const originalAddListener = WebSocket.prototype.addListener;
    WebSocket.prototype.addListener = function guardedAddListener(
      event,
      listener,
    ) {
      if (event === "error" && this.listenerCount("error") === 0) {
        originalAddListener.call(this, "error", (err) => {
          const msg = err && err.message ? err.message : String(err);
          console.warn("[LiveKit Agent] WebSocket error (guarded):", msg);
        });
      }
      return originalAddListener.call(this, event, listener);
    };

    const originalOn = WebSocket.prototype.on;
    WebSocket.prototype.on = function guardedOn(event, listener) {
      return this.addListener(event, listener);
    };
  } catch (err) {
    console.warn(
      "[LiveKit Agent] WebSocket error guard not installed:",
      err && err.message ? err.message : err,
    );
  }
}

module.exports = { attachWebSocketErrorGuard };
