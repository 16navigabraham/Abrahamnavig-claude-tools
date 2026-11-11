#!/usr/bin/env bash
# Rebuild and restart the running server from the code checked out here, then wait
# until it answers its health check. Run from the repo root on the VM:
#   bash deploy/update.sh
# The Deploy GitHub Actions workflow runs this after checking out the pushed commit.
# .env, the workspace volume and Caddy's certificates are left untouched.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env here. Run deploy/setup-oracle.sh once first." >&2
  exit 1
fi

# setup-oracle.sh adds the user to the docker group, but that only applies after a
# fresh login; fall back to sudo until then.
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi

echo "Deploying $(git rev-parse --short HEAD)"
"${DOCKER[@]}" compose up -d --build --remove-orphans

# Drop the image layers the rebuild replaced, so the small VM disk doesn't fill up.
"${DOCKER[@]}" image prune -f >/dev/null

set -a
# shellcheck source=/dev/null
. ./.env
set +a
# Wait for the app container's own HEALTHCHECK, then check the full path through Caddy and
# HTTPS. --resolve sends that request to this machine, since a VM can't always reach its
# own public IP from inside the cloud network.
app="$("${DOCKER[@]}" compose ps -q app)"
status=unknown
for _ in $(seq 1 30); do
  status="$("${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' "$app" 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ] &&
     curl -fsS --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo "Healthy: https://$DOMAIN/health"
    exit 0
  fi
  sleep 5
done

echo "Not healthy after 150s (app container: $status). Recent logs:" >&2
"${DOCKER[@]}" compose logs --tail 50 app caddy >&2
exit 1
