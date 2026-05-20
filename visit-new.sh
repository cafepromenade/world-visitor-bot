#!/bin/bash
echo "Starting Overworld Visitor (new regions only) + integrated BlueMap..."
echo "Press Ctrl+C to stop."
cd "$(dirname "$0")"
docker compose -f compose.new.yml up --abort-on-container-exit mc visitor-new
echo "Done. Server stopped."
