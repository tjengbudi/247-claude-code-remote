#!/bin/bash
set -euo pipefail

echo "Setting up Cloudflare Tunnel..."

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "cloudflared not found. Installing via Homebrew..."
    brew install cloudflared
fi

# Check if already logged in
if ! cloudflared tunnel list &> /dev/null; then
    echo "Please login to Cloudflare..."
    cloudflared tunnel login
fi

# Prompt for tunnel name
read -p "Enter tunnel name (e.g., mac-mini): " TUNNEL_NAME

# Create tunnel
echo "Creating tunnel '$TUNNEL_NAME'..."
cloudflared tunnel create "$TUNNEL_NAME"

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')

echo "Tunnel ID: $TUNNEL_ID"

# Create config
CONFIG_DIR="$HOME/.cloudflared"
mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_DIR/config.yml" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: 247.quivr.com
    service: http://localhost:4678
  - service: http_status:404
EOF

echo "Config written to $CONFIG_DIR/config.yml"
echo ""

# Prompt for DNS setup
read -p "Set up DNS route to 247.quivr.com? (y/n): " SETUP_DNS
if [ "$SETUP_DNS" = "y" ]; then
    cloudflared tunnel route dns "$TUNNEL_NAME" 247.quivr.com
    echo "DNS route created!"
fi

echo ""
echo "Tunnel setup complete!"
echo ""
echo "To run the tunnel manually:"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "To install as a service (auto-start):"
echo "  sudo cloudflared service install"
echo ""
echo "To test the tunnel:"
echo "  curl https://247.quivr.com/api/info"
