#!/bin/bash
set -e
echo "========================================"
echo "  Overworld Visitor - Setup and Run"
echo "========================================"

cd "$(dirname "$0")"

# Check .NET
if ! command -v dotnet &>/dev/null; then
    echo "Installing .NET SDK..."
    curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel 10.0
    export PATH="$HOME/.dotnet:$PATH"
fi
echo "[OK] .NET SDK $(dotnet --version)"

# Check Docker
if ! command -v docker &>/dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
fi
echo "[OK] $(docker --version)"

# Build GUI
echo "Building GUI..."
dotnet build gui/OverworldVisitor.csproj -c Release --nologo -v q

# Build bot
echo "Building bot Docker image..."
docker compose build visitor

# Run GUI
echo "Launching Overworld Visitor GUI..."
dotnet run --project gui/OverworldVisitor.csproj -c Release &
echo "GUI launched."
