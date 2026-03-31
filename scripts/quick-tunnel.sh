#!/bin/bash

# Quick Cloudflare Tunnel — exposes local Express (PORT, default 3000).

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

API_PORT=${PORT:-3000}

echo -e "${GREEN}🚀 Starting Quick Cloudflare Tunnel${NC}\n"
echo -e "${YELLOW}This creates a temporary public URL for your local server${NC}\n"

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}❌ cloudflared is not installed${NC}"
    echo -e "${YELLOW}Install it with:${NC}"
    echo "  macOS: brew install cloudflared"
    echo "  Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/"
    exit 1
fi

echo "Configuration:"
echo "  Local Port: $API_PORT"
echo "  Protocol: HTTP"
echo "  Local URL: http://localhost:$API_PORT"
echo ""
echo -e "${GREEN}Starting tunnel...${NC}"
echo -e "${YELLOW}The public URL will be displayed below.${NC}"
echo -e "${YELLOW}Use the printed https:// URL to reach your local API.${NC}\n"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}\n"

# Start quick tunnel - use HTTP, Cloudflare handles WebSocket upgrade
cloudflared tunnel --url http://localhost:$API_PORT
