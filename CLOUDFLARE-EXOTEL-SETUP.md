# Cloudflare & Exotel Setup Guide

This guide explains how to configure Cloudflare endpoints for Exotel voice app connections.

## Quick Start (No Domain Required)

For quick testing, use the quick tunnel script:

```bash
npm run tunnel:quick
```

This will:
1. Start a temporary Cloudflare tunnel
2. Display a public URL (e.g., `https://random-name.trycloudflare.com`)
3. Convert the URL to WebSocket format: `wss://random-name.trycloudflare.com`
4. Use this URL in Exotel configuration

**Note:** Quick tunnels are temporary and change each time you restart.

## Prerequisites

1. Install `cloudflared` CLI:
   ```bash
   # macOS
   brew install cloudflared
   
   # Linux/Windows
   # Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
   ```

2. A Cloudflare account (for permanent tunnels)
3. Exotel account with voice app access

## Configuration

### 1. Start Cloudflare Tunnel

**Option A: Quick Tunnel (Easiest - No Setup)**

```bash
npm run tunnel:quick
```

Copy the displayed URL and use it in Exotel (convert `https://` to `wss://`).

**Option B: Permanent Tunnel (Production)**

### 2. Set Cloudflare Domain in Environment

Add to your `.env` file:

```bash
CLOUDFLARE_DOMAIN=agent.your-domain.com
# or
CLOUDFLARE_DOMAIN=your-domain.com
```

### 3. Cloudflare Setup Options

#### Option A: Cloudflare Tunnel (Recommended for Production)

1. Install `cloudflared`:
   ```bash
   brew install cloudflared  # macOS
   # or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
   ```

2. Authenticate:
   ```bash
   cloudflared tunnel login
   ```

3. Create a tunnel:
   ```bash
   cloudflared tunnel create samvaad-agent
   ```

4. Configure tunnel (create `config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /path/to/credentials.json

   ingress:
     - hostname: agent.your-domain.com
       service: ws://localhost:5002
     - service: http_status:404
   ```

5. Run tunnel:
   ```bash
   cloudflared tunnel run samvaad-agent
   ```

#### Option B: Cloudflare Workers (WebSocket Support)

Create a Cloudflare Worker that proxies WebSocket connections to your server.

### 3. Get Hospital Endpoints

When the server starts, it will display Exotel-ready endpoints for the first 2 hospitals:

```
📱 Exotel Configuration Endpoints:
   Configure these WebSocket URLs in your Exotel voice app:

   1. Hospital A:
      WebSocket URL: wss://agent.your-domain.com/media/<hospital-id>
      Hospital ID: 507f1f77bcf86cd799439011

   2. Hospital B:
      WebSocket URL: wss://agent.your-domain.com/media/<hospital-id>
      Hospital ID: 507f1f77bcf86cd799439012
```

Or use the API endpoint:

```bash
curl http://localhost:5002/hospitals
```

Response includes `exotelUrl` field with the preferred WebSocket URL for each hospital.

### 4. Configure Exotel

In your Exotel voice app configuration:

1. Go to your Exotel voice app settings
2. Set WebSocket URL to: `wss://agent.your-domain.com/media/<hospital-id>`
3. Replace `<hospital-id>` with the actual MongoDB ObjectId from the startup logs
4. Save configuration

### 5. Test Connection

The agent server logs will show when Exotel connects:

```
[Exotel] WebSocket connected for hospital: Hospital A (507f1f77bcf86cd799439011)
```

## Troubleshooting

### WebSocket Connection Fails

1. Verify Cloudflare domain is set: Check `.env` has `CLOUDFLARE_DOMAIN`
2. Check tunnel/worker is running and proxying correctly
3. Verify hospital ID is correct in Exotel configuration
4. Check Cloudflare logs for connection errors

### No Cloudflare URLs Showing

If startup logs show local URLs only:
- Set `CLOUDFLARE_DOMAIN` in `.env` file
- Restart the server

### Multiple Hospitals

Each hospital gets its own WebSocket endpoint:
- Hospital 1: `wss://agent.your-domain.com/media/<hospital-1-id>`
- Hospital 2: `wss://agent.your-domain.com/media/<hospital-2-id>`

Configure separate Exotel voice apps for each hospital using their respective endpoints.

## API Endpoints

- `GET /hospitals` - List all hospitals with WebSocket URLs
- `GET /health` - Health check
- `WS /media/:hospitalId` - WebSocket endpoint for voice calls
