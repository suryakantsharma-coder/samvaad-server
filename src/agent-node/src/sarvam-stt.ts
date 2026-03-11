import type { AudioFrame } from "@livekit/rtc-node";
import {
  type APIConnectOptions,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  stt,
} from "@livekit/agents";
import { SarvamAIClient, type SarvamAI } from "sarvamai";

const SARVAM_STT_SAMPLE_RATE = 16000;

export interface SarvamSTTOptions {
  apiKey: string;
  /** BCP-47 language code, e.g. "hi-IN", "en-IN", or "unknown" for auto-detect. Default "hi-IN". */
  languageCode?: string;
}

/**
 * Sarvam STT using streaming (saarika). Input 16kHz mono PCM.
 */
export class SarvamSTT extends stt.STT {
  private apiKey: string;
  private languageCode: string;
  private client: SarvamAIClient;

  constructor(opts: SarvamSTTOptions) {
    super({ streaming: true, interimResults: false });
    this.apiKey = opts.apiKey;
    this.languageCode = opts.languageCode ?? "hi-IN";
    this.client = new SarvamAIClient({
      apiSubscriptionKey: opts.apiKey,
    });
  }

  override get label(): string {
    return "sarvam-stt";
  }

  override stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    const connOptions = options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    return new SarvamSpeechStream(this, connOptions);
  }

  protected override async _recognize(
    _frame: import("@livekit/agents").AudioBuffer,
    _abortSignal?: AbortSignal
  ): Promise<stt.SpeechEvent> {
    throw new Error("Sarvam STT does not support batch recognition, use stream() instead");
  }

  async createStreamSocket(): Promise<Awaited<ReturnType<SarvamAIClient["speechToTextStreaming"]["connect"]>>> {
    return this.client.speechToTextStreaming.connect({
      "Api-Subscription-Key": this.apiKey,
      "language-code": this.languageCode as SarvamAI.SpeechToTextStreamingLanguageCode,
      sample_rate: String(SARVAM_STT_SAMPLE_RATE),
    });
  }

  getLanguageCode(): string {
    return this.languageCode;
  }
}

class SarvamSpeechStream extends stt.SpeechStream {
  #stt: SarvamSTT;
  #requestId: string;

  constructor(sttImpl: SarvamSTT, connOptions: APIConnectOptions) {
    super(sttImpl, SARVAM_STT_SAMPLE_RATE, connOptions);
    this.#stt = sttImpl;
    this.#requestId = shortuuid("stt_request_");
  }

  override get label(): string {
    return "sarvam-stt-stream";
  }

  protected override async run(): Promise<void> {
    const socket = await this.#stt.createStreamSocket();

    socket.on("message", (msg: SarvamAI.SpeechToTextStreamingResponse) => {
      if (this.closed || this.queue.closed) return;
      if (msg.type !== "data" || !msg.data) return;
      const data = msg.data;
      if (!("transcript" in data) || typeof (data as SarvamAI.SpeechToTextTranscriptionData).transcript !== "string") return;
      const transcript = (data as SarvamAI.SpeechToTextTranscriptionData).transcript;
      if (!transcript.trim()) return;

      const speechData: stt.SpeechData = {
        language: this.#stt.getLanguageCode(),
        text: transcript.trim(),
        startTime: 0,
        endTime: 0,
        confidence: 1,
      };
      const event: stt.SpeechEvent = {
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [speechData],
        requestId: this.#requestId,
      };
      this.queue.put(event);
    });

    socket.on("error", (err: Error) => {
      if (!this.closed) this.#stt.emit("error", { type: "stt_error", timestamp: Date.now(), label: this.#stt.label, error: err, recoverable: true });
    });

    try {
      for await (const chunk of this.input) {
        if (this.abortController.signal.aborted) break;
        if (chunk === stt.SpeechStream.FLUSH_SENTINEL) {
          socket.flush();
          continue;
        }
        const frame = chunk as AudioFrame;
        const base64 = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64");
        socket.transcribe({ audio: base64, sample_rate: SARVAM_STT_SAMPLE_RATE });
      }
    } finally {
      socket.close();
    }
  }
}
