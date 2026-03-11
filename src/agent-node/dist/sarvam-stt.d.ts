import { type APIConnectOptions, stt } from "@livekit/agents";
import { SarvamAIClient } from "sarvamai";
export interface SarvamSTTOptions {
    apiKey: string;
    /** BCP-47 language code, e.g. "hi-IN", "en-IN", or "unknown" for auto-detect. Default "hi-IN". */
    languageCode?: string;
}
/**
 * Sarvam STT using streaming (saarika). Input 16kHz mono PCM.
 */
export declare class SarvamSTT extends stt.STT {
    private apiKey;
    private languageCode;
    private client;
    constructor(opts: SarvamSTTOptions);
    get label(): string;
    stream(options?: {
        connOptions?: APIConnectOptions;
    }): stt.SpeechStream;
    protected _recognize(_frame: import("@livekit/agents").AudioBuffer, _abortSignal?: AbortSignal): Promise<stt.SpeechEvent>;
    createStreamSocket(): Promise<Awaited<ReturnType<SarvamAIClient["speechToTextStreaming"]["connect"]>>>;
    getLanguageCode(): string;
}
//# sourceMappingURL=sarvam-stt.d.ts.map