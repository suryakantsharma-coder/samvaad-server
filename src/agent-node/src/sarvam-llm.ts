import {
  llm,
  DEFAULT_API_CONNECT_OPTIONS,
  type APIConnectOptions,
} from "@livekit/agents";

const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";

export interface SarvamLLMOptions {
  apiKey: string;
  model?: string;
}

/**
 * Sarvam LLM using api-subscription-key header.
 * Use this so the Node agent works with Sarvam chat without Python.
 */
export class SarvamLLM extends llm.LLM {
  readonly apiKey: string;
  private modelName: string;

  constructor(opts: SarvamLLMOptions) {
    super();
    this.apiKey = opts.apiKey;
    this.modelName = opts.model ?? "sarvam-m";
  }

  override get model(): string {
    return this.modelName;
  }

  override label(): string {
    return "sarvam";
  }

  override chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new SarvamLLMStream(this, { chatCtx, toolCtx, connOptions });
  }
}

class SarvamLLMStream extends llm.LLMStream {
  private sarvam: SarvamLLM;

  constructor(
    sarvam: SarvamLLM,
    opts: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
    }
  ) {
    super(sarvam, opts);
    this.sarvam = sarvam;
  }

  protected override async run(): Promise<void> {
    const messages = (await this.chatCtx.toProviderFormat(
      "openai"
    )) as Array<{ role: string; content: string }>;

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

    const data = (await res.json()) as {
      id?: string;
      choices?: Array<{
        message?: { role?: string; content?: string };
      }>;
      usage?: {
        completion_tokens?: number;
        prompt_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const id = data.id ?? `sarvam-${Date.now()}`;

    const delta: llm.ChoiceDelta = { role: "assistant", content };
    this.queue.put({ id, delta } as llm.ChatChunk);

    if (data.usage) {
      const usage: llm.CompletionUsage = {
        completionTokens: data.usage.completion_tokens ?? 0,
        promptTokens: data.usage.prompt_tokens ?? 0,
        promptCachedTokens: 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
      this.queue.put({ id, usage } as llm.ChatChunk);
    }

    this.queue.close();
  }
}
