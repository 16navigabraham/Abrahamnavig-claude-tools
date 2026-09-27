#!/usr/bin/env bash
# One-time setup on an Oracle Cloud Ubuntu VM (x86 or Ampere ARM).
# Run from the repo root:  bash deploy/setup-oracle.sh [your-domain]
# Without a domain it uses <public-ip>.sslip.io, which points at your VM with no DNS setup.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Docker
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# 2. Open ports 80/443 in the VM firewall. Oracle's Ubuntu images ship iptables rules
#    that reject everything except SSH, even after you open the ports in the VCN.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # Insert before the catch-all REJECT rule if there is one.
    reject_line="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')"
    sudo iptables -I INPUT "${reject_line:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then
  sudo netfilter-persistent save
fi

# 3. .env
if [ ! -f .env ]; then
  domain="${1:-}"
  if [ -z "$domain" ]; then
    ip="$(curl -fsS https://api.ipify.org)"
    domain="${ip//./-}.sslip.io"
  fi
  cat > .env <<EOF
DOMAIN=$domain
MCP_AUTH_TOKEN=$(openssl rand -hex 32)
FILE_LINK_TTL_SECONDS=86400
EOF
  chmod 600 .env
fi

# 4. Start
sudo docker compose up -d --build

set -a; . ./.env; set +a
echo
echo "Deployed. It can take a minute for the HTTPS certificate to be issued."
echo "  Health:        https://$DOMAIN/health"
echo "  MCP endpoint:  https://$DOMAIN/mcp            (header  Authorization: Bearer <MCP_AUTH_TOKEN>)"
echo "  Claude.ai URL: https://$DOMAIN/mcp/<MCP_AUTH_TOKEN>"
echo "Your token is in .env. Keep it secret."
