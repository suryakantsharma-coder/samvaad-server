import { DEFAULT_API_CONNECT_OPTIONS, shortuuid, stt, } from "@livekit/agents";
import { SarvamAIClient } from "sarvamai";
const SARVAM_STT_SAMPLE_RATE = 16000;
/**
 * Sarvam STT using streaming (saarika). Input 16kHz mono PCM.
 */
export class SarvamSTT extends stt.STT {
    apiKey;
    languageCode;
    client;
    constructor(opts) {
        super({ streaming: true, interimResults: false });
        this.apiKey = opts.apiKey;
        this.languageCode = opts.languageCode ?? "hi-IN";
        this.client = new SarvamAIClient({
            apiSubscriptionKey: opts.apiKey,
        });
    }
    get label() {
        return "sarvam-stt";
    }
    stream(options) {
        const connOptions = options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
        return new SarvamSpeechStream(this, connOptions);
    }
    async _recognize(_frame, _abortSignal) {
        throw new Error("Sarvam STT does not support batch recognition, use stream() instead");
    }
    async createStreamSocket() {
        return this.client.speechToTextStreaming.connect({
            "Api-Subscription-Key": this.apiKey,
            "language-code": this.languageCode,
            sample_rate: String(SARVAM_STT_SAMPLE_RATE),
        });
    }
    getLanguageCode() {
        return this.languageCode;
    }
}
class SarvamSpeechStream extends stt.SpeechStream {
    #stt;
    #requestId;
    constructor(sttImpl, connOptions) {
        super(sttImpl, SARVAM_STT_SAMPLE_RATE, connOptions);
        this.#stt = sttImpl;
        this.#requestId = shortuuid("stt_request_");
    }
    get label() {
        return "sarvam-stt-stream";
    }
    async run() {
        const socket = await this.#stt.createStreamSocket();
        socket.on("message", (msg) => {
            if (this.closed || this.queue.closed)
                return;
            if (msg.type !== "data" || !msg.data)
                return;
            const data = msg.data;
            if (!("transcript" in data) || typeof data.transcript !== "string")
                return;
            const transcript = data.transcript;
            if (!transcript.trim())
                return;
            const speechData = {
                language: this.#stt.getLanguageCode(),
                text: transcript.trim(),
                startTime: 0,
                endTime: 0,
                confidence: 1,
            };
            const event = {
                type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives: [speechData],
                requestId: this.#requestId,
            };
            this.queue.put(event);
        });
        socket.on("error", (err) => {
            if (!this.closed)
                this.#stt.emit("error", { type: "stt_error", timestamp: Date.now(), label: this.#stt.label, error: err, recoverable: true });
        });
        try {
            for await (const chunk of this.input) {
                if (this.abortController.signal.aborted)
                    break;
                if (chunk === stt.SpeechStream.FLUSH_SENTINEL) {
                    socket.flush();
                    continue;
                }
                const frame = chunk;
                const base64 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64");
                socket.transcribe({ audio: base64, sample_rate: SARVAM_STT_SAMPLE_RATE });
            }
        }
        finally {
            socket.close();
        }
    }
}
