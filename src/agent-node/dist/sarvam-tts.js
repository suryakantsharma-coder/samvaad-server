import { audioFramesFromFile, DEFAULT_API_CONNECT_OPTIONS, shortuuid, tts, } from "@livekit/agents";
import { SarvamAIClient } from "sarvamai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const SARVAM_TTS_SAMPLE_RATE = 24000;
const SARVAM_TTS_NUM_CHANNELS = 1;
/**
 * Sarvam TTS using bulbul (REST convert). Output 24kHz mono.
 */
export class SarvamTTS extends tts.TTS {
    apiKey;
    targetLanguageCode;
    speaker;
    client;
    constructor(opts) {
        super(SARVAM_TTS_SAMPLE_RATE, SARVAM_TTS_NUM_CHANNELS, { streaming: true });
        this.apiKey = opts.apiKey;
        this.targetLanguageCode = opts.targetLanguageCode ?? "hi-IN";
        this.speaker = (opts.speaker ?? "neha").toLowerCase();
        this.client = new SarvamAIClient({
            apiSubscriptionKey: opts.apiKey,
        });
    }
    get label() {
        return "sarvam-tts";
    }
    stream(options) {
        const connOptions = options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS;
        return new SarvamSynthesizeStream(this, connOptions);
    }
    synthesize(text, connOptions = DEFAULT_API_CONNECT_OPTIONS, abortSignal) {
        return new SarvamChunkedStream(text, this, connOptions, abortSignal);
    }
    async convertToAudio(text, abortSignal) {
        if (!text.trim())
            return [];
        const body = await this.client.textToSpeech.convert({
            text: text.trim(),
            target_language_code: this.targetLanguageCode,
            speaker: this.speaker,
            speech_sample_rate: SARVAM_TTS_SAMPLE_RATE,
        }, { abortSignal });
        if (!body?.audios?.length)
            return [];
        const base64Wav = body.audios[0];
        const tmpDir = os.tmpdir();
        const tmpPath = path.join(tmpDir, `sarvam-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
        try {
            const buf = Buffer.from(base64Wav, "base64");
            await fs.writeFile(tmpPath, buf);
            const frames = [];
            const stream = audioFramesFromFile(tmpPath, {
                sampleRate: SARVAM_TTS_SAMPLE_RATE,
                numChannels: SARVAM_TTS_NUM_CHANNELS,
                abortSignal,
            });
            const reader = stream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value)
                        frames.push(value);
                }
            }
            finally {
                reader.releaseLock();
            }
            return frames;
        }
        finally {
            await fs.unlink(tmpPath).catch(() => { });
        }
    }
}
class SarvamSynthesizeStream extends tts.SynthesizeStream {
    #tts;
    constructor(ttsImpl, connOptions) {
        super(ttsImpl, connOptions);
        this.#tts = ttsImpl;
    }
    get label() {
        return "sarvam-tts-stream";
    }
    async run() {
        let text = "";
        const requestId = shortuuid("tts_request_");
        const segmentId = shortuuid("tts_seg_");
        for await (const data of this.input) {
            if (this.abortController.signal.aborted)
                break;
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
            text += data;
        }
        this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    }
}
class SarvamChunkedStream extends tts.ChunkedStream {
    #tts;
    constructor(text, ttsImpl, connOptions, abortSignal) {
        super(text, ttsImpl, connOptions, abortSignal);
        this.#tts = ttsImpl;
    }
    get label() {
        return "sarvam-tts-chunked";
    }
    async run() {
        const text = this.inputText;
        if (!text.trim())
            return;
        const requestId = shortuuid("tts_request_");
        const segmentId = shortuuid("tts_seg_");
        const frames = await this.#tts.convertToAudio(text, this.abortController.signal);
        for (let i = 0; i < frames.length; i++) {
            if (this.abortController.signal.aborted)
                break;
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
