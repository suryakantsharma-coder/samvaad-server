# samvaad-ai-server
# samvaad-server

## Starting the server

One entry point starts everything:

```bash
npm start
```

This starts:

1. **API server** (Express on `PORT`, default 3000)
2. **WebSocket voice agent** (hospital-based media on `AGENT_PORT`, default 5002)
3. **LiveKit agent-node** (Neha voice agent), if built and not disabled

To build the LiveKit agent (required once before it can start):

```bash
npm run build:agent-node
```

To disable the LiveKit agent, set in `.env`:

```
ENABLE_LIVEKIT_AGENT=false
```
