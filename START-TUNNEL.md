# Quick start: Cloudflare Tunnel

Expose your local Express API (listening on `PORT`, default **3000**) to the internet.

## Commands

### Option 1: npm

```bash
npm run tunnel:quick
```

### Option 2: Direct

```bash
cloudflared tunnel --url http://localhost:3000
```

(Use another port if `PORT` in `.env` is not 3000.)

### Option 3: Script

```bash
bash scripts/quick-tunnel.sh
```

`PORT` is read from the environment for the script (defaults to 3000).

## Custom port

```bash
PORT=4000 npm run tunnel:quick
```

## Notes

- Keep the tunnel process and `npm start` running while testing.
- Quick tunnel URLs change each time you restart cloudflared.
- If you use a persistent `~/.cloudflared/config.yml`, set `service: http://localhost:<PORT>` to match your API.
