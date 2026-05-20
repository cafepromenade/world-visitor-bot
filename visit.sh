#!/bin/bash
echo "Starting Overworld Visitor (all regions) + integrated BlueMap..."
echo "This runs the Minecraft server + bot. BlueMap runs inside Minecraft while online."
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")"
docker compose stop bluemap 2>/dev/null || true
docker compose rm -sf bluemap 2>/dev/null || true
docker compose up --abort-on-container-exit mc visitor
echo "Done. Server stopped."
