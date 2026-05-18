#!/bin/bash

set -e

REPO_DIR="/home/docker/overworld-map"
DEST1="/home/docker/world-visitor-bot/world/region"
DEST2="/home/docker/world-visitor-bot/mc-data/world/dimensions/minecraft/overworld/region"

echo "=== Syncing changed region files from git pull ==="

cd "$REPO_DIR"

# Record current HEAD before pull
OLD_HEAD=$(git rev-parse HEAD)

# Run git pull
echo "Running git pull..."
git pull

# Get new HEAD after pull
NEW_HEAD=$(git rev-parse HEAD)

# If nothing changed, exit
if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
    echo "No changes detected. Nothing to copy."
    exit 0
fi

# Get list of changed/added files in the region folder
CHANGED_FILES=$(git diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- "world/region/")

if [ -z "$CHANGED_FILES" ]; then
    echo "No region files changed."
    exit 0
fi

echo "Changed region files:"
echo "$CHANGED_FILES"
echo ""

# Copy each changed file to both destinations
COUNT=0
while IFS= read -r file; do
    # Get just the filename (e.g., r.-1.-1.mca)
    filename=$(basename "$file")
    
    # Copy to destination 1
    if [ -f "$REPO_DIR/$file" ]; then
        mkdir -p "$DEST1"
        cp "$REPO_DIR/$file" "$DEST1/$filename"
        echo "Copied to $DEST1/$filename"
        COUNT=$((COUNT + 1))
    fi
    
    # Copy to destination 2
    if [ -f "$REPO_DIR/$file" ]; then
        mkdir -p "$DEST2"
        cp "$REPO_DIR/$file" "$DEST2/$filename"
        echo "Copied to $DEST2/$filename"
    fi
done <<< "$CHANGED_FILES"

echo ""
echo "=== Done: $COUNT region file(s) synced ==="
