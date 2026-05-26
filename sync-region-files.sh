#!/bin/bash

set -e

REPO_DIR="/home/docker/overworld-map"
PROJECT_DIR="/home/docker/world-visitor-bot"
DEST1="/home/docker/world-visitor-bot/world/region"
DEST2="/home/docker/world-visitor-bot/mc-data/world/dimensions/minecraft/overworld/region"
STATE_DIR="$PROJECT_DIR/state"

clear_explored_regions() {
    if [ ! -d "$STATE_DIR" ]; then
        echo "No visitor state directory found at $STATE_DIR; nothing to mark unexplored."
        return
    fi

    CHANGED_FILES="$CHANGED_FILES" node - "$STATE_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');

const stateDir = process.argv[2];
const regionKeys = new Set();

for (const file of String(process.env.CHANGED_FILES || '').split(/\r?\n/)) {
  const match = path.basename(file.trim()).match(/^r\.(-?\d+)\.(-?\d+)\.mca$/);
  if (match) regionKeys.add(`${match[1]},${match[2]}`);
}

if (regionKeys.size === 0) {
  console.log('No synced .mca region keys found to mark unexplored.');
  process.exit(0);
}

let removed = 0;
let touched = 0;

for (const file of fs.readdirSync(stateDir)) {
  if (!/^visited.*\.json$/.test(file)) continue;

  const fullPath = path.join(stateDir, file);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    console.error(`WARN: could not update ${file}: ${err.message}`);
    continue;
  }

  if (!state.visited || typeof state.visited !== 'object') continue;

  let fileRemoved = 0;
  for (const key of regionKeys) {
    if (Object.prototype.hasOwnProperty.call(state.visited, key)) {
      delete state.visited[key];
      fileRemoved++;
    }
  }

  if (fileRemoved > 0) {
    fs.writeFileSync(fullPath, `${JSON.stringify(state, null, 2)}\n`);
    removed += fileRemoved;
    touched++;
    console.log(`Marked ${fileRemoved} synced region(s) unexplored in ${file}`);
  }
}

console.log(`Cleared ${removed} explored entr${removed === 1 ? 'y' : 'ies'} across ${touched} state file(s).`);
NODE
}

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
echo "Marking synced region areas as unexplored..."
clear_explored_regions

echo ""
echo "=== Done: $COUNT region file(s) synced ==="
