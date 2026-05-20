#!/bin/bash
set -e
cd "$(dirname "$0")"

BOT_COUNT="${1:-1}"
if [ "$BOT_COUNT" -gt 4 ]; then BOT_COUNT=4; fi

echo "=========================================="
echo "  World Visitor + Integrated BlueMap"
echo "  Bots: ${BOT_COUNT}"
echo "=========================================="
echo ""

[ -f .env ] && source .env
export BOT_COUNT MC_USERNAME WORLD_PATH FLY_Y GRID_STEP RENDER_DISTANCE WP_DELAY CHUNK_LOAD_TIMEOUT FOLLOW_PLAYER BLUEMAP_HOST BLUEMAP_PORT BLUEMAP_MAP

echo "[1/3] Starting Minecraft server + ${BOT_COUNT} bot(s) + BlueMap plugin..."
echo "       BlueMap web UI: http://localhost:8100"
echo ""
docker compose stop bluemap 2>/dev/null || true
docker compose rm -sf bluemap 2>/dev/null || true

case "$BOT_COUNT" in
  1) SERVICES="mc visitor" ;;
  2) SERVICES="mc visitor visitor1" ; PROFILE="--profile multi" ;;
  3) SERVICES="mc visitor visitor1 visitor2" ; PROFILE="--profile multi" ;;
  4) SERVICES="mc visitor visitor1 visitor2 visitor3" ; PROFILE="--profile multi" ;;
esac

docker compose $PROFILE up --abort-on-container-exit $SERVICES

echo ""
echo "[2/3] Bot finished. MC server stopped. Running BlueMap CLI final render..."
docker compose stop mc visitor visitor1 visitor2 visitor3 2>/dev/null || true
if docker compose ps mc --format '{{.Status}}' 2>/dev/null | grep -q 'Up'; then
  echo "Refusing to start CLI BlueMap because Minecraft is still running."
  exit 1
fi
docker compose -f compose.bluemap-cli.yml up --abort-on-container-exit bluemap

echo ""
echo "[3/3] BlueMap CLI render complete."
chown -R 1000:1000 web/ data/ 2>/dev/null || true
echo "Done. Open the rendered map from the control panel's Open BlueMap button."
