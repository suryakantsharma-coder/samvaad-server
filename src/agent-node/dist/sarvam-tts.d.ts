import type { AudioFrame } from "@livekit/rtc-node";
import { type APIConnectOptions, tts } from "@livekit/agents";
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
export declare class SarvamTTS extends tts.TTS {
    private apiKey;
    private targetLanguageCode;
    private speaker;
    private client;
    constructor(opts: SarvamTTSOptions);
    get label(): string;
    stream(options?: {
        connOptions?: APIConnectOptions;
    }): tts.SynthesizeStream;
    synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream;
    convertToAudio(text: string, abortSignal?: AbortSignal): Promise<AudioFrame[]>;
}
//# sourceMappingURL=sarvam-tts.d.ts.map