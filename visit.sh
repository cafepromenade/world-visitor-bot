#!/bin/bash
echo "Starting Overworld Visitor (all regions) + BlueMap..."
echo "This runs the Minecraft server + bot + BlueMap together."
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")"
docker compose up --abort-on-container-exit mc visitor bluemap
echo "Done. Server stopped."
