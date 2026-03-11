import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { BackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NehaAgent } from "./agent.js";
import { SarvamLLM } from "./sarvam-llm.js";
import { SarvamSTT } from "./sarvam-stt.js";
import { SarvamTTS } from "./sarvam-tts.js";

// Load .env from agent-node, backend, and project root (must run before reading env)
import { config } from "dotenv";
config({ path: path.join(process.cwd(), ".env") });
config({ path: path.join(process.cwd(), "..", "backend", ".env") });
config({ path: path.join(process.cwd(), "..", "..", ".env") });

const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";
const ENABLE_NOISE_CANCELLATION = process.env.ENABLE_NOISE_CANCELLATION === "true";
const ENABLE_SILERO_VAD = process.env.ENABLE_SILERO_VAD === "true";

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    if (!ENABLE_SILERO_VAD) return;
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    console.log("[AgentNode] User connected to room:", ctx.room.name);

    const vad = ENABLE_SILERO_VAD ? (ctx.proc.userData.vad as silero.VAD) : undefined;

    const session = new voice.AgentSession({
      vad,
      turnDetection: "stt",
      voiceOptions: {
        preemptiveGeneration: true,
        // Reduce mid-speech cutoff: don’t treat brief noise/silence as user turn; let agent finish
        allowInterruptions: false,
        minEndpointingDelay: 800,
        maxEndpointingDelay: 6000,
        minInterruptionDuration: 600,
      },

      llm: new SarvamLLM({ apiKey: SARVAM_API_KEY, model: "sarvam-m" }),

      stt: new SarvamSTT({ apiKey: SARVAM_API_KEY, languageCode: "hi-IN" }),
      tts: new SarvamTTS({ apiKey: SARVAM_API_KEY, targetLanguageCode: "hi-IN", speaker: "Neha" }),
    });

    await session.start({
      agent: new NehaAgent(),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: ENABLE_NOISE_CANCELLATION ? BackgroundVoiceCancellation() : undefined,
      },
    });

    await ctx.connect();

    session.generateReply({
      instructions:
        "Greet the user in Hindi or Gujarati. Say you are Neha from HealthFirst Hospital and ask how you can help with appointment booking.",
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "neha-agent",
  })
);
