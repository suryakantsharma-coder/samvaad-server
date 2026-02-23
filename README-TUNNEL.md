# Quick Start: Cloudflare Tunnel for Exotel

## 🚀 Fastest Way (Quick Tunnel)

1. **Start your server:**
   ```bash
   npm run dev
   ```

2. **In a new terminal, start the quick tunnel:**
   ```bash
   npm run tunnel:quick
   ```

3. **Copy the URL shown** (e.g., `https://abc123.trycloudflare.com`)

4. **Convert to WebSocket format:**
   - Change `https://` to `wss://`
   - Example: `wss://abc123.trycloudflare.com`

5. **Use in Exotel:**
   - Go to your Exotel voice app settings
   - Set WebSocket URL to: `wss://abc123.trycloudflare.com/media/<hospital-id>`
   - Replace `<hospital-id>` with the MongoDB ID from server startup logs

## 📋 Example

When you run `npm run tunnel:quick`, you'll see:

```
🚀 Starting Quick Cloudflare Tunnel

Configuration:
  Local Port: 5002
  Protocol: WebSocket (ws://localhost:5002)

Starting tunnel...
The public URL will be displayed below. Use it in Exotel configuration.

Press Ctrl+C to stop

+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
|  https://abc123-def456.trycloudflare.com                                                   |
+--------------------------------------------------------------------------------------------+
```

**For Exotel, use:**
```
wss://abc123-def456.trycloudflare.com/media/<hospital-id>
```

## 🔧 Other Commands

- `npm run tunnel` - Start permanent tunnel (requires domain setup)
- `npm run tunnel:bash` - Use bash script version
- `npm run tunnel:quick` - Quick tunnel (no setup needed)

## ⚠️ Important Notes

1. **Quick tunnels are temporary** - URL changes each time you restart
2. **Keep both terminals running** - Server and tunnel must both be active
3. **Hospital ID** - Get from server startup logs or `/hospitals` API endpoint

## 🏥 Finding Hospital IDs

When server starts, you'll see:
```
📱 Exotel Configuration Endpoints:
   1. Hospital A:
      Hospital ID: 507f1f77bcf86cd799439011
```

Or check API:
```bash
curl http://localhost:5002/hospitals
```
