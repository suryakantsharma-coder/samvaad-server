# 🚀 Quick Start: Cloudflare Tunnel for Exotel

## Simple Commands

### Option 1: Using npm (Recommended)
```bash
npm run tunnel:quick
```

### Option 2: Direct Command
```bash
cloudflared tunnel --url http://localhost:5002
```

**Important:** Use `http://` not `ws://` - Cloudflare automatically handles WebSocket upgrades!

### Option 3: Using the Script Directly
```bash
bash scripts/quick-tunnel.sh
```

## What You'll See

When you run the command, you'll see:

```
🚀 Starting Quick Cloudflare Tunnel

Configuration:
  Local Port: 5002
  Protocol: HTTP (WebSocket upgrades automatically)
  Local URL: http://localhost:5002

Starting tunnel...
The public URL will be displayed below.

+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                         |
|  https://abc123-def456.trycloudflare.com                                                   |
+--------------------------------------------------------------------------------------------+
```

## For Exotel Configuration

1. **Copy the URL** shown (e.g., `https://abc123-def456.trycloudflare.com`)

2. **Convert to WebSocket:**
   - Change `https://` to `wss://`
   - Example: `wss://abc123-def456.trycloudflare.com`

3. **Add hospital endpoint:**
   - Get hospital ID from server startup logs
   - Add `/media/<hospital-id>` to the URL
   - Final: `wss://abc123-def456.trycloudflare.com/media/507f1f77bcf86cd799439011`

4. **Use in Exotel:**
   - Go to Exotel voice app settings
   - Paste the WebSocket URL
   - Save

## Important Notes

- ✅ Keep the tunnel running (don't close the terminal)
- ✅ Keep your server running (`npm run dev`)
- ✅ The URL changes each time you restart the tunnel
- ✅ Get hospital IDs from: `http://localhost:5002/hospitals`

## Troubleshooting

**If command not found:**
```bash
# Install cloudflared first
brew install cloudflared
```

**If port 5002 is not available:**
```bash
# Set custom port
AGENT_PORT=5003 npm run tunnel:quick
```
