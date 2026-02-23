#!/bin/bash

# Cloudflare Tunnel Script for Exotel WebSocket Connections
# This script starts a Cloudflare tunnel to expose local WebSocket endpoints

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🌐 Starting Cloudflare Tunnel for Exotel WebSocket Connections${NC}\n"

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}❌ cloudflared is not installed${NC}"
    echo -e "${YELLOW}Install it with:${NC}"
    echo "  macOS: brew install cloudflared"
    echo "  Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/"
    echo "  Windows: Download from https://github.com/cloudflare/cloudflared/releases"
    exit 1
fi

# Check if tunnel is already authenticated
if [ ! -f ~/.cloudflared/cert.pem ]; then
    echo -e "${YELLOW}⚠️  Cloudflare tunnel not authenticated${NC}"
    echo -e "${YELLOW}Running authentication...${NC}"
    cloudflared tunnel login
fi

# Get agent port from env or use default
AGENT_PORT=${AGENT_PORT:-5002}
TUNNEL_NAME=${TUNNEL_NAME:-samvaad-agent}

echo -e "${GREEN}Configuration:${NC}"
echo "  Tunnel Name: $TUNNEL_NAME"
echo "  Local Port: $AGENT_PORT"
echo "  Protocol: HTTP (WebSocket upgrades automatically)"
echo "  Local URL: http://localhost:$AGENT_PORT"
echo ""

# Check if tunnel exists, if not create it
if ! cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    echo -e "${YELLOW}Creating tunnel: $TUNNEL_NAME${NC}"
    cloudflared tunnel create "$TUNNEL_NAME"
fi

# Create config file if it doesn't exist
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${YELLOW}Creating Cloudflare config file...${NC}"
    mkdir -p "$CONFIG_DIR"
    
    cat > "$CONFIG_FILE" << EOF
tunnel: $TUNNEL_NAME
credentials-file: $CONFIG_DIR/$TUNNEL_NAME.json

ingress:
  # All traffic (HTTP and WebSocket upgrades)
  - hostname: agent.your-domain.com
    service: http://localhost:$AGENT_PORT
  # Catch-all
  - service: http_status:404
EOF
    
    echo -e "${GREEN}✓ Config file created at: $CONFIG_FILE${NC}"
    echo -e "${YELLOW}⚠️  Please update 'agent.your-domain.com' with your actual domain${NC}"
    echo -e "${YELLOW}   Then run: cloudflared tunnel route dns $TUNNEL_NAME agent.your-domain.com${NC}"
    echo ""
fi

# Start the tunnel
echo -e "${GREEN}🚀 Starting Cloudflare tunnel...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}\n"

cloudflared tunnel run "$TUNNEL_NAME"
