# Exotel Configuration Guide

## ✅ Yes, You Need Hospital ID in the URL

Each hospital has its own WebSocket endpoint. The hospital ID is **required** in the URL path.

## URL Format

```
wss://<cloudflare-url>/media/<hospital-id>
```

## Step-by-Step Configuration

### 1. Get Your Cloudflare Tunnel URL

Run the tunnel:
```bash
npm run tunnel:quick
```

You'll see:
```
https://causing-tramadol-fails-requirement.trycloudflare.com
```

### 2. Get Hospital IDs

**Option A: From Server Startup Logs**

When you start the server (`npm run dev`), you'll see:
```
📱 Exotel Configuration Endpoints:
   Configure these WebSocket URLs in your Exotel voice app:

   1. Hospital A:
      WebSocket URL: wss://agent.your-domain.com/media/507f1f77bcf86cd799439011
      Hospital ID: 507f1f77bcf86cd799439011

   2. Hospital B:
      WebSocket URL: wss://agent.your-domain.com/media/507f1f77bcf86cd799439012
      Hospital ID: 507f1f77bcf86cd799439012
```

**Option B: From API**

```bash
curl http://localhost:5002/hospitals
```

Response:
```json
{
  "success": true,
  "data": {
    "hospitals": [
      {
        "id": "507f1f77bcf86cd799439011",
        "name": "Hospital A",
        "exotelUrl": "wss://causing-tramadol.trycloudflare.com/media/507f1f77bcf86cd799439011"
      }
    ]
  }
}
```

### 3. Build the Complete URL

**Format:**
```
wss://<cloudflare-domain>/media/<hospital-id>
```

**Example:**
- Cloudflare URL: `causing-tramadol-fails-requirement.trycloudflare.com`
- Hospital ID: `507f1f77bcf86cd799439011`
- **Final URL:** `wss://causing-tramadol-fails-requirement.trycloudflare.com/media/507f1f77bcf86cd799439011`

### 4. Configure in Exotel

1. Go to your Exotel dashboard
2. Navigate to Voice App settings
3. Find "WebSocket URL" or "Media Stream URL"
4. Paste the complete URL: `wss://causing-tramadol-fails-requirement.trycloudflare.com/media/507f1f77bcf86cd799439011`
5. Save

## Multiple Hospitals = Multiple Exotel Apps

If you have multiple hospitals, you need:

1. **One Exotel voice app per hospital**
2. **Each app uses its own hospital-specific URL**

Example:
- **Exotel App 1 (Hospital A):** `wss://domain.trycloudflare.com/media/507f1f77bcf86cd799439011`
- **Exotel App 2 (Hospital B):** `wss://domain.trycloudflare.com/media/507f1f77bcf86cd799439012`

## Why Hospital ID is Required

The hospital ID in the URL:
- ✅ Routes the call to the correct hospital
- ✅ Loads the correct hospital's doctors and information
- ✅ Ensures appointments are created for the right hospital
- ✅ Provides hospital-specific AI instructions

## Quick Reference

```
Complete URL = wss:// + Cloudflare Domain + /media/ + Hospital MongoDB ID

Example:
wss://causing-tramadol.trycloudflare.com/media/507f1f77bcf86cd799439011
     └─────────┬─────────┘ └───┬───┘ └──────┬──────┘
        Cloudflare URL      Path    Hospital ID
```

## Troubleshooting

**If Exotel can't connect:**
1. ✅ Verify the tunnel is running (`npm run tunnel:quick`)
2. ✅ Verify the server is running (`npm run dev`)
3. ✅ Check the hospital ID is correct (from `/hospitals` API)
4. ✅ Ensure URL uses `wss://` not `ws://`
5. ✅ Ensure `/media/<hospital-id>` is included in the path

**Test the endpoint:**
```bash
# Replace with your actual hospital ID
curl http://localhost:5002/hospitals
```
