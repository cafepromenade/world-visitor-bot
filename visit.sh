#!/bin/bash
echo "Starting Overworld Visitor (all regions)..."
echo "This runs the Minecraft server + bot together."
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")"
docker compose up --abort-on-container-exit mc visitor
echo "Done. Server stopped."
