import { voice } from "@livekit/agents";
import { NEHA_INSTRUCTIONS } from "./instructions.js";
export class NehaAgent extends voice.Agent {
    constructor() {
        super({
            instructions: NEHA_INSTRUCTIONS,
        });
    }
}
