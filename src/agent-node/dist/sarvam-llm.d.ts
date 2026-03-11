import { llm, type APIConnectOptions } from "@livekit/agents";
export interface SarvamLLMOptions {
    apiKey: string;
    model?: string;
}
/**
 * Sarvam LLM using api-subscription-key header.
 * Use this so the Node agent works with Sarvam chat without Python.
 */
export declare class SarvamLLM extends llm.LLM {
    readonly apiKey: string;
    private modelName;
    constructor(opts: SarvamLLMOptions);
    get model(): string;
    label(): string;
    chat({ chatCtx, toolCtx, connOptions, }: {
        chatCtx: llm.ChatContext;
        toolCtx?: llm.ToolContext;
        connOptions?: APIConnectOptions;
        parallelToolCalls?: boolean;
        toolChoice?: llm.ToolChoice;
        extraKwargs?: Record<string, unknown>;
    }): llm.LLMStream;
}
//# sourceMappingURL=sarvam-llm.d.ts.map