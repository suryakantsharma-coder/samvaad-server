import type { AudioFrame } from "@livekit/rtc-node";
import {
  type APIConnectOptions,
  audioFramesFromFile,
  DEFAULT_API_CONNECT_OPTIONS,
  shortuuid,
  tts,
} from "@livekit/agents";
import { SarvamAIClient } from "sarvamai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SARVAM_TTS_SAMPLE_RATE = 24000;
const SARVAM_TTS_NUM_CHANNELS = 1;

export interface SarvamTTSOptions {
  apiKey: string;
  /** BCP-47 language code, e.g. "hi-IN", "en-IN". Default "hi-IN". */
  targetLanguageCode?: string;
  /** Speaker name for bulbul. Default "Neha". */
  speaker?: string;
}

/**
 * Sarvam TTS using bulbul (REST convert). Output 24kHz mono.
 */
export class SarvamTTS extends tts.TTS {
  private apiKey: string;
  private targetLanguageCode: string;
  private speaker: string;
  private client: SarvamAIClient;

  constructor(opts: SarvamTTSOptions) {
    super(SARVAM_TTS_SAMPLE_RATE, SARVAM_TTS_NUM_CHANNELS, { streaming: true });
    this.apiKey = opts.apiKey;
    this.targetLanguageCode = opts.targetLanguageCode ?? "hi-IN";
    this.speaker = (opts.speaker ?? "neha").toLowerCase();
    this.client = new SarvamAIClient({
      apiSubscriptionKey: opts.apiKey,
    });
  }

  override get label(): string {
    return "sarvam-tts";
  }

  override stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    const connOptions = options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
    return new SarvamSynthesizeStream(this, connOptions);
  }

  override synthesize(
    text: string,
    connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal?: AbortSignal
  ): tts.ChunkedStream {
    return new SarvamChunkedStream(text, this, connOptions, abortSignal);
  }

  async convertToAudio(text: string, abortSignal?: AbortSignal): Promise<AudioFrame[]> {
    if (!text.trim()) return [];

    const body = await this.client.textToSpeech.convert(
      {
        text: text.trim(),
        target_language_code: this.targetLanguageCode as "hi-IN",
        speaker: this.speaker as "neha",
        speech_sample_rate: SARVAM_TTS_SAMPLE_RATE,
      },
      { abortSignal }
    );
    if (!body?.audios?.length) return [];

    const base64Wav = body.audios[0];
    const tmpDir = os.tmpdir();
    const tmpPath = path.join(tmpDir, `sarvam-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

    try {
      const buf = Buffer.from(base64Wav, "base64");
      await fs.writeFile(tmpPath, buf);

      const frames: AudioFrame[] = [];
      const stream = audioFramesFromFile(tmpPath, {
        sampleRate: SARVAM_TTS_SAMPLE_RATE,
        numChannels: SARVAM_TTS_NUM_CHANNELS,
        abortSignal,
      });
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) frames.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return frames;
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}

class SarvamSynthesizeStream extends tts.SynthesizeStream {
  #tts: SarvamTTS;

  constructor(ttsImpl: SarvamTTS, connOptions: APIConnectOptions) {
    super(ttsImpl, connOptions);
    this.#tts = ttsImpl;
  }

  override get label(): string {
    return "sarvam-tts-stream";
  }

  protected override async run(): Promise<void> {
    let text = "";
    const requestId = shortuuid("tts_request_");
    const segmentId = shortuuid("tts_seg_");

    for await (const data of this.input) {
      if (this.abortController.signal.aborted) break;
      if (data === tts.SynthesizeStream.FLUSH_SENTINEL) {
        if (text.trim()) {
          const frames = await this.#tts.convertToAudio(text, this.abortController.signal);
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            const final = i === frames.length - 1;
            this.queue.put({
              requestId,
              segmentId,
              frame,
              final,
            });
          }
        }
        text = "";
        continue;
      }
      text += data as string;
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
  }
}

class SarvamChunkedStream extends tts.ChunkedStream {
  #tts: SarvamTTS;

  constructor(
    text: string,
    ttsImpl: SarvamTTS,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal
  ) {
    super(text, ttsImpl, connOptions, abortSignal);
    this.#tts = ttsImpl;
  }

  override get label(): string {
    return "sarvam-tts-chunked";
  }

  protected override async run(): Promise<void> {
    const text = this.inputText;
    if (!text.trim()) return;

    const requestId = shortuuid("tts_request_");
    const segmentId = shortuuid("tts_seg_");
    const frames = await this.#tts.convertToAudio(text, this.abortController.signal);

    for (let i = 0; i < frames.length; i++) {
      if (this.abortController.signal.aborted) break;
      const frame = frames[i];
      this.queue.put({
        requestId,
        segmentId,
        frame,
        final: i === frames.length - 1,
      });
    }
  }
}
