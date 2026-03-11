import { llm, DEFAULT_API_CONNECT_OPTIONS, } from "@livekit/agents";
const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
/**
 * Sarvam LLM using api-subscription-key header.
 * Use this so the Node agent works with Sarvam chat without Python.
 */
export class SarvamLLM extends llm.LLM {
    apiKey;
    modelName;
    constructor(opts) {
        super();
        this.apiKey = opts.apiKey;
        this.modelName = opts.model ?? "sarvam-m";
    }
    get model() {
        return this.modelName;
    }
    label() {
        return "sarvam";
    }
    chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS, }) {
        return new SarvamLLMStream(this, { chatCtx, toolCtx, connOptions });
    }
}
class SarvamLLMStream extends llm.LLMStream {
    sarvam;
    constructor(sarvam, opts) {
        super(sarvam, opts);
        this.sarvam = sarvam;
    }
    async run() {
        const messages = (await this.chatCtx.toProviderFormat("openai"));
        if (!this.sarvam.apiKey) {
            throw new Error("Sarvam API key not set");
        }
        const res = await fetch(SARVAM_CHAT_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "api-subscription-key": this.sarvam.apiKey,
            },
            body: JSON.stringify({
                model: this.sarvam.model,
                messages,
                max_tokens: 256,
            }),
            signal: this.abortController.signal,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Sarvam API error ${res.status}: ${text}`);
        }
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content ?? "";
        const id = data.id ?? `sarvam-${Date.now()}`;
        const delta = { role: "assistant", content };
        this.queue.put({ id, delta });
        if (data.usage) {
            const usage = {
                completionTokens: data.usage.completion_tokens ?? 0,
                promptTokens: data.usage.prompt_tokens ?? 0,
                promptCachedTokens: 0,
                totalTokens: data.usage.total_tokens ?? 0,
            };
            this.queue.put({ id, usage });
        }
        this.queue.close();
    }
}
