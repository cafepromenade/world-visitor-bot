#!/bin/bash
set -e
echo "========================================"
echo "  Git Push in 1500MB Batches"
echo "========================================"

BATCH_DIR="world-batches"
MAX_SIZE=$((1500 * 1024 * 1024))  # 1500MB in bytes
cd "$(dirname "$0")"

rm -rf "$BATCH_DIR"
mkdir -p "$BATCH_DIR"

# Group .mca files into 1500MB batches
batch=0
size=0
mkdir -p "$BATCH_DIR/batch-$batch"

for f in world/region/*.mca; do
    fsize=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)
    size=$((size + fsize))
    if [ $size -ge $MAX_SIZE ]; then
        batch=$((batch + 1))
        size=$fsize
        mkdir -p "$BATCH_DIR/batch-$batch"
    fi
    cp "$f" "$BATCH_DIR/batch-$batch/"
done

echo "Created $((batch + 1)) batches"

fail=0
for b in $(seq 0 $batch); do
    echo "--- Pushing batch $b/$batch ---"
    
    if ls "$BATCH_DIR/batch-$b"/*.mca &>/dev/null; then
        cp "$BATCH_DIR/batch-$b"/*.mca world/region/
        git add world/region/*.mca state/
        git commit -m "chore: world region batch $b/$batch" || true
        git push || { echo "[FAIL] Batch $b push failed"; fail=$((fail + 1)); }
    fi
done

rm -rf "$BATCH_DIR"

if [ $fail -eq 0 ]; then
    echo "All batches pushed successfully!"
else
    echo "$fail batches failed."
fi
